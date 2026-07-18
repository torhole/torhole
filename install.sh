#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$ROOT_DIR/pi-dns-warden"
ENV_FILE="$APP_DIR/.env.quickstart.local"
COMPOSE_FILE="$APP_DIR/docker-compose.quickstart.yml"
BOOTSTRAP_ENV_FILE="$APP_DIR/.env.bootstrap.local"
BOOTSTRAP_COMPOSE_FILE="$APP_DIR/docker-compose.bootstrap.yml"
DOCKER=(docker)

usage() {
  cat <<'EOF'
Torhole installer

Usage:
  ./install.sh             Open the guided Home / Advanced installer
  ./install.sh install     Open the guided installer
  ./install.sh credentials Show the local URLs and generated credentials
  ./install.sh status      Show service health
  ./install.sh logs        Follow service logs
  ./install.sh stop        Stop Torhole without deleting its data
  ./install.sh close-wizard Stop and remove the temporary setup service
  ./install.sh --dry-run   Validate the installer without starting containers
EOF
}

compose() {
  "${DOCKER[@]}" compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

bootstrap_compose() {
  "${DOCKER[@]}" compose --env-file "$BOOTSTRAP_ENV_FILE" -f "$BOOTSTRAP_COMPOSE_FILE" "$@"
}

need_docker() {
  local access_check="${1:-daemon}"
  if ! command -v docker >/dev/null 2>&1; then
    if [[ "$access_check" == "config-only" ]]; then
      echo "Docker is required to validate the Compose files, but --dry-run never installs packages."
      exit 1
    fi
    install_native_docker
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose is missing. Install the Docker Compose plugin, then run this command again."
    exit 1
  fi

  if [[ "$access_check" == "daemon" ]] && ! docker info >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
      DOCKER=(sudo docker)
    else
      echo "Docker is installed, but your user cannot access it."
      echo "Run this installer with sudo, or add your user to the docker group."
      exit 1
    fi
  fi
}

install_native_docker() {
  if ! command -v apt-get >/dev/null 2>&1 || [[ ! -f /etc/debian_version ]]; then
    echo "Docker is not installed. Install Docker Engine or Docker Desktop, then run this command again."
    echo "Help: https://docs.docker.com/engine/install/"
    exit 1
  fi

  local answer="${TORHOLE_INSTALL_DOCKER:-}"
  if [[ "$answer" != "1" ]]; then
    if [[ ! -t 0 ]]; then
      echo "Docker is required. Re-run interactively, or set TORHOLE_INSTALL_DOCKER=1 to allow native package installation."
      exit 1
    fi
    read -r -p "Docker is required. Install it from the Debian/Ubuntu package repository now? [Y/n] " answer
    case "${answer:-y}" in
      y|Y|yes|YES) ;;
      *)
        echo "Installation cancelled. No packages were changed."
        exit 1
        ;;
    esac
  fi

  local -a elevate=()
  if [[ "$(id -u)" != "0" ]]; then
    if ! command -v sudo >/dev/null 2>&1; then
      echo "Installing Docker requires root access, but sudo is not available."
      exit 1
    fi
    elevate=(sudo)
  fi

  echo "Installing Docker Engine and Compose from the operating system repository…"
  "${elevate[@]}" apt-get update
  "${elevate[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose
  "${elevate[@]}" systemctl enable --now docker
  echo "Docker is ready."
}

random_password() {
  od -An -N12 -tx1 /dev/urandom | tr -d ' \n'
}

detected_timezone() {
  if [[ -n "${TORHOLE_INSTALL_TIMEZONE:-}" ]]; then
    printf '%s' "$TORHOLE_INSTALL_TIMEZONE"
    return
  fi
  if [[ -f /etc/timezone ]]; then
    tr -d ' \n' </etc/timezone
  else
    printf 'UTC'
  fi
}

detected_address() {
  if [[ -n "${TORHOLE_INSTALL_ADDRESS:-}" ]]; then
    printf '%s' "$TORHOLE_INSTALL_ADDRESS"
    return
  fi
  local address=""
  if command -v hostname >/dev/null 2>&1; then
    address="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  printf '%s' "$address"
}

ensure_bootstrap_env() {
  if [[ -f "$BOOTSTRAP_ENV_FILE" ]]; then
    if ! grep -q '^TORHOLE_REPO_PATH=' "$BOOTSTRAP_ENV_FILE"; then
      printf 'TORHOLE_REPO_PATH=%s\n' "$ROOT_DIR" >>"$BOOTSTRAP_ENV_FILE"
    fi
    return
  fi
  local address timezone owner_uid owner_gid
  address="$(detected_address)"
  timezone="$(detected_timezone)"
  owner_uid="${SUDO_UID:-$(id -u)}"
  owner_gid="${SUDO_GID:-$(id -g)}"
  [[ -n "$address" ]] || address="localhost"
  umask 077
  {
    printf 'TORHOLE_BOOTSTRAP_TOKEN=%s%s\n' "$(random_password)" "$(random_password)"
    printf 'TORHOLE_BOOTSTRAP_PORT=8099\n'
    printf 'TORHOLE_HOST_ADDRESS=%s\n' "$address"
    printf 'TORHOLE_REPO_PATH=%s\n' "$ROOT_DIR"
    printf 'TORHOLE_OWNER_UID=%s\n' "$owner_uid"
    printf 'TORHOLE_OWNER_GID=%s\n' "$owner_gid"
    printf 'TZ=%s\n' "$timezone"
  } >"$BOOTSTRAP_ENV_FILE"
}

bootstrap_env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$BOOTSTRAP_ENV_FILE" | head -n 1
}

rotate_bootstrap_token() {
  local token temp_file
  token="$(random_password)$(random_password)"
  temp_file="$(mktemp "${BOOTSTRAP_ENV_FILE}.XXXXXX")"
  awk -v token="$token" '
    BEGIN { replaced = 0 }
    /^TORHOLE_BOOTSTRAP_TOKEN=/ {
      print "TORHOLE_BOOTSTRAP_TOKEN=" token
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) print "TORHOLE_BOOTSTRAP_TOKEN=" token }
  ' "$BOOTSTRAP_ENV_FILE" >"$temp_file"
  chmod 600 "$temp_file"
  mv "$temp_file" "$BOOTSTRAP_ENV_FILE"
}

open_installer_url() {
  local url="$1"
  if command -v xdg-open >/dev/null 2>&1 && [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
    xdg-open "$url" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
  fi
}

start_wizard() {
  need_docker
  ensure_bootstrap_env
  rotate_bootstrap_token
  echo "Starting the Torhole setup wizard…"
  bootstrap_compose up -d --build

  local attempt
  for attempt in {1..20}; do
    if bootstrap_compose exec -T bootstrap python3 -c \
      'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8099/health", timeout=2).read()' \
      >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if [[ "$attempt" == "20" ]]; then
    echo "The setup wizard did not become ready."
    echo "Run: docker compose --env-file $BOOTSTRAP_ENV_FILE -f $BOOTSTRAP_COMPOSE_FILE logs"
    exit 1
  fi

  local url
  url="http://$(bootstrap_env_value TORHOLE_HOST_ADDRESS):$(bootstrap_env_value TORHOLE_BOOTSTRAP_PORT)/?token=$(bootstrap_env_value TORHOLE_BOOTSTRAP_TOKEN)"
  echo
  echo "Open the private setup URL:"
  echo "  $url"
  echo
  echo "Keep this terminal open while Torhole installs."
  open_installer_url "$url"
}

ensure_env() {
  if [[ -f "$ENV_FILE" ]]; then
    if ! grep -q '^TORHOLE_EDITION=' "$ENV_FILE"; then
      printf 'TORHOLE_EDITION=home\n' >>"$ENV_FILE"
    fi
    if ! grep -q '^BIND_ADDRESS=' "$ENV_FILE"; then
      local existing_address
      existing_address="$(detected_address)"
      if [[ -n "$existing_address" ]]; then
        printf 'BIND_ADDRESS=%s\n' "$existing_address" >>"$ENV_FILE"
      fi
    fi
    if ! grep -q '^PIHOLE_WEB_PORT=' "$ENV_FILE"; then
      printf 'PIHOLE_WEB_PORT=8081\n' >>"$ENV_FILE"
    fi
    if ! grep -q '^CONTROL_PIN=' "$ENV_FILE"; then
      printf 'CONTROL_PIN=%06d\n' "$((RANDOM % 1000000))" >>"$ENV_FILE"
    fi
    if ! grep -q '^CONTROL_HELPER_TOKEN=' "$ENV_FILE"; then
      printf 'CONTROL_HELPER_TOKEN=%s\n' "$(random_password)$(random_password)" >>"$ENV_FILE"
    fi
    return
  fi

  local password timezone address
  password="$(random_password)"
  timezone="$(detected_timezone)"
  address="$(detected_address)"
  umask 077
  {
    printf 'TORHOLE_EDITION=home\n'
    printf 'PIHOLE_PASSWORD=%s\n' "$password"
    printf 'TZ=%s\n' "$timezone"
    printf 'DNS_PORT=53\n'
    printf 'WEB_PORT=8080\n'
    printf 'PIHOLE_WEB_PORT=8081\n'
    printf 'CONTROL_PIN=%06d\n' "$((RANDOM % 1000000))"
    printf 'CONTROL_HELPER_TOKEN=%s%s\n' "$(random_password)" "$(random_password)"
    if [[ -n "$address" ]]; then
      printf 'BIND_ADDRESS=%s\n' "$address"
    fi
  } >"$ENV_FILE"
  echo "Created a secure local configuration."
}

env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$ENV_FILE" | head -n 1
}

host_address() {
  local address
  address="$(env_value BIND_ADDRESS)"
  if [[ -z "$address" ]]; then
    address="$(detected_address)"
  fi
  if [[ -z "$address" ]]; then
    address="localhost"
  fi
  printf '%s' "$address"
}

show_success() {
  local address password control_pin
  address="$(host_address)"
  password="$(env_value PIHOLE_PASSWORD)"
  control_pin="$(env_value CONTROL_PIN)"
  echo
  echo "Torhole Home is starting. Tor usually needs about a minute to connect."
  echo
  echo "Open:     http://${address}:$(env_value WEB_PORT)/"
  echo "Pi-hole admin password: ${password}"
  echo "Control PIN: ${control_pin}"
  echo "DNS:      ${address}"
  echo "Advanced: http://${address}:$(env_value PIHOLE_WEB_PORT)/admin/"
  echo
  echo "Next: set your router's DNS server to ${address}."
  echo "Run './install.sh status' at any time to check Torhole."
}

show_credentials() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "No Torhole Home credentials were found."
    echo "Run './install.sh' to install Torhole first."
    exit 1
  fi

  local address password control_pin
  address="$(host_address)"
  password="$(env_value PIHOLE_PASSWORD)"
  control_pin="$(env_value CONTROL_PIN)"
  echo "Torhole Home access details (keep this output private):"
  echo
  echo "Torhole Home:           http://${address}:$(env_value WEB_PORT)/"
  echo "Pi-hole settings:       http://${address}:$(env_value PIHOLE_WEB_PORT)/admin/"
  echo "Pi-hole admin password: ${password}"
  echo "Control PIN:            ${control_pin}"
  echo "DNS server:             ${address}"
}

verify_dns() {
  echo "Waiting for Tor and testing private DNS..."
  local attempt
  for attempt in {1..18}; do
    if compose exec -T pihole dig +short +time=3 +tries=1 @127.0.0.1 example.com 2>/dev/null | grep -q .; then
      echo "Private DNS test passed."
      return 0
    fi
    sleep 5
  done

  echo
  echo "Torhole started, but its private DNS test did not pass."
  echo "Your network may block Tor, or Tor may need more time to connect."
  echo "Run './install.sh logs' for details, then './install.sh' to retry."
  return 1
}

migrate_legacy_network() {
  local legacy="pi-dns-warden_torhole_qs"
  if "${DOCKER[@]}" network inspect "$legacy" >/dev/null 2>&1; then
    local attached
    attached="$("${DOCKER[@]}" network inspect "$legacy" --format '{{len .Containers}}')"
    if [[ "$attached" == "0" ]]; then
      echo "Removing obsolete Torhole Home network..."
      "${DOCKER[@]}" network rm "$legacy" >/dev/null
    fi
  fi
}

command="${1:-wizard}"
case "$command" in
  -h|--help)
    usage
    ;;
  --dry-run)
    need_docker config-only
    ensure_env
    ensure_bootstrap_env
    compose config -q
    bootstrap_compose config -q
    echo "Installer check passed. No containers were started."
    ;;
  wizard|install)
    start_wizard
    ;;
  credentials)
    show_credentials
    ;;
  install-home)
    need_docker
    ensure_env
    migrate_legacy_network
    echo "Starting Torhole Home (Pi-hole + encrypted DNS + Tor)..."
    if ! compose up -d --build; then
      echo
      echo "Torhole could not start; Docker's error is shown above."
      echo "If port 53 is already in use, stop the conflicting DNS service and try again."
      echo "See the troubleshooting section in README.md for other causes."
      exit 1
    fi
    verify_dns || exit 1
    show_success
    ;;
  status)
    need_docker
    ensure_env
    compose ps
    ;;
  logs)
    need_docker
    ensure_env
    compose logs -f
    ;;
  stop)
    need_docker
    ensure_env
    compose stop
    echo "Torhole stopped. Its configuration and data were kept."
    ;;
  close-wizard)
    need_docker
    if [[ -f "$BOOTSTRAP_ENV_FILE" ]]; then
      bootstrap_compose down
    fi
    echo "The temporary Torhole setup service is closed."
    ;;
  *)
    echo "Unknown command: $command"
    usage
    exit 1
    ;;
esac
