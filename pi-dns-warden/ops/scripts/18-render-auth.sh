#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
AUTHELIA_DIR="$ROOT_DIR/monitoring/authelia"
CADDY_DIR="$ROOT_DIR/monitoring/caddy"
CADDY_TLS_DIR="$CADDY_DIR/tls"
AUTHELIA_ASSETS_DIR="$AUTHELIA_DIR/assets"
AUTHELIA_LOCALES_DIR="$AUTHELIA_ASSETS_DIR/locales/en"
AUTHELIA_LOGO_FILE="$AUTHELIA_ASSETS_DIR/logo.png"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing .env file at $ENV_FILE"
  exit 1
fi

# shellcheck disable=SC1091
source "$ROOT_DIR/ops/lib/load-env.sh"
load_env_file "$ENV_FILE"
# shellcheck disable=SC1091
source "$ROOT_DIR/ops/lib/torhole-hostnames.sh"

REVERSE_PROXY_IMAGE="${REVERSE_PROXY_IMAGE:-caddy:latest}"

need() {
  local var_name="$1"
  if [[ -z "${!var_name:-}" ]]; then
    echo "Missing required .env value: $var_name"
    exit 1
  fi
}

update_env_value() {
  local var_name="$1"
  local value="$2"
  local escaped_value
  escaped_value="$(printf '%s' "$value" | sed 's/[\/&]/\\&/g')"

  if grep -q "^${var_name}=" "$ENV_FILE"; then
    sed -i.bak "s/^${var_name}=.*/${var_name}=${escaped_value}/" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$var_name" "$value" >> "$ENV_FILE"
  fi
}

random_secret() {
  openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-64
}

ensure_secret() {
  local var_name="$1"
  if [[ -z "${!var_name:-}" ]]; then
    local generated
    generated="$(random_secret)"
    update_env_value "$var_name" "$generated"
    export "${var_name}=$generated"
    echo "Generated ${var_name} and saved it to .env"
  fi
}

yaml_quote() {
  local value="${1//\'/\'\'}"
  printf "'%s'" "$value"
}

need REVERSE_PROXY_DOMAIN
need TORHOLE_ADMIN_USER
need TORHOLE_ADMIN_PASSWORD
ensure_secret AUTHELIA_SESSION_SECRET
ensure_secret AUTHELIA_STORAGE_ENCRYPTION_KEY
ensure_secret BACKUP_MANAGER_API_TOKEN
protected_hosts_regex="$(torhole_protected_hosts_regex)"

TORHOLE_WEB_MODE="${TORHOLE_WEB_MODE:-https-local}"
case "$TORHOLE_WEB_MODE" in
  http)
    TORHOLE_WEB_SCHEME="http"
    ;;
  https-local|https-custom)
    TORHOLE_WEB_SCHEME="https"
    ;;
  *)
    echo "TORHOLE_WEB_MODE must be http, https-local, or https-custom."
    exit 1
    ;;
esac
update_env_value TORHOLE_WEB_SCHEME "$TORHOLE_WEB_SCHEME"
export TORHOLE_WEB_SCHEME

AUTHELIA_IMAGE="${AUTHELIA_IMAGE:-authelia/authelia:latest}"

mkdir -p "$AUTHELIA_DIR"
mkdir -p "$AUTHELIA_LOCALES_DIR"

if [[ ! -f "$AUTHELIA_LOGO_FILE" ]]; then
  echo "Missing required Authelia logo asset at $AUTHELIA_LOGO_FILE"
  exit 1
fi

password_hash="$(
  docker run --rm "$AUTHELIA_IMAGE" authelia crypto hash generate scrypt --password "$TORHOLE_ADMIN_PASSWORD" \
    | sed -n 's/^Digest: //p' | tail -n 1 | tr -d '\r'
)"

caddy_password_hash="$(
  docker run --rm "$REVERSE_PROXY_IMAGE" \
    caddy hash-password --plaintext "$TORHOLE_ADMIN_PASSWORD" \
    | tail -n 1 | tr -d '\r'
)"

if [[ -z "$password_hash" ]]; then
  echo "Failed to generate the Authelia password hash."
  exit 1
fi
if [[ -z "$caddy_password_hash" ]]; then
  echo "Failed to generate the Caddy recovery password hash."
  exit 1
fi

cat > "$AUTHELIA_DIR/configuration.yml" <<EOF
theme: dark

server:
  address: 'tcp://0.0.0.0:9091'
  asset_path: '/config/assets'

log:
  level: info

authentication_backend:
  password_reset:
    disable: true
  file:
    path: '/config/users_database.yml'

access_control:
  default_policy: deny
  rules:
    - domain: $(yaml_quote "${TORHOLE_HOST_AUTH}.${REVERSE_PROXY_DOMAIN}")
      policy: bypass
    - domain_regex: $(yaml_quote "^(${protected_hosts_regex})\\.${REVERSE_PROXY_DOMAIN//./\\.}$")
      policy: one_factor

session:
  secret: $(yaml_quote "$AUTHELIA_SESSION_SECRET")
  cookies:
    - domain: $(yaml_quote "$REVERSE_PROXY_DOMAIN")
      authelia_url: $(yaml_quote "https://${TORHOLE_HOST_AUTH}.${REVERSE_PROXY_DOMAIN}")
      default_redirection_url: $(yaml_quote "https://${TORHOLE_HOST_TORHOLE}.${REVERSE_PROXY_DOMAIN}")

storage:
  encryption_key: $(yaml_quote "$AUTHELIA_STORAGE_ENCRYPTION_KEY")
  local:
    path: '/var/lib/authelia/db.sqlite3'

notifier:
  filesystem:
    filename: '/var/lib/authelia/notification.txt'
EOF

cat > "$AUTHELIA_LOCALES_DIR/portal.json" <<'EOF'
{
  "Sign in": "Sign in to TORHOLE",
  "Logout": "Sign out of Torhole",
  "Username": "Admin username",
  "Password": "Admin password"
}
EOF

cat > "$AUTHELIA_DIR/users_database.yml" <<EOF
users:
  ${TORHOLE_ADMIN_USER}:
    disabled: false
    displayname: 'Torhole Admin'
    password: $(yaml_quote "$password_hash")
    email: $(yaml_quote "admin@${TORHOLE_HOST_TORHOLE}.${REVERSE_PROXY_DOMAIN}")
    groups:
      - admins
EOF

if [[ "$TORHOLE_WEB_MODE" == "http" ]]; then
  cat > "$CADDY_DIR/auth-snippets.caddy" <<EOF
(access_gate) {
  basic_auth {
    ${TORHOLE_ADMIN_USER} ${caddy_password_hash}
  }
  request_header Remote-User {http.auth.user.id}
  request_header Remote-Name {http.auth.user.id}
}

(ip_access_gate) {
  import access_gate
}
EOF
else
  cat > "$CADDY_DIR/auth-snippets.caddy" <<EOF
(access_gate) {
  forward_auth authelia:9091 {
    uri /api/authz/forward-auth?authelia_url=${TORHOLE_WEB_SCHEME}://${TORHOLE_HOST_AUTH}.${REVERSE_PROXY_DOMAIN}
    copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
  }
}

(ip_access_gate) {
  basic_auth {
    ${TORHOLE_ADMIN_USER} ${caddy_password_hash}
  }
  request_header Remote-User {http.auth.user.id}
  request_header Remote-Name {http.auth.user.id}
}
EOF
fi

case "$TORHOLE_WEB_MODE" in
  http)
    cat > "$CADDY_DIR/tls-snippets.caddy" <<'EOF'
(tls_mode) {
  encode zstd gzip
}
EOF
    ;;
  https-local)
    cat > "$CADDY_DIR/tls-snippets.caddy" <<'EOF'
(tls_mode) {
  tls internal
  encode zstd gzip
}
EOF
    ;;
  https-custom)
    cert_file="$CADDY_TLS_DIR/custom.crt"
    key_file="$CADDY_TLS_DIR/custom.key"
    if [[ ! -f "$cert_file" || ! -f "$key_file" ]]; then
      echo "Custom HTTPS requires monitoring/caddy/tls/custom.crt and custom.key."
      exit 1
    fi
    openssl x509 -in "$cert_file" -noout >/dev/null
    openssl pkey -in "$key_file" -noout >/dev/null
    cert_pub="$(openssl x509 -in "$cert_file" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | awk '{print $1}')"
    key_pub="$(openssl pkey -in "$key_file" -pubout -outform DER | sha256sum | awk '{print $1}')"
    if [[ "$cert_pub" != "$key_pub" ]]; then
      echo "Custom HTTPS certificate and private key do not match."
      exit 1
    fi
    if ! openssl x509 -checkend 0 -noout -in "$cert_file" >/dev/null; then
      echo "Custom HTTPS certificate is expired."
      exit 1
    fi
    IFS=',' read -r -a public_host_labels <<< "$(torhole_public_hosts_csv)"
    for host_label in "${public_host_labels[@]}"; do
      public_hostname="${host_label}.${REVERSE_PROXY_DOMAIN}"
      if ! openssl x509 -checkhost "$public_hostname" -noout -in "$cert_file" >/dev/null; then
        echo "Custom HTTPS certificate does not cover ${public_hostname}."
        exit 1
      fi
    done
    cat > "$CADDY_DIR/tls-snippets.caddy" <<'EOF'
(tls_mode) {
  tls /etc/caddy/tls/custom.crt /etc/caddy/tls/custom.key
  encode zstd gzip
}
EOF
    ;;
esac

chmod 600 \
  "$AUTHELIA_DIR/configuration.yml" \
  "$AUTHELIA_DIR/users_database.yml" \
  "$CADDY_DIR/auth-snippets.caddy" \
  "$CADDY_DIR/tls-snippets.caddy"
rm -f "$ENV_FILE.bak"

echo "Rendered ${TORHOLE_WEB_MODE} web access and authentication configuration."
