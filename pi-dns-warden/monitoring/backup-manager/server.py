import fcntl
import json
import os
import re
import secrets
import shlex
import shutil
import socket
import ssl
import subprocess
import tarfile
import threading
import time
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# Make the extracted sibling modules (env_store, status_math, torctl,
# pihole_client) importable no matter how server.py is loaded: the container
# runs it as a script from WORKDIR /app; the test suites and the shell tests
# load it by path via importlib from a different CWD, where the containing
# directory is NOT on sys.path automatically. Self-locate here so every
# loader works.
import sys as _sys

_sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


ROOT_DIR = Path(os.environ.get("TORHOLE_ROOT_DIR", "/workspace")).resolve()


def _detect_host_root_dir(root_dir, configured_root=None):
    """Resolve the host source backing the container's workspace bind mount.

    Docker bind paths in child ``docker run`` commands are interpreted by the
    host daemon, not inside this container. Curl installs can live anywhere
    under the operator's home directory, so a fixed ``/opt/pi-dns-warden``
    default is not reliable. Docker's own mount metadata is authoritative;
    retain the configured value as a fallback for host-side imports/tests or
    restricted Docker sockets.
    """
    # These are paths in the Docker host's namespace. Do not resolve them in
    # the container namespace: on Docker Desktop or symlinked hosts that can
    # rewrite an otherwise correct daemon path.
    fallback = Path(configured_root or str(root_dir))
    container_ref = os.environ.get("HOSTNAME") or "backup-manager"
    try:
        result = subprocess.run(
            ["docker", "inspect", container_ref],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        if result.returncode != 0:
            return fallback
        payload = json.loads(result.stdout)
        mounts = payload[0].get("Mounts", []) if payload else []
        destination = str(Path(root_dir))
        for mount in mounts:
            if (
                mount.get("Type") == "bind"
                and mount.get("Destination") == destination
                and mount.get("Source")
            ):
                return Path(mount["Source"])
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, json.JSONDecodeError):
        pass
    return fallback


HOST_ROOT_DIR = _detect_host_root_dir(
    ROOT_DIR,
    os.environ.get("TORHOLE_HOST_ROOT_DIR"),
)
# Child recovery/validation scripts inherit this corrected host-side path.
os.environ["TORHOLE_HOST_ROOT_DIR"] = str(HOST_ROOT_DIR)
BACKUP_DIR = ROOT_DIR / "backups"
RUN_DIR = ROOT_DIR / "run"
STATUS_FILE = RUN_DIR / "recovery-status.json"
RECOVERY_LOCK_FILE = RUN_DIR / "recovery.lock"
VALIDATION_FILE = RUN_DIR / "system-validation.json"
ENV_FILE = ROOT_DIR / ".env"
ALERTMANAGER_CONFIG_FILE = ROOT_DIR / "monitoring/alertmanager/alertmanager.yml"
HELPER_IMAGE = os.environ.get("BACKUP_MANAGER_IMAGE", "pi-dns-warden-backup-manager")
PROJECT_NAME = os.environ.get("TORHOLE_PROJECT_NAME", "pi-dns-warden")
BACKUP_MANAGER_API_TOKEN = os.environ.get("BACKUP_MANAGER_API_TOKEN", "")
TORHOLE_TOPOLOGY = os.environ.get("TORHOLE_TOPOLOGY", "vlan")
if TORHOLE_TOPOLOGY not in {"single-lan", "vlan"}:
    TORHOLE_TOPOLOGY = "vlan"
ARCHIVE_PATTERN = re.compile(r"torhole-backup-[0-9]{8}-[0-9]{6}\.tar\.gz")
CHANNEL_FIELDS = {
    "telegram": {
        "label": "Telegram",
        "enabled_key": "ALERT_TELEGRAM_ENABLED",
        "required_keys": ("ALERT_TELEGRAM_BOT_TOKEN", "ALERT_TELEGRAM_CHAT_ID"),
    },
    "email": {
        "label": "Email",
        "enabled_key": "ALERT_EMAIL_ENABLED",
        "required_keys": ("ALERT_EMAIL_TO", "ALERT_EMAIL_FROM", "ALERT_EMAIL_SMARTHOST"),
    },
    "discord": {
        "label": "Discord",
        "enabled_key": "ALERT_DISCORD_ENABLED",
        "required_keys": ("ALERT_DISCORD_WEBHOOK_URL",),
    },
}
_SERVICE_CATALOG = (
    {"id": "reverse-proxy", "label": "Reverse Proxy", "container": "reverse-proxy", "link_key": "torhole"},
    {"id": "authelia", "label": "Auth Portal", "container": "authelia", "link_key": "auth"},
    {"id": "grafana", "label": "Grafana", "container": "grafana", "link_key": "grafana"},
    {"id": "prometheus", "label": "Prometheus", "container": "prometheus", "link_key": "prometheus"},
    {"id": "alertmanager", "label": "Alertmanager", "container": "alertmanager", "link_key": "alertmanager"},
    {"id": "dockhand", "label": "Dockhand", "container": "dockhand", "link_key": "dockhand"},
    {"id": "backup-manager", "label": "Recovery API", "container": "backup-manager", "link_key": "torhole"},
    {"id": "tor", "label": "Tor", "container": "tor"},
    {"id": "dnscrypt-trusted", "label": "dnscrypt Trusted", "container": "dnscrypt-trusted"},
    {"id": "dnscrypt-iot", "label": "dnscrypt IoT", "container": "dnscrypt-iot"},
    {"id": "pihole-trusted", "label": "Pi-hole Trusted", "container": "pihole_trusted", "link_key": "pihole_trusted"},
    {"id": "pihole-iot", "label": "Pi-hole IoT", "container": "pihole_iot", "link_key": "pihole_iot"},
)
SERVICE_CATALOG = tuple(
    service
    for service in _SERVICE_CATALOG
    if TORHOLE_TOPOLOGY == "vlan"
    or service["container"] not in {"dnscrypt-iot", "pihole_iot"}
)
PUBLIC_HOST_DEFAULTS = {
    "TORHOLE_HOST_TORHOLE": "torhole",
    "TORHOLE_HOST_AUTH": "auth",
    "TORHOLE_HOST_GRAFANA": "grafana",
    "TORHOLE_HOST_PROMETHEUS": "prometheus",
    "TORHOLE_HOST_ALERTMANAGER": "alertmanager",
    "TORHOLE_HOST_DOCKHAND": "dockhand",
    "TORHOLE_HOST_PIHOLE_TRUSTED": "pihole-trusted",
    "TORHOLE_HOST_PIHOLE_IOT": "pihole-iot",
    "TORHOLE_ALIAS_TORHOLE": "th",
    "TORHOLE_ALIAS_GRAFANA": "gf",
    "TORHOLE_ALIAS_PROMETHEUS": "prom",
    "TORHOLE_ALIAS_ALERTMANAGER": "am",
    "TORHOLE_ALIAS_DOCKHAND": "dh",
    "TORHOLE_ALIAS_PIHOLE_TRUSTED": "pt",
    "TORHOLE_ALIAS_PIHOLE_IOT": "pi",
}

# These settings describe the second DNS plane or VLAN tagging itself. They
# remain in .env so an operator can move between Advanced topology profiles,
# but they are not active application parameters in a single-LAN deployment.
# Keep the API capability-aware: the installed dashboard must not advertise or
# allow edits to controls that the running profile cannot use.
VLAN_ONLY_CONFIG_KEYS = frozenset(
    {
        "TRUSTED_VLAN_ID",
        "IOT_VLAN_ID",
        "IOT_PARENT",
        "IOT_SUBNET_CIDR",
        "IOT_GATEWAY",
        "PIHOLE_IOT_IP",
        "PIHOLE_IOT_PASSWORD",
        "DNSCRYPT_SOCKS_USER_IOT",
        "DNSCRYPT_SOCKS_PASS_IOT",
        "TORHOLE_HOST_PIHOLE_IOT",
        "TORHOLE_ALIAS_PIHOLE_IOT",
    }
)


def config_key_is_active(key):
    return TORHOLE_TOPOLOGY == "vlan" or key not in VLAN_ONLY_CONFIG_KEYS


VALIDATION_MARKERS = (
    ("compose", "Compose render", "compose render"),
    ("prometheus_config", "Prometheus config", "prometheus config"),
    ("prometheus_rules", "Prometheus rules", "prometheus rules"),
    ("alertmanager_config", "Alertmanager config", "alertmanager config"),
    ("caddy_config", "Caddy config", "caddy config"),
    ("authelia_config", "Authelia config", "authelia config"),
    ("alloy_config", "Alloy config", "alloy config"),
    ("dashboard_json", "Dashboard JSON", "dashboard json"),
    ("pihole_exporter_python", "Pi-hole exporter Python", "pihole exporter python"),
    ("backup_manager_python", "Backup manager Python", "backup manager python"),
)

# Tor control port — used to read live circuit info via GETINFO. Address is
# the in-network hostname of the tor service container; password lives in
# .env as TOR_CONTROL_PASSWORD and is read via read_env_values_safe().


def requires_backend_auth(path):
    """Return whether a request must come through the authenticated proxy.

    Health and Prometheus telemetry remain service endpoints. All application
    API routes require the proxy's bearer token, including unknown routes so a
    direct caller cannot use response differences to enumerate the API.
    """
    request_path = urlparse(path).path
    return request_path not in {"/health", "/api/metrics/tor"}


def is_backend_request_authorized(headers, expected_token=None):
    token = BACKUP_MANAGER_API_TOKEN if expected_token is None else expected_token
    if not token:
        return False
    authorization = headers.get("Authorization", "")
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        return False
    supplied = authorization[len(prefix):]
    return secrets.compare_digest(supplied.encode("utf-8"), token.encode("utf-8"))

# Tor SOCKS proxy — used by run_leak_test() to verify the privacy guarantee
# end-to-end (every query through Tor exits via a Tor relay).
TOR_SOCKS_HOST = os.environ.get("TOR_SOCKS_HOST", "tor")
TOR_SOCKS_PORT = int(os.environ.get("TOR_SOCKS_PORT", "9050"))
LEAK_TEST_TIMEOUT_S = float(os.environ.get("TORHOLE_LEAK_TEST_TIMEOUT_S", "20"))
LEAK_TEST_HISTORY_MAX = int(os.environ.get("TORHOLE_LEAK_TEST_HISTORY_MAX", "50"))
LEAK_TEST_TARGET_HOST = "check.torproject.org"
LEAK_TEST_TARGET_PATH = "/api/ip"
TOR_BOOTSTRAP_PATTERN = re.compile(r"Bootstrapped (\d+)%.*?:\s*(.+)")
TOR_HEARTBEAT_PATTERN = re.compile(r"Heartbeat: Tor's uptime is (.+?), with (\d+) circuits open\.")

# Broken-pipe / reset sentinels. The admin UI polls /api/system/snapshot
# every 5 seconds and any tab close mid-response lands the server at
# handler.wfile.write() with the client socket already gone. Swallow the
# same way _sse_send does.
_CLIENT_GONE_EXCS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)


def json_response(handler, payload, status=HTTPStatus.OK):
    body = json.dumps(payload).encode("utf-8")
    try:
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
    except _CLIENT_GONE_EXCS:
        # Client closed the connection before we finished. Nothing to
        # recover — swallow the trace the way _sse_send already does.
        return


def read_status():
    if not STATUS_FILE.exists():
        return {
            "status": "idle",
            "operation": None,
            "message": "No recovery operation has run yet.",
        }

    try:
        return json.loads(STATUS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {
            "status": "error",
            "operation": "unknown",
            "message": "Recovery status file is unreadable.",
        }


def write_status(operation, status, message, archive=""):
    now = utc_now()
    current = read_status() if STATUS_FILE.exists() else {}
    payload = {
        "updated_at": now,
        "operation": operation,
        "status": status,
        "message": message,
    }
    if archive:
        payload["archive"] = archive
    if status == "running":
        payload["started_at"] = now
    elif current.get("started_at"):
        payload["started_at"] = current["started_at"]
    if status in {"success", "error"}:
        payload["finished_at"] = now
    STATUS_FILE.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def recovery_busy():
    """Return whether a recovery process currently owns the OS file lock.

    The status JSON is display history, not synchronization state. A process
    or container can stop after writing ``running`` and leave that text behind
    indefinitely. The shell recovery scripts already hold an exclusive flock
    for their lifetime, so probe the same lock and trust the kernel instead.
    """
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    with RECOVERY_LOCK_FILE.open("a+", encoding="utf-8") as lock_handle:
        acquired = False
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except BlockingIOError:
            return True
        finally:
            if acquired:
                try:
                    fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
                except OSError:
                    pass
    return False


# Reading metadata.json from a multi-hundred-MB tar.gz takes seconds. Cache by
# (path, mtime) so unchanged files are free on subsequent lists. Backups are
# immutable after creation; mtime is a perfect cache key.
_BACKUP_METADATA_CACHE = {}
_BACKUP_METADATA_CACHE_LOCK = threading.Lock()


def read_backup_metadata(path: Path):
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return {}

    cache_key = str(path)
    with _BACKUP_METADATA_CACHE_LOCK:
        cached = _BACKUP_METADATA_CACHE.get(cache_key)
        if cached and cached[0] == mtime:
            return cached[1]

    try:
        with tarfile.open(path, "r:gz") as archive:
            member = archive.getmember("metadata.json")
            handle = archive.extractfile(member)
            if handle is None:
                metadata = {}
            else:
                payload = json.loads(handle.read().decode("utf-8"))
                metadata = {
                    "project_name": payload.get("project_name"),
                    "format_version": payload.get("format_version"),
                    "captured_volumes": payload.get("captured_volumes", []),
                    "configured_volumes": payload.get("configured_volumes", []),
                    "created_at": payload.get("created_at"),
                }
    except Exception:
        metadata = {}

    with _BACKUP_METADATA_CACHE_LOCK:
        _BACKUP_METADATA_CACHE[cache_key] = (mtime, metadata)

    return metadata


def list_backups():
    if not BACKUP_DIR.exists():
        return []

    backups = []
    for path in sorted(BACKUP_DIR.glob("torhole-backup-*.tar.gz"), reverse=True):
        stat = path.stat()
        metadata = read_backup_metadata(path)
        backups.append(
            {
                "name": path.name,
                "path": str(path),
                "size_bytes": stat.st_size,
                "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                "metadata": metadata,
            }
        )
    return backups


def resolve_backup_archive(archive_name):
    if not ARCHIVE_PATTERN.fullmatch(archive_name):
        raise ValueError("Invalid archive name")

    archive_path = (BACKUP_DIR / archive_name).resolve()
    if archive_path.parent != BACKUP_DIR.resolve():
        raise ValueError("Archive path escapes backups directory.")
    if not archive_path.exists():
        raise FileNotFoundError(archive_name)
    return archive_path


def run_script(*args):
    return subprocess.run(
        list(args),
        cwd=ROOT_DIR,
        capture_output=True,
        text=True,
        check=False,
    )


def schedule_restore(archive_name):
    resolve_backup_archive(archive_name)

    command = (
        "sleep 2 && "
        f"/workspace/ops/scripts/60-restore.sh --yes --auto-restart {shlex.quote(f'/workspace/backups/{archive_name}')}"
    )

    return subprocess.run(
        [
            "docker",
            "run",
            "-d",
            "--rm",
            "--name",
            f"torhole-restore-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}",
            "-v",
            "/var/run/docker.sock:/var/run/docker.sock",
            "-v",
            f"{HOST_ROOT_DIR}:/workspace",
            "-w",
            "/workspace",
            "-e",
            "TORHOLE_ROOT_DIR=/workspace",
            "-e",
            f"TORHOLE_HOST_ROOT_DIR={HOST_ROOT_DIR}",
            "-e",
            f"TORHOLE_PROJECT_NAME={PROJECT_NAME}",
            "-e",
            f"BACKUP_MANAGER_IMAGE={HELPER_IMAGE}",
            HELPER_IMAGE,
            "sh",
            "-lc",
            command,
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def schedule_local_https_activation():
    """Queue a narrow post-install web-certificate transition.

    The helper bind-mounts the project at its *real host path* so Docker
    Compose resolves relative bind sources correctly for the host daemon.
    A short delay lets the API response reach the browser before Caddy is
    recreated. Direct-IP HTTP recovery remains defined in the new config.
    """
    command = "sleep 2 && ./ops/scripts/25-apply-web-access.sh"
    return subprocess.run(
        [
            "docker",
            "run",
            "-d",
            "--rm",
            "--name",
            f"torhole-web-access-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}",
            "-v",
            "/var/run/docker.sock:/var/run/docker.sock",
            "-v",
            f"{HOST_ROOT_DIR}:{HOST_ROOT_DIR}",
            "-w",
            str(HOST_ROOT_DIR),
            HELPER_IMAGE,
            "bash",
            "-lc",
            command,
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def _validate_custom_https_payload(certificate, private_key):
    if not isinstance(certificate, str) or not isinstance(private_key, str):
        raise ValueError("Custom HTTPS requires a PEM certificate and private key.")
    if len(certificate.encode("utf-8")) > 128 * 1024:
        raise ValueError("The uploaded certificate is larger than 128 KiB.")
    if len(private_key.encode("utf-8")) > 64 * 1024:
        raise ValueError("The uploaded private key is larger than 64 KiB.")
    if "-----BEGIN CERTIFICATE-----" not in certificate or "-----END CERTIFICATE-----" not in certificate:
        raise ValueError("The custom certificate or full chain must be PEM encoded.")
    if not re.search(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----", private_key):
        raise ValueError("The custom private key must be PEM encoded and unencrypted.")
    return certificate.strip() + "\n", private_key.strip() + "\n"


def _atomic_web_access_file(path, content, mode):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp_path = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    try:
        temp_path.write_text(content, encoding="utf-8")
        os.chmod(temp_path, mode)
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def _restore_web_access_file(path, previous, mode):
    if previous is None:
        path.unlink(missing_ok=True)
        return
    temp_path = path.with_name(f".{path.name}.{secrets.token_hex(6)}.rollback")
    try:
        temp_path.write_bytes(previous)
        os.chmod(temp_path, mode)
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def configure_https(mode, certificate=None, private_key=None):
    """Render, validate, and schedule a generated/custom HTTPS transition.

    The active proxy is untouched until the new certificate configuration has
    passed the same stack validation used by the Operate screen. On any
    synchronous failure, both .env and operator certificate files are restored.
    """
    if mode not in ("https-local", "https-custom"):
        raise ValueError("Web access mode must be generated HTTPS or custom HTTPS.")

    current = read_env_values_safe()
    current_mode = current.get("TORHOLE_WEB_MODE", "https-local")
    if mode == "https-local" and current_mode == "https-local":
        return _web_access_result(
            "Generated HTTPS with Authelia SSO is already enabled.", scheduled=False
        )

    clean_cert = clean_key = None
    if mode == "https-custom":
        clean_cert, clean_key = _validate_custom_https_payload(certificate, private_key)

    cert_path = ROOT_DIR / "monitoring/caddy/tls/custom.crt"
    key_path = ROOT_DIR / "monitoring/caddy/tls/custom.key"
    previous_cert = cert_path.read_bytes() if cert_path.exists() else None
    previous_key = key_path.read_bytes() if key_path.exists() else None
    backup_path = None

    try:
        if mode == "https-custom":
            _atomic_web_access_file(cert_path, clean_cert, 0o644)
            _atomic_web_access_file(key_path, clean_key, 0o600)

        backup_path, _ = update_env_keys(
            {"TORHOLE_WEB_MODE": mode, "TORHOLE_WEB_SCHEME": "https"},
            allow_secret_keys=False,
        )

        render = run_auth_render()
        if render.returncode != 0:
            raise RuntimeError(
                (render.stderr or render.stdout or "Authentication render failed.").strip()
            )

        validation = run_system_validation()
        if validation.get("status") != "success":
            raise RuntimeError(
                validation.get("summary") or "HTTPS configuration validation failed."
            )

        scheduled = schedule_local_https_activation()
        if scheduled.returncode != 0:
            raise RuntimeError(
                (scheduled.stderr or scheduled.stdout or "Failed to schedule HTTPS activation.").strip()
            )
    except Exception:
        if backup_path is not None:
            restore_env_from_backup(backup_path)
        _restore_web_access_file(cert_path, previous_cert, 0o644)
        _restore_web_access_file(key_path, previous_key, 0o600)
        # Best effort: keep rendered files aligned with the restored mode.
        run_auth_render()
        run_script(str(ROOT_DIR / "ops/scripts/13-render-prometheus.sh"))
        raise

    label = "Custom HTTPS certificate" if mode == "https-custom" else "Generated HTTPS"
    return _web_access_result(
        f"{label} and Authelia SSO validated. Web services are restarting now.",
        scheduled=True,
    )


def _web_access_result(message, scheduled):
    values = read_env_values_safe()
    host_ip = values.get("HOST_MGMT_IP", "")
    domain = values.get("REVERSE_PROXY_DOMAIN", "")
    torhole_host = values.get("TORHOLE_HOST_TORHOLE", "torhole")
    local_mode = values.get("TORHOLE_WEB_MODE") == "https-local"
    return {
        "ok": True,
        "message": message,
        "config": get_config_values(),
        "scheduled": scheduled,
        "recovery_url": f"http://{host_ip}/" if host_ip else None,
        "certificate_url": (
            f"http://{host_ip}/torhole-local-ca.crt" if host_ip and local_mode else None
        ),
        "https_url": f"https://{torhole_host}.{domain}/" if domain else None,
    }


def delete_backup_archive(archive_name):
    archive_path = resolve_backup_archive(archive_name)
    archive_path.unlink()
    return archive_path


# .env I/O lives in env_store (T-048 step 1). Names are re-exported so the
# rest of this file — and the test suites — keep addressing them here while
# the decomposition proceeds. env_store.ENV_FILE is the patch point for
# tests that redirect writes to a tempdir.
import env_store
# Pi-hole API client lives in pihole_client (T-048 step 4); re-exported.
from pihole_client import (
    PIHOLE_API_TARGETS,
    PIHOLE_API_TIMEOUT,
    PIHOLE_SSL_CONTEXT,
    _fetch_pihole_queries,
    _normalize_pihole_query,
    _normalize_query_status,
    _pihole_get_with_cached_sid,
    _pihole_tls_context,
    pihole_api_call,
    pihole_logout,
    probe_pihole_api,
)
# Tor control protocol lives in torctl (T-048 step 3); re-exported.
from torctl import (
    PLANE_NAMES,
    TOR_CONTROL_HOST,
    TOR_CONTROL_PORT,
    TOR_CONTROL_TIMEOUT_S,
    _parse_circuit_status,
    _parse_getinfo_replies,
    _tor_control_command,
    _tor_recv_response,
    tor_rotate_identity,
    tor_rotate_plane,
)
# Pure status/time helpers live in status_math (T-048 step 2); re-exported.
from status_math import (
    utc_now,
    combine_statuses,
    humanize_time_ago,
    is_truthy,
    overall_status_from_counts,
    parse_iso_datetime,
    service_counts,
    status_rank,
    summary_from_counts,
)
from env_store import (
    _SECRET_KEYS,
    _reject_env_control_chars,
    backup_env_file,
    parse_env_text,
    read_env_text,
    read_env_values,
    read_env_values_safe,
    restore_env_from_backup,
    update_env_keys,
    update_env_value_text,
)


def run_auth_render():
    """Run ops/scripts/18-render-auth.sh to regenerate Authelia's
    configuration.yml + users_database.yml from the current .env.

    Returns a CompletedProcess; callers check returncode and can read
    stdout/stderr from the result to surface failures to the UI.
    """
    return run_script(str(ROOT_DIR / "ops/scripts/18-render-auth.sh"))


def enable_local_https():
    """Prepare and queue generated HTTPS with Authelia SSO.

    Configuration is rendered and fully validated before the live proxy is
    touched. Any synchronous failure restores .env and the old auth render.
    The actual Caddy recreation is delayed in a helper container so this API
    response can complete through the existing HTTP proxy first.
    """
    return configure_https("https-local")


def restart_authelia_container():
    """docker restart authelia. Used after an admin password change so
    the new users_database.yml is loaded. Returns a CompletedProcess.
    """
    return run_subprocess(["docker", "restart", "authelia"])


# Password policy for the admin change flow. Kept deliberately simple —
# we enforce length + a mix of character classes rather than requiring
# symbols, since symbol requirements push users toward weaker patterns.
_PASSWORD_MIN_LEN = 12
_PASSWORD_MAX_LEN = 128


def validate_admin_password(password):
    """Validate a candidate admin password against policy. Returns (ok,
    reason) where reason is None on success and a human-readable string
    on failure. Kept at module scope so the same rules apply to both
    the password-change flow and the setup wizard apply flow later.
    """
    if not isinstance(password, str):
        return False, "Password must be a string."
    if len(password) < _PASSWORD_MIN_LEN:
        return False, f"Password must be at least {_PASSWORD_MIN_LEN} characters."
    if len(password) > _PASSWORD_MAX_LEN:
        return False, f"Password must be at most {_PASSWORD_MAX_LEN} characters."
    if not any(c.islower() for c in password):
        return False, "Password must contain a lowercase letter."
    if not any(c.isupper() for c in password):
        return False, "Password must contain an uppercase letter."
    if not any(c.isdigit() for c in password):
        return False, "Password must contain a digit."
    # Reject anything that contains a raw newline / carriage return — that
    # would break .env shell-sourcing in 18-render-auth.sh.
    if any(c in "\r\n" for c in password):
        return False, "Password cannot contain line breaks."
    return True, None


# Admin username policy — alphanumerics, dot, underscore, hyphen. First
# char must be a letter. Keeps Authelia's yaml key happy.
_ADMIN_USER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,63}$")

# Timezone policy — very relaxed. We just reject anything with shell
# metacharacters or whitespace since the value is written directly into
# .env and later sourced by shell scripts.
_TIMEZONE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$")
_EDITION_RE = re.compile(r"^(home|advanced)$")
_TOPOLOGY_RE = re.compile(r"^(single-lan|vlan)$")


def apply_setup_config(requested):
    """Persist the Setup wizard's captured fields into .env.

    Only non-secret, low-blast-radius keys are accepted:
      - TORHOLE_EDITION (home or advanced capability profile)
      - TORHOLE_TOPOLOGY (single-lan or vlan; activated by a later deploy)
      - TORHOLE_ADMIN_USER
      - TZ (timezone)

    Network addresses, VLAN IDs, blocklist URLs etc. are NOT written here.
    A topology selection is only recorded and still requires the explicit
    maintenance deploy shown by the UI; no networking or containers change
    inside this request.

    The write is a diff: only keys whose requested value differs from
    the current .env value are actually written. No-op requests return
    an empty changes list. Per the design doc, we do NOT auto-deploy
    (no docker compose restart) — the response instructs the operator
    to run `sudo ./deploy.sh` on the host to apply the change.

    Args:
      requested: dict with optional keys {edition, topology, admin_user, timezone}. Unknown
        keys are ignored. None or empty string means "don't touch this
        field".

    Returns:
      {"ok": True, "message": str, "changes": [{"key", "old", "new"}...]}

    Raises:
      ValueError on validation failure.
    """
    if not isinstance(requested, dict):
        raise ValueError("Setup payload must be an object.")

    # Map UI-facing field names to .env keys.
    field_map = {
        "edition": ("TORHOLE_EDITION", _EDITION_RE,
                    "Edition must be either 'home' or 'advanced'."),
        "topology": ("TORHOLE_TOPOLOGY", _TOPOLOGY_RE,
                     "Topology must be either 'single-lan' or 'vlan'."),
        "admin_user": ("TORHOLE_ADMIN_USER", _ADMIN_USER_RE,
                       "Admin user must start with a letter and contain only "
                       "letters, digits, dot, underscore or hyphen (max 64 chars)."),
        "timezone":   ("TZ", _TIMEZONE_RE,
                       "Timezone must look like an IANA zone (e.g. Europe/London), "
                       "letters/digits/slash/underscore only."),
    }

    # Validate everything first — reject the whole batch if any field is bad
    # so we never do a partial write.
    desired = {}
    for field, (env_key, pattern, error_msg) in field_map.items():
        raw = requested.get(field)
        if raw is None or raw == "":
            continue  # field not touched by this request
        if not isinstance(raw, str):
            raise ValueError(f"{field}: must be a string.")
        raw = raw.strip()
        if not raw:
            continue
        if not pattern.match(raw):
            raise ValueError(error_msg)
        desired[env_key] = raw

    current = read_env_values_safe()
    changes = []
    to_write = {}
    for key, new_value in desired.items():
        old = current.get(key, "")
        if old != new_value:
            changes.append({"key": key, "old": old, "new": new_value})
            to_write[key] = new_value

    if not to_write:
        return {
            "ok": True,
            "message": "No changes — every value matched the current .env.",
            "changes": [],
            "backup": None,
        }

    backup_path, _ = update_env_keys(to_write, allow_secret_keys=False)
    selected_edition = desired.get(
        "TORHOLE_EDITION", current.get("TORHOLE_EDITION", "advanced")
    )
    if selected_edition == "home":
        next_step = (
            "Home is recorded as the target profile. The current deployment was not "
            "stopped or replaced."
        )
    else:
        next_step = "Run `sudo ./deploy.sh` on the host to apply."
    return {
        "ok": True,
        "message": (
            f"Wrote {len(changes)} key{'s' if len(changes) != 1 else ''} to .env. "
            f"{next_step}"
        ),
        "changes": changes,
        "backup": str(backup_path) if backup_path else None,
    }


def verify_admin_password(supplied):
    """Constant-time compare a supplied password against the current
    TORHOLE_ADMIN_PASSWORD in .env. Returns True on match.

    The plaintext in .env is the source of truth — it's what
    18-render-auth.sh hashes into the Authelia users_database.yml at
    deploy time, and it's what the operator knows. Comparing against it
    directly is simpler than re-hashing through authelia's CLI and gives
    the UI a fast "current password check" it can run before enabling
    the update button.

    Uses secrets.compare_digest to prevent a timing side-channel from
    leaking the length or content of the real password via response
    time. (Low-value attack given the authenticated session is already
    behind Authelia, but the cost of doing it right is trivial.)
    """
    if not isinstance(supplied, str):
        return False
    try:
        values = read_env_values_safe()
    except Exception:
        return False
    current = values.get("TORHOLE_ADMIN_PASSWORD", "")
    if not current:
        # No password is set in .env — nothing to verify against, reject.
        return False
    return secrets.compare_digest(supplied.encode("utf-8"), current.encode("utf-8"))


def update_admin_password(new_password, current_password=None):
    """Change the admin password end-to-end:
        1. verify current_password (if supplied) against the .env plaintext
        2. validate new password policy
        3. snapshot .env
        4. write TORHOLE_ADMIN_PASSWORD into .env
        5. run 18-render-auth.sh to regenerate Authelia users_database.yml
        6. restart the authelia container

    Any failure after step 3 triggers restoration from the pre-write
    backup so the stack is left in a consistent state.

    current_password is optional for backwards compatibility — callers
    that don't supply it skip the current-password check. The UI always
    supplies it.

    Returns {ok: bool, message: str, backup: str|None}.
    """
    if current_password is not None and not verify_admin_password(current_password):
        return {
            "ok": False,
            "message": "Current password is incorrect.",
            "backup": None,
        }

    ok, reason = validate_admin_password(new_password)
    if not ok:
        return {"ok": False, "message": reason, "backup": None}

    # Write the new password to .env. allow_secret_keys=True because
    # TORHOLE_ADMIN_PASSWORD is explicitly a secret and this function
    # is the dedicated helper for that exact change.
    try:
        backup_path, _ = update_env_keys(
            {"TORHOLE_ADMIN_PASSWORD": new_password},
            allow_secret_keys=True,
        )
    except (ValueError, OSError) as exc:
        return {
            "ok": False,
            "message": f"Failed to write .env: {exc}",
            "backup": None,
        }

    backup_str = str(backup_path) if backup_path else None

    # Render Authelia's config from the new .env. If this fails we roll
    # back so the next login still works with the old password.
    render = run_auth_render()
    if render.returncode != 0:
        restore_env_from_backup(backup_path)
        return {
            "ok": False,
            "message": (
                "Render script failed — .env rolled back. "
                f"stderr: {(render.stderr or render.stdout or '').strip()[:400]}"
            ),
            "backup": backup_str,
        }

    # Restart Authelia so the new users_database.yml is loaded. If this
    # fails the render is still on disk, but Authelia will pick it up
    # next time it starts — we report the warning but keep the .env
    # change in place (no rollback here — rolling back would just leave
    # the user on the old password with an orphaned rendered file).
    restart = restart_authelia_container()
    if restart.returncode != 0:
        return {
            "ok": False,
            "message": (
                "Password written and Authelia config rendered, but the "
                "authelia container restart failed. Restart it manually "
                f"on the host. stderr: {(restart.stderr or '').strip()[:200]}"
            ),
            "backup": backup_str,
        }

    return {
        "ok": True,
        "message": "Admin password updated. Please log in again.",
        "backup": backup_str,
    }


def get_notification_channels():
    values = read_env_values()
    channels = []
    for name, config in CHANNEL_FIELDS.items():
        configured = all(values.get(key, "") for key in config["required_keys"])
        enabled_raw = values.get(config["enabled_key"], "")
        enabled = configured if enabled_raw == "" else configured and is_truthy(enabled_raw)
        channels.append(
            {
                "id": name,
                "label": config["label"],
                "configured": configured,
                "enabled": enabled,
                "enabled_key": config["enabled_key"],
            }
        )
    return channels


def run_subprocess(command):
    return subprocess.run(command, cwd=ROOT_DIR, capture_output=True, text=True, check=False)


def read_validation_result():
    if not VALIDATION_FILE.exists():
        return {
            "status": "not_run",
            "summary": "Validation has not run yet.",
            "checks": [],
        }

    try:
        return json.loads(VALIDATION_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {
            "status": "error",
            "summary": "Last validation result is unreadable.",
            "checks": [],
        }


def write_validation_result(payload):
    VALIDATION_FILE.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def build_public_links(values):
    domain = values.get("REVERSE_PROXY_DOMAIN", "").strip()
    if not domain:
        return {}

    def host(key):
        return values.get(key, "").strip() or PUBLIC_HOST_DEFAULTS[key]

    def link(key, path=""):
        mode = values.get("TORHOLE_WEB_MODE", "https-local").strip()
        scheme = "http" if mode == "http" else "https"
        return f"{scheme}://{host(key)}.{domain}{path}"

    links = {
        "torhole": link("TORHOLE_HOST_TORHOLE"),
        "auth": link("TORHOLE_HOST_AUTH"),
        "grafana": link("TORHOLE_HOST_GRAFANA"),
        "prometheus": link("TORHOLE_HOST_PROMETHEUS"),
        "alertmanager": link("TORHOLE_HOST_ALERTMANAGER"),
        "pihole_trusted": link("TORHOLE_HOST_PIHOLE_TRUSTED", "/admin/"),
    }
    topology = values.get("TORHOLE_TOPOLOGY", TORHOLE_TOPOLOGY)
    if topology == "vlan":
        links["pihole_iot"] = link("TORHOLE_HOST_PIHOLE_IOT", "/admin/")
    return links


def inspect_container(container_name):
    result = run_subprocess(["docker", "inspect", container_name])
    if result.returncode != 0:
        return None

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None

    return payload[0] if payload else None


def last_health_log(health):
    for entry in reversed(health.get("Log", [])):
        output = (entry.get("Output") or "").strip()
        if output:
            return output.splitlines()[-1]
    return ""


def container_runtime_state(container_name):
    payload = inspect_container(container_name)
    if payload is None:
        return "offline", "Container not found."

    state = payload.get("State", {})
    status = state.get("Status", "unknown")

    if not state.get("Running", False):
        if status == "restarting":
            return "degraded", "Container is restarting."
        return "offline", f"Container state: {status}."

    health = state.get("Health")
    if not health:
        return "healthy", f"Container state: {status}."

    health_status = health.get("Status", "unknown")
    if health_status == "healthy":
        return "healthy", "Healthcheck passed."
    if health_status == "starting":
        return "degraded", "Healthcheck is still starting."

    detail = last_health_log(health)
    if detail:
        return "degraded", detail
    return "degraded", f"Healthcheck status: {health_status}."


# ---------------------------------------------------------------------------
# Tor control protocol — read live circuit info from tor:9051.
# ---------------------------------------------------------------------------

# Match a single relay entry in a circuit path: $FINGERPRINT~Nickname
# (Nickname may contain alphanumerics and is optional in some Tor versions.)

# Match a single circuit-status line:
#   <id> <state> <path> [k=v ...]
# state is BUILT/EXTENDED/LAUNCHED/FAILED/CLOSED.

# k=v with optional double-quoted values for the trailing fields.


# ---------------------------------------------------------------------------
# Scheduled leak test — optional background thread that runs run_leak_test()
# on a fixed interval. Drives the "recent_pass_rate" in the snapshot so the
# Privacy screen's leak test panel shows a trend over time, not just the
# last manual click.
# ---------------------------------------------------------------------------

# Interval in seconds. 0 disables the scheduler entirely. Default: 30 min.
LEAK_TEST_SCHEDULE_INTERVAL_S = int(
    os.environ.get("TORHOLE_LEAK_TEST_INTERVAL_S", "1800")
)


def _scheduled_leak_test_loop():
    # Staggered first run so backup-manager startup isn't racing the tor
    # container's bootstrap. After the first run, sleep the full interval.
    time.sleep(45)
    while True:
        try:
            result = run_leak_test()
            store_leak_test_result(result)
        except Exception:
            pass
        time.sleep(LEAK_TEST_SCHEDULE_INTERVAL_S)


def start_scheduled_leak_test():
    if LEAK_TEST_SCHEDULE_INTERVAL_S <= 0:
        return
    thread = threading.Thread(
        target=_scheduled_leak_test_loop,
        daemon=True,
        name="leak-test-scheduler",
    )
    thread.start()


# ---------------------------------------------------------------------------
# Alertmanager test alert — POST a synthetic alert to Alertmanager v2 API.
# Routed by the existing alertmanager.yml config; whichever channels are
# enabled (Telegram, email, Discord) will deliver it.
# ---------------------------------------------------------------------------

ALERTMANAGER_URL = os.environ.get("ALERTMANAGER_URL", "http://alertmanager:9093")


# ---------------------------------------------------------------------------
# Scheduled backups + retention (T-060).
#
# Config lives in .env (TORHOLE_BACKUP_INTERVAL_H, TORHOLE_BACKUP_RETENTION)
# and is read LIVE on every scheduler pass — like the banner, editing .env
# changes the schedule without recreating the container. Interval 0 (the
# default) disables scheduling entirely. The loop keys off the newest
# archive's mtime, so it survives restarts without extra state and never
# double-runs after a manual backup.
# ---------------------------------------------------------------------------

BACKUP_SCHEDULER_POLL_S = int(os.environ.get("TORHOLE_BACKUP_POLL_S", "1800"))


def _backup_schedule_config():
    """Return (interval_hours, retention_keep) from .env, parsed defensively."""
    values = read_env_values_safe()
    try:
        interval = float(values.get("TORHOLE_BACKUP_INTERVAL_H") or "0")
    except ValueError:
        interval = 0.0
    try:
        keep = int(values.get("TORHOLE_BACKUP_RETENTION") or "7")
    except ValueError:
        keep = 7
    return max(interval, 0.0), max(keep, 0)


def _latest_backup_age_seconds():
    """Age of the newest archive in seconds, or None when none exist."""
    backups = list_backups()
    if not backups:
        return None
    try:
        mtime = (BACKUP_DIR / backups[0]["name"]).stat().st_mtime
    except OSError:
        return None
    return max(time.time() - mtime, 0.0)


def prune_backup_archives(keep):
    """Delete archives beyond the newest `keep`. Returns deleted names.
    keep <= 0 means retention is disabled (delete nothing)."""
    if keep <= 0:
        return []
    deleted = []
    for entry in list_backups()[keep:]:
        try:
            delete_backup_archive(entry["name"])
            deleted.append(entry["name"])
        except Exception:  # noqa: BLE001 — best-effort; never break the cycle
            pass
    return deleted


def _scheduled_backup_loop():
    # Long first delay so a freshly deployed stack isn't immediately spending
    # minutes tarring volumes while everything else is still settling.
    time.sleep(180)
    while True:
        try:
            interval_h, keep = _backup_schedule_config()
            if interval_h > 0 and not recovery_busy():
                age = _latest_backup_age_seconds()
                if age is None or age >= interval_h * 3600:
                    result = run_script(str(ROOT_DIR / "ops/scripts/50-backup.sh"))
                    if result.returncode == 0:
                        prune_backup_archives(keep)
        except Exception:  # noqa: BLE001 — the scheduler must never die
            pass
        time.sleep(BACKUP_SCHEDULER_POLL_S)


def start_scheduled_backup():
    # Always started: the interval is read live each pass, so operators can
    # enable/disable scheduling by editing .env without a recreate.
    thread = threading.Thread(
        target=_scheduled_backup_loop, daemon=True, name="scheduled-backup"
    )
    thread.start()


def send_test_alert():
    """POST a test alert to Alertmanager. Returns {ok, message}.

    The alertname carries a UTC timestamp suffix so every click creates a new
    aggregation group: without it, repeat tests within Alertmanager's
    repeat_interval (1h) are silently swallowed and the button appears dead.
    endsAt is set so each test auto-resolves instead of lingering active.
    """
    now_dt = datetime.now(timezone.utc)
    now = now_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    ends = (now_dt + timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    alerts = [
        {
            "labels": {
                "alertname": f"TorholeTest-{now_dt.strftime('%H%M%S')}",
                "severity": "warning",
                "service": "torhole-ui",
                "source": "torhole-admin",
            },
            "annotations": {
                "summary": "Torhole test alert",
                "description": (
                    "This is a test notification triggered from the Torhole admin UI. "
                    "If you see this in any channel, that channel is working."
                ),
            },
            "startsAt": now,
            "endsAt": ends,
        }
    ]
    try:
        req = Request(
            f"{ALERTMANAGER_URL}/api/v2/alerts",
            data=json.dumps(alerts).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(req, timeout=5) as resp:
            if 200 <= resp.status < 300:
                return {"ok": True, "message": "Test alert sent to Alertmanager."}
            return {"ok": False, "message": f"Alertmanager returned HTTP {resp.status}"}
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "message": f"{exc.__class__.__name__}: {exc}",
        }


# ---------------------------------------------------------------------------
# DNS leak test — verify that traffic through tor:9050 actually exits via Tor.
#
# Connects via SOCKS5 (with username "leaktest" so the circuit pool is
# isolated from the planes' circuits) to https://check.torproject.org/api/ip
# and checks that the JSON response has IsTor=true. This is the canonical
# privacy proof: if Torhole's routing is intact, every query exits via Tor.
#
# Implemented with raw sockets to avoid pulling in pysocks/requests.
# ---------------------------------------------------------------------------

_LEAK_TEST_HISTORY = []
_LEAK_TEST_LOCK = threading.Lock()


def _socks5_connect(socks_host, socks_port, dest_host, dest_port, username, password, timeout):
    """Open a SOCKS5 tunnel through socks_host:socks_port to (dest_host, dest_port).

    Uses username/password authentication so Tor's IsolateSOCKSAuth gives the
    leak test its own circuit pool — separate from the trusted/iot
    planes. Returns a connected socket ready for the application protocol.
    """
    sock = socket.create_connection((socks_host, socks_port), timeout=timeout)
    sock.settimeout(timeout)

    # Greeting: SOCKS5, 1 method offered, USERNAME/PASSWORD (0x02).
    sock.sendall(b"\x05\x01\x02")
    resp = sock.recv(2)
    if resp != b"\x05\x02":
        sock.close()
        raise RuntimeError(f"SOCKS5 greeting rejected: {resp.hex()}")

    # Username/password subnegotiation (RFC 1929): VER=1, ULEN, UNAME, PLEN, PASSWD
    user_b = username.encode("utf-8")
    pass_b = password.encode("utf-8")
    if len(user_b) > 255 or len(pass_b) > 255:
        sock.close()
        raise RuntimeError("SOCKS5 username/password too long")
    sock.sendall(bytes([1, len(user_b)]) + user_b + bytes([len(pass_b)]) + pass_b)
    resp = sock.recv(2)
    if len(resp) < 2 or resp[0] != 1 or resp[1] != 0:
        sock.close()
        raise RuntimeError(f"SOCKS5 auth rejected: {resp.hex()}")

    # CONNECT request: VER=5, CMD=1, RSV=0, ATYP=3 (domain), DLEN, DOMAIN, PORT(2 BE)
    domain_b = dest_host.encode("idna")
    if len(domain_b) > 255:
        sock.close()
        raise RuntimeError("SOCKS5 destination hostname too long")
    sock.sendall(
        b"\x05\x01\x00\x03"
        + bytes([len(domain_b)])
        + domain_b
        + dest_port.to_bytes(2, "big")
    )
    resp = sock.recv(4)
    if len(resp) < 4 or resp[0] != 5:
        sock.close()
        raise RuntimeError(f"SOCKS5 connect short reply: {resp.hex()}")
    if resp[1] != 0:
        sock.close()
        raise RuntimeError(f"SOCKS5 connect rejected: rep={resp[1]} ({_socks5_reason(resp[1])})")

    # Discard the bound address (we don't need it)
    atyp = resp[3]
    if atyp == 1:
        sock.recv(4)
    elif atyp == 4:
        sock.recv(16)
    elif atyp == 3:
        dlen_byte = sock.recv(1)
        if dlen_byte:
            sock.recv(dlen_byte[0])
    sock.recv(2)

    return sock


def _socks5_reason(rep):
    return {
        1: "general failure",
        2: "connection not allowed",
        3: "network unreachable",
        4: "host unreachable",
        5: "connection refused",
        6: "TTL expired",
        7: "command not supported",
        8: "address type not supported",
    }.get(rep, "unknown")


def _http_get_via_socket(wrapped, host, path):
    """Send a minimal HTTP/1.1 GET on an already-connected (and TLS-wrapped)
    socket. Returns (status_code, headers_dict, body_bytes)."""
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        f"User-Agent: torhole-leak-test/1.0\r\n"
        f"Accept: application/json\r\n"
        f"Connection: close\r\n"
        f"\r\n"
    ).encode("ascii")
    wrapped.sendall(request)

    buf = b""
    while True:
        try:
            chunk = wrapped.recv(8192)
        except (ssl.SSLZeroReturnError, OSError):
            break
        if not chunk:
            break
        buf += chunk
        if len(buf) > 131072:
            break

    head, _, body = buf.partition(b"\r\n\r\n")
    head_text = head.decode("iso-8859-1")
    lines = head_text.split("\r\n")
    if not lines:
        raise RuntimeError("empty HTTP response")
    status_line = lines[0]
    parts = status_line.split(" ", 2)
    status_code = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else 0

    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()

    if headers.get("transfer-encoding", "").lower() == "chunked":
        body = _decode_chunked(body)

    return status_code, headers, body


def _decode_chunked(body):
    """Minimal HTTP/1.1 chunked transfer-encoding decoder."""
    out = bytearray()
    offset = 0
    while offset < len(body):
        line_end = body.find(b"\r\n", offset)
        if line_end < 0:
            break
        size_line = body[offset:line_end]
        try:
            size = int(size_line.split(b";", 1)[0].strip(), 16)
        except ValueError:
            break
        offset = line_end + 2
        if size == 0:
            break
        if offset + size > len(body):
            break
        out.extend(body[offset:offset + size])
        offset += size + 2  # skip CRLF after the chunk
    return bytes(out)


def run_leak_test():
    """Connect via tor:9050 SOCKS5 to check.torproject.org/api/ip and check
    IsTor=true. Returns a result dict suitable for store_leak_test_result()
    and the snapshot. Always returns a result — never raises."""
    started_at = time.monotonic()
    started_iso = utc_now()

    sock = None
    wrapped = None
    try:
        sock = _socks5_connect(
            socks_host=TOR_SOCKS_HOST,
            socks_port=TOR_SOCKS_PORT,
            dest_host=LEAK_TEST_TARGET_HOST,
            dest_port=443,
            username="leaktest",
            password="x",
            timeout=LEAK_TEST_TIMEOUT_S,
        )
        ssl_ctx = ssl.create_default_context()
        wrapped = ssl_ctx.wrap_socket(sock, server_hostname=LEAK_TEST_TARGET_HOST)
        status, _headers, body = _http_get_via_socket(
            wrapped, LEAK_TEST_TARGET_HOST, LEAK_TEST_TARGET_PATH
        )
        if status != 200:
            return {
                "pass": False,
                "is_tor": False,
                "ip": None,
                "target": f"https://{LEAK_TEST_TARGET_HOST}{LEAK_TEST_TARGET_PATH}",
                "ran_at": started_iso,
                "duration_ms": int((time.monotonic() - started_at) * 1000),
                "error": f"HTTP {status} from leak-test target",
            }
        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return {
                "pass": False,
                "is_tor": False,
                "ip": None,
                "target": f"https://{LEAK_TEST_TARGET_HOST}{LEAK_TEST_TARGET_PATH}",
                "ran_at": started_iso,
                "duration_ms": int((time.monotonic() - started_at) * 1000),
                "error": f"failed to parse JSON: {exc}",
            }
        is_tor = bool(data.get("IsTor"))
        ip = data.get("IP")
        return {
            "pass": is_tor,
            "is_tor": is_tor,
            "ip": ip,
            "target": f"https://{LEAK_TEST_TARGET_HOST}{LEAK_TEST_TARGET_PATH}",
            "ran_at": started_iso,
            "duration_ms": int((time.monotonic() - started_at) * 1000),
            "error": None if is_tor else "leak detected: response says IsTor=false",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "pass": False,
            "is_tor": False,
            "ip": None,
            "target": f"https://{LEAK_TEST_TARGET_HOST}{LEAK_TEST_TARGET_PATH}",
            "ran_at": started_iso,
            "duration_ms": int((time.monotonic() - started_at) * 1000),
            "error": f"{exc.__class__.__name__}: {exc}",
        }
    finally:
        for s in (wrapped, sock):
            if s is not None:
                try:
                    s.close()
                except OSError:
                    pass


# ---------------------------------------------------------------------------
# Live query feed — Server-Sent Events stream of Pi-hole DNS queries.
#
# Each SSE connection independently polls all 3 Pi-holes for /api/queries.
# We cache the Pi-hole SID per plane in module state so the polling loop
# doesn't auth + logout on every cycle (which would also defeat the session
# leak fix in probe_pihole_api). The SID is invalidated and refreshed on
# 401, which happens when Pi-hole expires the session (~30 min idle).
#
# Pi-hole status codes are mapped to four normalized buckets so the UI can
# render them with consistent colors:
#   blocked   - GRAVITY, REGEX, DENYLIST, EXTERNAL_BLOCKED_*
#   forwarded - FORWARDED, RETRIED, RETRIED_DNSSEC
#   cached    - CACHE, CACHE_STALE
#   other     - everything else (UNKNOWN, IN_PROGRESS, etc.)
# ---------------------------------------------------------------------------

QUERY_FEED_INITIAL_N = int(os.environ.get("TORHOLE_QUERY_FEED_INITIAL_N", "30"))
QUERY_FEED_POLL_S = float(os.environ.get("TORHOLE_QUERY_FEED_POLL_S", "2"))
QUERY_FEED_BATCH_N = int(os.environ.get("TORHOLE_QUERY_FEED_BATCH_N", "20"))


def store_leak_test_result(result):
    """Append a leak test result to the in-memory ring buffer. Older entries
    are dropped when the buffer exceeds LEAK_TEST_HISTORY_MAX."""
    with _LEAK_TEST_LOCK:
        _LEAK_TEST_HISTORY.append(result)
        if len(_LEAK_TEST_HISTORY) > LEAK_TEST_HISTORY_MAX:
            del _LEAK_TEST_HISTORY[: len(_LEAK_TEST_HISTORY) - LEAK_TEST_HISTORY_MAX]


def get_leak_test_state():
    """Return the leak test block for the snapshot. Includes the last result,
    a small recent-window pass rate, the history count, and the last N
    results as a slim history (pass + ran_at only) so the UI can draw a
    sparkline without a separate API call."""
    with _LEAK_TEST_LOCK:
        history = list(_LEAK_TEST_HISTORY)
    if not history:
        return {
            "available": True,
            "reason": None,
            "last_result": None,
            "last_run_at": None,
            "history_count": 0,
            "recent_pass_rate": None,
            "history": [],
        }
    last = history[-1]
    recent = history[-20:]
    passed = sum(1 for r in recent if r.get("pass"))
    rate = passed / len(recent) if recent else None
    slim_history = [
        {"pass": bool(r.get("pass")), "ran_at": r.get("ran_at")}
        for r in history[-30:]
    ]
    return {
        "available": True,
        "reason": None,
        "last_result": last,
        "last_run_at": last.get("ran_at"),
        "history_count": len(history),
        "recent_pass_rate": rate,
        "history": slim_history,
    }


def get_tor_circuits(values):
    """Read live Tor circuit info via the control port at tor:9051.

    Returns a dict shaped for the snapshot:
      {
        "available": bool,
        "reason": str | None,        # set when available is False
        "items": [...],              # all circuits
        "by_plane": {plane_id: [...]}, # circuits with SOCKS_USERNAME=plane_id
        "count": int,
        "fetched_at": iso8601,
      }
    """
    password = values.get("TOR_CONTROL_PASSWORD", "")
    if not password:
        return {
            "available": False,
            "reason": "TOR_CONTROL_PASSWORD not set in .env",
            "items": [],
            "by_plane": {"trusted": [], "iot": []},
            "count": 0,
            "fetched_at": utc_now(),
        }

    sock = None
    try:
        sock = socket.create_connection(
            (TOR_CONTROL_HOST, TOR_CONTROL_PORT),
            timeout=TOR_CONTROL_TIMEOUT_S,
        )
        sock.settimeout(TOR_CONTROL_TIMEOUT_S)
        # AUTHENTICATE quotes the password — escape any embedded quotes.
        safe_pw = password.replace("\\", "\\\\").replace('"', '\\"')
        sock.sendall(f'AUTHENTICATE "{safe_pw}"\r\n'.encode())
        auth_resp = _tor_recv_response(sock)
        if "250 OK" not in auth_resp:
            return {
                "available": False,
                "reason": f"Tor control auth failed: {auth_resp.strip()[:100]}",
                "items": [],
                "by_plane": {"trusted": [], "iot": []},
                "count": 0,
                "fetched_at": utc_now(),
            }

        sock.sendall(b"GETINFO circuit-status\r\n")
        circuit_resp = _tor_recv_response(sock)
        try:
            sock.sendall(b"QUIT\r\n")
        except OSError:
            pass
    except Exception as exc:
        return {
            "available": False,
            "reason": f"Tor control connection failed: {exc.__class__.__name__}: {exc}",
            "items": [],
            "by_plane": {"trusted": [], "iot": []},
            "count": 0,
            "fetched_at": utc_now(),
        }
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    circuits = _parse_circuit_status(circuit_resp)

    # Group BUILT circuits by SOCKS_USERNAME (which the dnscrypt-proxy
    # IsolateSOCKSAuth assigns per plane). Internal circuits without a SOCKS
    # username (HS_VANGUARDS, etc.) are still in `items` but not bucketed.
    by_plane = {"trusted": [], "iot": []}
    for circ in circuits:
        if circ["state"] != "BUILT":
            continue
        plane = circ.get("socks_username")
        if plane in by_plane:
            by_plane[plane].append(circ["id"])

    return {
        "available": True,
        "reason": None,
        "items": circuits,
        "by_plane": by_plane,
        "count": len(circuits),
        "fetched_at": utc_now(),
    }


# ---------------------------------------------------------------------------
# Tor runtime info — bootstrap %, network liveness, traffic totals, etc.
# Read from tor:9051 via the control port. One connection, one multi-GETINFO,
# parse the reply stream. This is what Prometheus scrapes at /api/metrics/tor
# and what the snapshot exposes at tor.runtime_info.
# ---------------------------------------------------------------------------

# status/bootstrap-phase looks like:
#   NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY="Done"
# We want the integer PROGRESS and the SUMMARY string.
_TOR_BOOTSTRAP_PROGRESS_RE = re.compile(r"PROGRESS=(\d+)")
_TOR_BOOTSTRAP_SUMMARY_RE = re.compile(r'SUMMARY="([^"]*)"')


def get_tor_runtime_info(values):
    """Read Tor runtime status via the control port. Returns a dict shaped
    for the snapshot and /api/metrics/tor:

      {
        "available": bool,
        "reason": str | None,
        "bootstrap_percent": int,          # 0..100
        "bootstrap_summary": str,
        "network_liveness": str,           # "up" | "down" | ""
        "circuit_established": bool,
        "enough_dir_info": bool,
        "version": str,
        "traffic_read_bytes": int,
        "traffic_written_bytes": int,
        "entry_guards_count": int,
        "fetched_at": iso8601,
      }
    """
    empty = {
        "available": False,
        "reason": None,
        "bootstrap_percent": 0,
        "bootstrap_summary": "",
        "network_liveness": "",
        "circuit_established": False,
        "enough_dir_info": False,
        "version": "",
        "traffic_read_bytes": 0,
        "traffic_written_bytes": 0,
        "entry_guards_count": 0,
        "fetched_at": utc_now(),
    }

    password = values.get("TOR_CONTROL_PASSWORD", "")
    if not password:
        empty["reason"] = "TOR_CONTROL_PASSWORD not set in .env"
        return empty

    sock = None
    try:
        sock = socket.create_connection(
            (TOR_CONTROL_HOST, TOR_CONTROL_PORT),
            timeout=TOR_CONTROL_TIMEOUT_S,
        )
        sock.settimeout(TOR_CONTROL_TIMEOUT_S)
        safe_pw = password.replace("\\", "\\\\").replace('"', '\\"')
        sock.sendall(f'AUTHENTICATE "{safe_pw}"\r\n'.encode())
        auth_resp = _tor_recv_response(sock)
        if "250 OK" not in auth_resp:
            empty["reason"] = f"Tor control auth failed: {auth_resp.strip()[:100]}"
            return empty

        # One fat GETINFO for all scalar fields. entry-guards is a multi-line
        # block so we fetch it separately — same connection, second command.
        sock.sendall(
            b"GETINFO status/bootstrap-phase network-liveness "
            b"status/circuit-established status/enough-dir-info "
            b"version traffic/read traffic/written\r\n"
        )
        info_resp = _tor_recv_response(sock)

        sock.sendall(b"GETINFO entry-guards\r\n")
        guards_resp = _tor_recv_response(sock)

        try:
            sock.sendall(b"QUIT\r\n")
        except OSError:
            pass
    except Exception as exc:
        empty["reason"] = f"Tor control connection failed: {exc.__class__.__name__}: {exc}"
        return empty
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    parsed = _parse_getinfo_replies(info_resp)
    guards = _parse_getinfo_replies(guards_resp)

    bootstrap_raw = parsed.get("status/bootstrap-phase", "")
    progress_match = _TOR_BOOTSTRAP_PROGRESS_RE.search(bootstrap_raw)
    summary_match = _TOR_BOOTSTRAP_SUMMARY_RE.search(bootstrap_raw)

    # entry-guards is one guard per line (fingerprint/nickname/state tuple).
    entry_guards_text = guards.get("entry-guards", "").strip()
    entry_guards_count = (
        len([ln for ln in entry_guards_text.splitlines() if ln.strip()])
        if entry_guards_text
        else 0
    )

    def _int(raw):
        try:
            return int(raw.split()[0]) if raw else 0
        except (ValueError, IndexError):
            return 0

    return {
        "available": True,
        "reason": None,
        "bootstrap_percent": int(progress_match.group(1)) if progress_match else 0,
        "bootstrap_summary": summary_match.group(1) if summary_match else "",
        "network_liveness": parsed.get("network-liveness", "").strip().lower(),
        "circuit_established": parsed.get("status/circuit-established", "0").strip() == "1",
        "enough_dir_info": parsed.get("status/enough-dir-info", "0").strip() == "1",
        "version": parsed.get("version", "").strip(),
        "traffic_read_bytes": _int(parsed.get("traffic/read", "")),
        "traffic_written_bytes": _int(parsed.get("traffic/written", "")),
        "entry_guards_count": entry_guards_count,
        "fetched_at": utc_now(),
    }


def render_tor_metrics_prom(runtime_info, circuits_info):
    """Render Tor runtime + circuit data as Prometheus text format. Called by
    GET /api/metrics/tor, which the Prometheus scrape job polls directly.
    """
    lines = []

    def _emit(name, help_text, mtype, value, labels=None):
        lines.append(f"# HELP {name} {help_text}")
        lines.append(f"# TYPE {name} {mtype}")
        if labels:
            label_str = ",".join(f'{k}="{v}"' for k, v in labels.items())
            lines.append(f"{name}{{{label_str}}} {value}")
        else:
            lines.append(f"{name} {value}")

    # Control port reachability — distinct from "Tor is up but degraded" so
    # Prometheus can alert on "no data from Tor" specifically.
    _emit(
        "tor_control_port_up",
        "1 if the backup-manager successfully queried Tor's control port, else 0",
        "gauge",
        1 if runtime_info.get("available") else 0,
    )

    if runtime_info.get("available"):
        _emit(
            "tor_bootstrap_percent",
            "Tor bootstrap progress (0-100, 100 = ready to carry traffic)",
            "gauge",
            runtime_info.get("bootstrap_percent", 0),
        )
        _emit(
            "tor_network_liveness",
            "1 if Tor believes the network is reachable, else 0",
            "gauge",
            1 if runtime_info.get("network_liveness") == "up" else 0,
        )
        _emit(
            "tor_circuit_established",
            "1 if Tor believes it can build new circuits, else 0",
            "gauge",
            1 if runtime_info.get("circuit_established") else 0,
        )
        _emit(
            "tor_enough_dir_info",
            "1 if Tor has enough directory info to build circuits, else 0",
            "gauge",
            1 if runtime_info.get("enough_dir_info") else 0,
        )
        _emit(
            "tor_entry_guards",
            "Number of entry guards currently selected",
            "gauge",
            runtime_info.get("entry_guards_count", 0),
        )
        _emit(
            "tor_traffic_read_bytes_total",
            "Total bytes read via Tor across the lifetime of the running tor process",
            "counter",
            runtime_info.get("traffic_read_bytes", 0),
        )
        _emit(
            "tor_traffic_written_bytes_total",
            "Total bytes written via Tor across the lifetime of the running tor process",
            "counter",
            runtime_info.get("traffic_written_bytes", 0),
        )
        version = runtime_info.get("version", "").strip()
        if version:
            _emit(
                "tor_build_info",
                "Tor version info (constant value of 1, version label carries the build)",
                "gauge",
                1,
                {"version": version},
            )

    # Circuit counts — by state (BUILT/EXTENDED/LAUNCHED/FAILED/CLOSED) and
    # by plane (trusted/iot). Single metric each with labels so Grafana
    # can group/filter however it likes.
    if circuits_info.get("available"):
        state_counts = {}
        for circ in circuits_info.get("items", []):
            state = circ.get("state", "UNKNOWN")
            state_counts[state] = state_counts.get(state, 0) + 1
        lines.append("# HELP tor_circuits Number of circuits in the Tor circuit table, by state")
        lines.append("# TYPE tor_circuits gauge")
        for state, count in sorted(state_counts.items()):
            lines.append(f'tor_circuits{{state="{state}"}} {count}')

        by_plane = circuits_info.get("by_plane", {})
        lines.append(
            "# HELP tor_circuits_by_plane Number of BUILT circuits isolated to each plane via SOCKS_USERNAME"
        )
        lines.append("# TYPE tor_circuits_by_plane gauge")
        for plane in ("trusted", "iot"):
            lines.append(f'tor_circuits_by_plane{{plane="{plane}"}} {len(by_plane.get(plane, []))}')

    # Latest scheduled leak-test result — the alerting-grade privacy proof.
    # torhole_leak_test_pass: 1 = IsTor confirmed via check.torproject.org,
    # 0 = failed or not-tor. torhole_leak_test_age_seconds lets rules catch a
    # stale/stopped scheduler (runs every LEAK_TEST_SCHEDULE_INTERVAL_S).
    with _LEAK_TEST_LOCK:
        last_leak = _LEAK_TEST_HISTORY[-1] if _LEAK_TEST_HISTORY else None
    if last_leak is not None:
        ran_at = parse_iso_datetime(last_leak.get("ran_at"))
        lines.append("# HELP torhole_leak_test_pass 1 if the last leak test confirmed IsTor, else 0")
        lines.append("# TYPE torhole_leak_test_pass gauge")
        lines.append(f"torhole_leak_test_pass {1 if last_leak.get('pass') else 0}")
        if ran_at is not None:
            if ran_at.tzinfo is None:
                ran_at = ran_at.replace(tzinfo=timezone.utc)
            age = max((datetime.now(timezone.utc) - ran_at).total_seconds(), 0.0)
            lines.append("# HELP torhole_leak_test_age_seconds Seconds since the last leak test ran")
            lines.append("# TYPE torhole_leak_test_age_seconds gauge")
            lines.append(f"torhole_leak_test_age_seconds {age:.0f}")

    # Backup posture — lets Prometheus alert when scheduled backups stop
    # happening (BackupStale) instead of the operator noticing "never" on
    # the UI tile weeks later.
    backup_age = _latest_backup_age_seconds()
    interval_h, _keep = _backup_schedule_config()
    lines.append("# HELP torhole_backup_schedule_interval_hours Configured backup interval (0 = scheduling disabled)")
    lines.append("# TYPE torhole_backup_schedule_interval_hours gauge")
    lines.append(f"torhole_backup_schedule_interval_hours {interval_h:g}")
    if backup_age is not None:
        lines.append("# HELP torhole_last_backup_age_seconds Seconds since the newest backup archive was created")
        lines.append("# TYPE torhole_last_backup_age_seconds gauge")
        lines.append(f"torhole_last_backup_age_seconds {backup_age:.0f}")

    lines.append("")  # trailing newline
    return "\n".join(lines)


def tor_bootstrap_state():
    runtime_status, runtime_detail = container_runtime_state("tor")
    if runtime_status == "offline":
        return {
            "status": "offline",
            "detail": "Tor container is not running, so bootstrap state is unavailable.",
        }

    # Read the full Tor log, not just the tail. Tor emits ~30 lines during
    # bootstrap and then ~1 heartbeat line every 6h; on a long-running container
    # the bootstrap completion line would roll off any small --tail cap and we
    # would falsely report "bootstrap progress not found in logs". Full scan is
    # cheap (under a thousand lines per year in steady state).
    result = run_subprocess(["docker", "logs", "tor"])
    if result.returncode != 0:
        return {"status": runtime_status, "detail": runtime_detail}

    latest_match = None
    latest_heartbeat = None
    for line in result.stderr.splitlines() + result.stdout.splitlines():
        match = TOR_BOOTSTRAP_PATTERN.search(line)
        if match:
            latest_match = match
        heartbeat = TOR_HEARTBEAT_PATTERN.search(line)
        if heartbeat:
            latest_heartbeat = heartbeat

    if latest_match is None:
        return {
            "status": "degraded" if runtime_status == "healthy" else runtime_status,
            "detail": "Tor is running but recent bootstrap progress was not found in logs.",
        }

    percent = int(latest_match.group(1))
    message = latest_match.group(2).rstrip(".")
    heartbeat_detail = ""
    if latest_heartbeat:
        uptime = latest_heartbeat.group(1).strip()
        circuits = latest_heartbeat.group(2)
        heartbeat_detail = f" Latest heartbeat reports {circuits} circuits open after {uptime} uptime."
    if percent >= 100:
        return {"status": "healthy", "detail": f"Bootstrapped 100%. {message}.{heartbeat_detail}"}
    return {"status": "degraded", "detail": f"Bootstrapped {percent}%. {message}.{heartbeat_detail}"}


def tor_isolation_config_state():
    torrc_path = ROOT_DIR / "tor/torrc"
    if not torrc_path.exists():
        return {"status": "offline", "detail": "Tor config file is missing."}

    torrc = torrc_path.read_text(encoding="utf-8")
    has_isolation = bool(re.search(r"^SocksPort\s+.+\s+IsolateSOCKSAuth\b", torrc, re.MULTILINE))
    reject_all = "SocksPolicy reject *" in torrc
    allowed_sources = len(re.findall(r"^SocksPolicy accept ", torrc, re.MULTILINE))

    if has_isolation and reject_all and allowed_sources >= 3:
        return {
            "status": "healthy",
            "detail": f"Tor SOCKS uses IsolateSOCKSAuth with {allowed_sources} explicit allowed sources.",
        }

    issues = []
    if not has_isolation:
        issues.append("IsolateSOCKSAuth is missing")
    if not reject_all:
        issues.append("default reject policy is missing")
    if allowed_sources < 3:
        issues.append("expected SOCKS source allowlist is incomplete")
    return {
        "status": "degraded",
        "detail": "; ".join(issues) + ".",
    }


def dnscrypt_identity_state(values):
    planes = []
    identities = {}
    duplicates = set()

    active_planes = [("trusted", "Flat LAN" if TORHOLE_TOPOLOGY == "single-lan" else "Trusted")]
    if TORHOLE_TOPOLOGY == "vlan":
        active_planes.append(("iot", "IoT"))
    for plane_id, label in active_planes:
        user = values.get(f"DNSCRYPT_SOCKS_USER_{plane_id.upper()}", "").strip()
        password = values.get(f"DNSCRYPT_SOCKS_PASS_{plane_id.upper()}", "").strip()
        config_path = ROOT_DIR / f"dnscrypt/{plane_id}/dnscrypt-proxy.toml"
        proxy_targets_tor = False
        if config_path.exists():
            config_text = config_path.read_text(encoding="utf-8")
            proxy_targets_tor = bool(re.search(r"^proxy = 'socks5://.*@tor:9050'", config_text, re.MULTILINE))

        if not user or not password:
            planes.append(
                {
                    "id": plane_id,
                    "label": label,
                    "status": "offline",
                    "detail": "SOCKS identity is not fully configured in .env.",
                }
            )
            continue

        identity_key = (user, password)
        if identity_key in identities:
            duplicates.add(plane_id)
            duplicates.add(identities[identity_key])
        else:
            identities[identity_key] = plane_id

        detail = "Dedicated SOCKS identity configured."
        status = "healthy"
        if proxy_targets_tor:
            detail += " dnscrypt is configured to proxy through tor:9050."
        else:
            status = "degraded"
            detail += " Rendered dnscrypt proxy target does not confirm tor:9050."

        planes.append({"id": plane_id, "label": label, "status": status, "detail": detail})

    if duplicates:
        for plane in planes:
            if plane["id"] in duplicates and plane["status"] != "offline":
                plane["status"] = "degraded"
                plane["detail"] = "SOCKS identity is duplicated across planes."

    counts = {"healthy": 0, "degraded": 0, "offline": 0, "total": len(planes)}
    for plane in planes:
        counts[plane["status"]] += 1

    overall_status = combine_statuses(*(plane["status"] for plane in planes))
    if overall_status == "healthy":
        summary = f"{len(planes)} dedicated SOCKS identity or identities are configured for the active DNS plane(s)."
    elif duplicates:
        summary = "Plane isolation is weakened because at least one SOCKS identity is reused."
    else:
        summary = "Plane isolation evidence is incomplete."

    return {
        "overall_status": overall_status,
        "summary": summary,
        "counts": counts,
        "planes": planes,
    }


def tor_network_path_state():
    dnscrypt_containers = ["dnscrypt-trusted"]
    if TORHOLE_TOPOLOGY == "vlan":
        dnscrypt_containers.append("dnscrypt-iot")
    inspected = [inspect_container(name) for name in dnscrypt_containers]
    tor_payload = inspect_container("tor")

    if tor_payload is None or any(payload is None for payload in inspected):
        return {
            "status": "offline",
            "detail": "Runtime network verification is unavailable until the Tor and dnscrypt containers are running.",
        }

    dnscrypt_ok = True
    for payload in inspected:
        networks = set((payload.get("NetworkSettings") or {}).get("Networks", {}).keys())
        if len(networks) != 1 or not any(name.endswith("dns_int") or name == "dns_int" for name in networks):
            dnscrypt_ok = False
            break

    tor_networks = set((tor_payload.get("NetworkSettings") or {}).get("Networks", {}).keys())
    tor_ok = any(name.endswith("dns_int") or name == "dns_int" for name in tor_networks) and any(
        name.endswith("tor_out") or name == "tor_out" for name in tor_networks
    )

    if dnscrypt_ok and tor_ok:
        return {
            "status": "healthy",
            "detail": "Every active dnscrypt plane is attached only to dns_int, and Tor is the bridge to tor_out.",
        }

    return {
        "status": "degraded",
        "detail": "Container network attachments do not match the expected Tor-only egress model.",
    }


def build_tor_assurance(values):
    bootstrap = tor_bootstrap_state()
    isolation = tor_isolation_config_state()
    identities = dnscrypt_identity_state(values)
    network_path = tor_network_path_state()

    overall_status = combine_statuses(
        bootstrap["status"],
        isolation["status"],
        identities["overall_status"],
        network_path["status"],
    )

    if overall_status == "healthy":
        summary = "Tor is bootstrapped and the isolation posture is intact across every active DNS plane."
    elif bootstrap["status"] == "offline":
        summary = "Tor runtime is offline. Configuration evidence is still available, but live privacy guarantees are not active."
    else:
        summary = "Tor assurance needs attention. At least one runtime or isolation signal is degraded."

    return {
        "overall_status": overall_status,
        "summary": summary,
        "bootstrap": bootstrap,
        "isolation": isolation,
        "plane_identities": identities,
        "network_path": network_path,
    }


def build_services_snapshot(values):
    links = build_public_links(values)
    services = []

    for service in SERVICE_CATALOG:
        status, detail = container_runtime_state(service["container"])
        payload = {
            "id": service["id"],
            "label": service["label"],
            "status": status,
            "detail": detail,
        }
        url = links.get(service.get("link_key", ""))
        if url:
            payload["url"] = url
        services.append(payload)

    return services, links


def summarize_plane_api_health(values):
    planes = [probe_pihole_api(target, values) for target in PIHOLE_API_TARGETS]
    counts = {"healthy": 0, "degraded": 0, "offline": 0, "total": len(planes)}
    for plane in planes:
        state = plane.get("status", "offline")
        if state not in counts:
            state = "offline"
        counts[state] += 1

    overall_status = "healthy"
    if counts["offline"] > 0:
        overall_status = "offline"
    elif counts["degraded"] > 0:
        overall_status = "degraded"

    return {
        "overall_status": overall_status,
        "counts": counts,
        "planes": planes,
    }


def compose_status_sentence(overall_status, plane_api, recovery, notifications):
    plane_total = plane_api["counts"].get("total", 0)
    stack_text = (
        f"Torhole is routing {plane_total} active DNS plane(s) through Tor."
        if overall_status == "healthy"
        else "Torhole is routing DNS through a degraded privacy stack."
        if overall_status == "degraded"
        else "Torhole is not fully healthy and needs attention."
    )

    plane_counts = plane_api["counts"]
    plane_text = (
        f"{plane_counts['healthy']}/{plane_counts['total']} Pi-hole APIs reachable."
        if plane_counts["total"]
        else "Pi-hole API health is unavailable."
    )

    latest_backup = recovery.get("latest_archive")
    backup_finished = recovery.get("finished_at")
    backup_text = (
        f"Last recovery event {humanize_time_ago(backup_finished)}."
        if backup_finished
        else f"Latest backup available: {latest_backup}."
        if latest_backup
        else "No backup archive has been created yet."
    )

    enabled = notifications.get("enabled_channels", 0)
    configured = notifications.get("configured_channels", 0)
    alert_text = (
        f"{enabled}/{configured} alert channels active."
        if configured
        else "No alert channels configured yet."
    )

    return " ".join([stack_text, plane_text, backup_text, alert_text])


def detect_validation_checks():
    checks = []
    for check_id, label, marker in VALIDATION_MARKERS:
        if check_id == "authelia_config" and not (ROOT_DIR / "monitoring/authelia/configuration.yml").exists():
            continue
        if check_id == "alloy_config" and not (ROOT_DIR / "monitoring/alloy/config.alloy").exists():
            continue
        if check_id == "pihole_exporter_python" and not (ROOT_DIR / "monitoring/pihole-exporter/exporter.py").exists():
            continue
        if check_id == "backup_manager_python" and not (ROOT_DIR / "monitoring/backup-manager/server.py").exists():
            continue
        checks.append({"id": check_id, "label": label, "marker": marker})
    return checks


def parse_validation_checks(output, returncode):
    expected = detect_validation_checks()
    marker_map = {check["marker"]: check for check in expected}
    seen = []

    for line in output.splitlines():
        stripped = line.strip()
        if not stripped.startswith("[validate] "):
            continue
        marker = stripped[len("[validate] ") :].strip()
        check = marker_map.get(marker)
        if check:
            seen.append(check["id"])

    failed_id = seen[-1] if returncode != 0 and seen else None
    checks = []

    for check in expected:
        check_status = "skipped"
        if check["id"] in seen:
            check_status = "error" if check["id"] == failed_id else "success"
        elif returncode == 0:
            check_status = "success"
        checks.append({"id": check["id"], "label": check["label"], "status": check_status})

    return checks


def validation_summary(checks, success):
    if success:
        return "Stack configuration validated successfully."

    failed = next((check for check in checks if check["status"] == "error"), None)
    if failed:
        return f"Validation failed at {failed['label']}."
    return "Validation failed."


def build_recovery_summary(backups=None):
    """Build the recovery summary block.

    Pass an already-computed backups list to avoid re-listing (which is slow
    on large tarballs even with metadata caching, since list_backups still
    stat()s every file).
    """
    status = read_status()
    if backups is None:
        backups = list_backups()
    latest = backups[0]["name"] if backups else status.get("archive")
    return {
        "status": status.get("status", "idle"),
        "latest_archive": latest,
        "finished_at": status.get("finished_at"),
    }


def build_notification_summary():
    try:
        channels = get_notification_channels()
    except FileNotFoundError:
        channels = []

    configured = sum(1 for channel in channels if channel.get("configured"))
    enabled = sum(1 for channel in channels if channel.get("enabled"))
    return {
        "total_channels": len(channels),
        "configured_channels": configured,
        "enabled_channels": enabled,
    }


_CORE_DNS_CONTAINERS = frozenset(
    {"tor", "dnscrypt-trusted", "pihole_trusted"}
    | ({"dnscrypt-iot", "pihole_iot"} if TORHOLE_TOPOLOGY == "vlan" else set())
)
_ALLOWED_ACTIONS = frozenset({"restart", "start", "stop"})


def get_services_detail():
    """Return SERVICE_CATALOG enriched with restart_count and started_at from docker inspect."""
    services = []
    for service in SERVICE_CATALOG:
        status, detail = container_runtime_state(service["container"])
        payload = inspect_container(service["container"])
        restart_count = None
        started_at = None
        if payload:
            state = payload.get("State", {})
            restart_count = payload.get("RestartCount")
            started_at = state.get("StartedAt")
        services.append({
            "id": service["id"],
            "label": service["label"],
            "container": service["container"],
            "status": status,
            "detail": detail,
            "restart_count": restart_count,
            "started_at": started_at,
            "core": service["container"] in _CORE_DNS_CONTAINERS,
        })
    return services


def service_action(service_id, action):
    """Run docker start/stop/restart on the named service container."""
    service = next((s for s in SERVICE_CATALOG if s["id"] == service_id), None)
    if service is None:
        raise ValueError(f"Unknown service id: {service_id!r}")
    if action not in _ALLOWED_ACTIONS:
        raise ValueError(f"Unknown action: {action!r}. Allowed: {', '.join(sorted(_ALLOWED_ACTIONS))}")
    result = run_subprocess(["docker", action, service["container"]])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"docker {action} failed")
    return service["container"]


def get_config_values():
    """Return active .env parameters with secrets masked.

    Stale values for inactive capability profiles remain safely preserved in
    .env, but are intentionally absent from the installed admin dashboard.
    """
    values = read_env_values()
    values = {**PUBLIC_HOST_DEFAULTS, **values}
    masked = {}
    for key, value in values.items():
        if not config_key_is_active(key):
            continue
        if _SECRET_KEYS.search(key):
            masked[key] = "***" if value and value != "CHANGE_ME" else value
        else:
            masked[key] = value
    return masked


def set_config_value(key, value, force=False):
    """Update a single .env key. Rejects secret keys unless force=True.
    Goes through update_env_keys() so the write is atomic and a timestamped
    backup is taken before every change (see architecture.md §backup-manager).
    """
    if not re.match(r"^[A-Z][A-Z0-9_]*$", key):
        raise ValueError("Key must be uppercase alphanumeric with underscores.")
    if not config_key_is_active(key):
        raise ValueError(
            f"{key!r} is not active in the {TORHOLE_TOPOLOGY!r} topology."
        )
    try:
        update_env_keys({key: value}, allow_secret_keys=force)
    except ValueError as exc:
        # update_env_keys has its own secret-key rejection, but its error
        # message ("use the dedicated helper...") is wrong advice for the
        # /api/config caller that reached us — they need to know to pass
        # force=true, not to switch to some other helper. Re-raise with the
        # actionable message for this context.
        if _SECRET_KEYS.search(key) and not force:
            raise ValueError(
                f"{key!r} is a secret key. Pass force=true to update it."
            ) from exc
        raise
    return get_config_values()


# Query insights (T-061): top domains / top blocked / top clients per plane
# from the Pi-hole v6 stats API. Cached briefly — these are ranking tables,
# not live telemetry, and each refresh costs three Pi-hole calls per plane.
_INSIGHTS_CACHE = {"data": None, "expires_at": 0.0}
_INSIGHTS_CACHE_LOCK = threading.Lock()
_INSIGHTS_CACHE_TTL_S = 60.0


def _normalize_top_domains(payload):
    """Pi-hole v6 /stats/top_domains -> [{name, count}] (defensive)."""
    items = []
    for entry in (payload or {}).get("domains", []) or []:
        if not isinstance(entry, dict):
            continue
        name = entry.get("domain")
        if not name:
            continue
        items.append({"name": name, "count": int(entry.get("count", 0) or 0)})
    return items


def _normalize_top_clients(payload):
    """Pi-hole v6 /stats/top_clients -> [{ip, name, count}] (defensive)."""
    items = []
    for entry in (payload or {}).get("clients", []) or []:
        if not isinstance(entry, dict):
            continue
        ip = entry.get("ip")
        if not ip:
            continue
        items.append(
            {
                "ip": ip,
                "name": entry.get("name") or None,
                "count": int(entry.get("count", 0) or 0),
            }
        )
    return items


def get_dns_insights(force=False):
    """Per-plane ranking tables for the admin UI. Never raises; a plane that
    can't be queried comes back with available=False and empty lists."""
    now = time.time()
    with _INSIGHTS_CACHE_LOCK:
        cached = _INSIGHTS_CACHE["data"]
        if not force and cached is not None and now < _INSIGHTS_CACHE["expires_at"]:
            return cached

    values = read_env_values_safe()
    planes = []
    for target in PIHOLE_API_TARGETS:
        top = _pihole_get_with_cached_sid(target, values, "/stats/top_domains?count=10")
        blocked = _pihole_get_with_cached_sid(
            target, values, "/stats/top_domains?blocked=true&count=10"
        )
        clients = _pihole_get_with_cached_sid(target, values, "/stats/top_clients?count=10")
        planes.append(
            {
                "id": target["id"],
                "label": target["label"],
                "available": any(p is not None for p in (top, blocked, clients)),
                "top_domains": _normalize_top_domains(top),
                "top_blocked": _normalize_top_domains(blocked),
                "top_clients": _normalize_top_clients(clients),
            }
        )

    result = {"planes": planes, "generated_at": utc_now()}
    with _INSIGHTS_CACHE_LOCK:
        _INSIGHTS_CACHE["data"] = result
        _INSIGHTS_CACHE["expires_at"] = now + _INSIGHTS_CACHE_TTL_S
    return result


def get_dns_stats():
    """Return per-plane Pi-hole block statistics from the Pi-hole API."""
    values = read_env_values_safe()
    planes = []
    for target in PIHOLE_API_TARGETS:
        base_url = values.get(target["url_key"], target["default_url"])
        password = values.get(target["password_key"], "")
        if not password:
            planes.append({"id": target["id"], "label": target["label"], "status": "offline", "detail": "No password configured."})
            continue
        sid = None
        try:
            login_payload = json.dumps({"password": password}).encode("utf-8")
            login = pihole_api_call(base_url, "/auth", method="POST", data=login_payload, headers={"Content-Type": "application/json"})
            sid = login["session"]["sid"]
            summary = pihole_api_call(base_url, "/stats/summary", headers={"X-FTL-SID": sid})
            q = summary.get("queries", {})
            planes.append({
                "id": target["id"],
                "label": target["label"],
                "status": "healthy",
                "queries_today": q.get("total", 0),
                "blocked_today": q.get("blocked", 0),
                "percent_blocked": round(q.get("percent_blocked", 0), 1),
                "domains_on_blocklist": summary.get("gravity", {}).get("domains_being_blocked", 0),
            })
        except HTTPError as exc:
            planes.append({"id": target["id"], "label": target["label"], "status": "degraded", "detail": f"HTTP {exc.code}"})
        except Exception as exc:  # noqa: BLE001
            planes.append({"id": target["id"], "label": target["label"], "status": "offline", "detail": str(exc)})
        finally:
            pihole_logout(base_url, sid)
    return {"planes": planes, "generated_at": utc_now()}


def system_status_payload():
    values = read_env_values_safe()
    services, links = build_services_snapshot(values)
    counts = service_counts(services)
    plane_api = summarize_plane_api_health(values)
    tor_assurance = build_tor_assurance(values)
    recovery = build_recovery_summary()
    notifications = build_notification_summary()
    overall_status = overall_status_from_counts(counts)
    if plane_api["overall_status"] == "offline":
        overall_status = "offline"
    elif plane_api["overall_status"] == "degraded" and overall_status == "healthy":
        overall_status = "degraded"
    if tor_assurance["overall_status"] == "offline":
        overall_status = "offline"
    elif tor_assurance["overall_status"] == "degraded" and overall_status == "healthy":
        overall_status = "degraded"

    return {
        "generated_at": utc_now(),
        "overall_status": overall_status,
        "summary": summary_from_counts(counts),
        "status_sentence": compose_status_sentence(overall_status, plane_api, recovery, notifications),
        "services": services,
        "links": links,
        "service_counts": counts,
        "pihole_api": plane_api,
        "tor_assurance": tor_assurance,
        "last_validation": read_validation_result(),
        "recovery": recovery,
        "notifications": notifications,
    }


# ---------------------------------------------------------------------------
# /api/system/snapshot — single source of truth for the admin UI.
#
# Every screen in the new UI reads from this one shape. Cached server-side for
# SNAPSHOT_CACHE_TTL_S to prevent thundering-herd against the Pi-hole API and
# the docker daemon when multiple components on a page hit it concurrently.
#
# Schema is versioned (schema_version) so the UI can guard against drift.
# ---------------------------------------------------------------------------

SNAPSHOT_SCHEMA_VERSION = 1
SNAPSHOT_CACHE_TTL_S = float(os.environ.get("TORHOLE_SNAPSHOT_TTL_S", "2"))

_SNAPSHOT_CACHE = {"data": None, "expires_at": 0.0}
_SNAPSHOT_CACHE_LOCK = threading.Lock()
_SNAPSHOT_COMPUTE_LOCK = threading.Lock()


def build_snapshot(force=False):
    """Return the unified system snapshot. Cached SNAPSHOT_CACHE_TTL_S seconds.

    Pass force=True to bypass the cache (used by SSE endpoints when they need
    a known-fresh value to compute a diff).
    """
    if not force:
        with _SNAPSHOT_CACHE_LOCK:
            cached = _SNAPSHOT_CACHE["data"]
            if cached is not None and _SNAPSHOT_CACHE["expires_at"] > time.monotonic():
                return cached

    # Serialize concurrent computes so we never hit pi-hole 3x in parallel for
    # the same snapshot, but allow concurrent reads of an unexpired cache above.
    with _SNAPSHOT_COMPUTE_LOCK:
        with _SNAPSHOT_CACHE_LOCK:
            cached = _SNAPSHOT_CACHE["data"]
            if not force and cached is not None and _SNAPSHOT_CACHE["expires_at"] > time.monotonic():
                return cached

        data = _compute_snapshot()

        with _SNAPSHOT_CACHE_LOCK:
            _SNAPSHOT_CACHE["data"] = data
            _SNAPSHOT_CACHE["expires_at"] = time.monotonic() + SNAPSHOT_CACHE_TTL_S

    return data


def _compose_snapshot_headline(privacy_intact, overall_status, plane_counts, container_counts):
    """Single-line headline for the admin UI hero. Privacy is always the lead."""
    healthy_planes = plane_counts.get("healthy", 0)
    total_planes = plane_counts.get("total", 0)
    offline_containers = container_counts.get("offline", 0)
    degraded_containers = container_counts.get("degraded", 0)

    if not privacy_intact:
        return "Privacy guarantee compromised — needs immediate attention."

    if overall_status == "healthy":
        return f"Privacy guarantee intact. {healthy_planes}/{total_planes} DNS planes serving via Tor."

    issues = []
    if offline_containers:
        issues.append(f"{offline_containers} container{'s' if offline_containers != 1 else ''} offline")
    if degraded_containers:
        issues.append(f"{degraded_containers} container{'s' if degraded_containers != 1 else ''} degraded")
    issue_text = " and ".join(issues) if issues else "some services need attention"

    return f"Privacy guarantee intact, but {issue_text}."


_BANNER_LEVELS = frozenset({"critical", "warning", "info"})


def _compose_banner(values):
    """Operator-configured environment banner for the admin UI (e.g. to mark a
    staging instance). Driven by TORHOLE_BANNER_TEXT + TORHOLE_BANNER_LEVEL
    in .env — read live on every snapshot, so editing .env changes the banner
    without recreating any container. Returns None when no text is set."""
    text = (values.get("TORHOLE_BANNER_TEXT") or "").strip()
    if not text:
        return None
    level = (values.get("TORHOLE_BANNER_LEVEL") or "info").strip().lower()
    if level not in _BANNER_LEVELS:
        level = "info"
    return {"text": text, "level": level}


def _compute_snapshot():
    values = read_env_values_safe()

    # One probe per pi-hole. get_dns_stats already returns status + queries_today
    # + blocked_today; we synthesize the plane summary and counts from its output
    # rather than calling summarize_plane_api_health (which would re-probe).
    dns_stats = get_dns_stats()

    plane_counts = {"healthy": 0, "degraded": 0, "offline": 0, "total": len(dns_stats["planes"])}
    queries_today = 0
    blocked_today = 0
    for plane in dns_stats["planes"]:
        state = plane.get("status", "offline")
        if state not in plane_counts:
            state = "offline"
        plane_counts[state] += 1
        if state == "healthy":
            queries_today += int(plane.get("queries_today", 0) or 0)
            blocked_today += int(plane.get("blocked_today", 0) or 0)

    if plane_counts["offline"] > 0:
        plane_overall = "offline"
    elif plane_counts["degraded"] > 0:
        plane_overall = "degraded"
    else:
        plane_overall = "healthy"

    block_pct = round((blocked_today / queries_today) * 100, 1) if queries_today else 0.0

    services_detail = get_services_detail()
    container_counts = {"healthy": 0, "degraded": 0, "offline": 0, "total": len(services_detail)}
    for service in services_detail:
        state = service.get("status", "offline")
        if state not in container_counts:
            state = "offline"
        container_counts[state] += 1

    tor_assurance = build_tor_assurance(values)
    tor_circuits = get_tor_circuits(values)
    tor_runtime_info = get_tor_runtime_info(values)
    notifications = build_notification_summary()
    validation = read_validation_result()
    backups = list_backups()
    recovery = build_recovery_summary(backups=backups)

    # Overall status: combine container, plane, and tor signals.
    overall_status = "healthy"
    if container_counts["offline"] > 0:
        overall_status = "offline"
    elif container_counts["degraded"] > 0:
        overall_status = "degraded"
    if plane_overall == "offline":
        overall_status = "offline"
    elif plane_overall == "degraded" and overall_status == "healthy":
        overall_status = "degraded"
    if tor_assurance["overall_status"] == "offline":
        overall_status = "offline"
    elif tor_assurance["overall_status"] == "degraded" and overall_status == "healthy":
        overall_status = "degraded"

    # Privacy intact is stricter than overall_status: it specifically asks
    # whether the privacy guarantee is currently being delivered. We require
    # Tor bootstrapped + isolation healthy + at least one DNS plane serving.
    privacy_intact = (
        tor_assurance["bootstrap"]["status"] == "healthy"
        and tor_assurance["isolation"]["status"] == "healthy"
        and plane_counts["healthy"] > 0
    )

    # Public links for SSO targets, used by the admin UI to link out to grafana etc.
    links = build_public_links(values)

    # Latest backup, slimmed for the snapshot.
    # Prefer metadata.created_at (recorded inside the tarball at backup time)
    # but fall back to the file's modified_at (mtime as ISO) — older backups
    # may not have created_at populated in their metadata.json.
    latest_backup = backups[0] if backups else None
    last_snapshot_at = None
    if latest_backup:
        last_snapshot_at = (
            latest_backup.get("metadata", {}).get("created_at")
            or latest_backup.get("modified_at")
        )
    backup_block = {
        "snapshot_count": len(backups),
        "last_snapshot_name": (latest_backup or {}).get("name"),
        "last_snapshot_at": last_snapshot_at,
        "last_snapshot_size_bytes": (latest_backup or {}).get("size_bytes"),
    }

    # Slim container list for snapshot consumers; full detail still on /api/services
    containers = [
        {
            "id": s["id"],
            "name": s["container"],
            "label": s["label"],
            "status": s["status"],
            "started_at": s["started_at"],
            "restart_count": s["restart_count"],
            "core": s["core"],
        }
        for s in services_detail
    ]

    return {
        "schema_version": SNAPSHOT_SCHEMA_VERSION,
        "generated_at": utc_now(),
        # Optional operator banner (env-driven, live-reloaded) — see _compose_banner.
        "banner": _compose_banner(values),
        "torhole": {
            "overall_status": overall_status,
            "privacy_intact": privacy_intact,
            # Headline: privacy_intact is the lead, container issues are secondary.
            # This avoids the legacy contradiction of "not fully healthy" when
            # the actual privacy guarantee is intact and only an ancillary
            # container is degraded.
            "headline": _compose_snapshot_headline(
                privacy_intact, overall_status, plane_counts, container_counts
            ),
            # Legacy sentence kept for backwards-compat with /api/system/status
            # consumers. Do not use in the admin UI.
            "summary_sentence": compose_status_sentence(
                overall_status,
                {"counts": plane_counts, "overall_status": plane_overall, "planes": dns_stats["planes"]},
                recovery,
                notifications,
            ),
        },
        "tor": {
            "overall_status": tor_assurance["overall_status"],
            "summary": tor_assurance["summary"],
            "bootstrap": tor_assurance["bootstrap"],
            "isolation": tor_assurance["isolation"],
            "network_path": tor_assurance["network_path"],
            "plane_identities": tor_assurance["plane_identities"],
            # Live circuit info from the Tor control port at tor:9051. Each
            # entry has the full path (entry → middle → exit) and the
            # SOCKS_USERNAME (which dnscrypt-proxy uses for IsolateSOCKSAuth)
            # so the UI can correlate circuits to planes.
            "circuits": tor_circuits,
            # Live runtime info from the same control port — bootstrap
            # percent, network liveness, traffic totals, entry guard count.
            # The same data is also exposed at /api/metrics/tor in
            # Prometheus text format.
            "runtime_info": tor_runtime_info,
            "last_rotation_at": None,
        },
        "dns": {
            "planes": dns_stats["planes"],
            "counts": plane_counts,
            "overall_status": plane_overall,
            "totals": {
                "queries_today": queries_today,
                "blocked_today": blocked_today,
                "block_pct": block_pct,
            },
        },
        "leak_test": get_leak_test_state(),
        "containers": containers,
        "container_counts": container_counts,
        "backup": backup_block,
        "alerts": {
            "total_channels": notifications.get("total_channels", 0),
            "configured_channels": notifications.get("configured_channels", 0),
            "enabled_channels": notifications.get("enabled_channels", 0),
        },
        "validation": {
            "last_result": validation,
        },
        "recovery": recovery,
        "links": links,
    }


def run_system_validation():
    started_at = utc_now()
    result = run_script(str(ROOT_DIR / "ops/scripts/19-validate-stack.sh"))
    checks = parse_validation_checks(result.stdout, result.returncode)
    payload = {
        "status": "success" if result.returncode == 0 else "error",
        "summary": validation_summary(checks, result.returncode == 0),
        "checks": checks,
        "started_at": started_at,
        "finished_at": utc_now(),
    }

    detail = (result.stderr or "").strip()
    if not detail and result.returncode != 0:
        detail = (result.stdout or "").strip().splitlines()[-1] if (result.stdout or "").strip() else "Validation failed."
    if detail:
        payload["detail"] = detail

    write_validation_result(payload)
    return payload


def validate_alertmanager_config():
    return run_subprocess(["docker", "exec", "alertmanager", "amtool", "check-config", "/etc/alertmanager/alertmanager.yml"])


def reload_alertmanager():
    return run_subprocess(["docker", "kill", "-s", "HUP", "alertmanager"])


def write_file(path: Path, content: str):
    path.write_text(content, encoding="utf-8")


def rollback_notification_state(env_text, config_text):
    # Write via env_store's path so every .env write shares one source of
    # truth (and one test patch point).
    write_file(env_store.ENV_FILE, env_text)
    if config_text:
        write_file(ALERTMANAGER_CONFIG_FILE, config_text)
    run_script(str(ROOT_DIR / "ops/scripts/17-render-alertmanager.sh"))
    reload_alertmanager()


def set_notification_channel(channel_name, enabled):
    if channel_name not in CHANNEL_FIELDS:
        raise ValueError("Unknown notification channel.")

    channel = CHANNEL_FIELDS[channel_name]
    original_env = read_env_text()
    values = parse_env_text(original_env)
    configured = all(values.get(key, "") for key in channel["required_keys"])
    if enabled and not configured:
        raise ValueError(f"{channel['label']} is not configured in .env.")

    original_config = ALERTMANAGER_CONFIG_FILE.read_text(encoding="utf-8") if ALERTMANAGER_CONFIG_FILE.exists() else ""

    # Atomic write with timestamped backup. rollback_notification_state
    # still expects original_env in memory so it can restore on render
    # failure without touching the atomic-helper code path.
    update_env_keys(
        {channel["enabled_key"]: "true" if enabled else "false"},
        allow_secret_keys=False,
    )

    render_result = run_script(str(ROOT_DIR / "ops/scripts/17-render-alertmanager.sh"))
    if render_result.returncode != 0:
        rollback_notification_state(original_env, original_config)
        raise RuntimeError(render_result.stderr or render_result.stdout or "Failed to render Alertmanager config.")

    validate_result = validate_alertmanager_config()
    if validate_result.returncode != 0:
        rollback_notification_state(original_env, original_config)
        raise RuntimeError(validate_result.stderr or validate_result.stdout or "Alertmanager config validation failed.")

    reload_result = reload_alertmanager()
    if reload_result.returncode != 0:
        rollback_notification_state(original_env, original_config)
        raise RuntimeError(reload_result.stderr or reload_result.stdout or "Alertmanager reload failed.")

    return get_notification_channels()


class Handler(BaseHTTPRequestHandler):
    server_version = "TorholeBackupManager/1.0"

    def _require_backend_auth(self):
        if not requires_backend_auth(self.path):
            return True
        if is_backend_request_authorized(self.headers):
            return True

        status = HTTPStatus.UNAUTHORIZED if BACKUP_MANAGER_API_TOKEN else HTTPStatus.SERVICE_UNAVAILABLE
        message = "Unauthorized" if BACKUP_MANAGER_API_TOKEN else "Backend authentication is not configured"
        json_response(self, {"error": message}, status=status)
        return False

    def do_GET(self):
        if not self._require_backend_auth():
            return

        if self.path == "/health":
            return json_response(self, {"status": "ok"})

        if self.path == "/api/recovery":
            return json_response(
                self,
                {
                    "status": read_status(),
                    "backups": list_backups(),
                },
            )

        if self.path == "/api/recovery/system-status":
            return json_response(self, system_status_payload())

        if self.path == "/api/notifications":
            return json_response(
                self,
                {
                    "channels": get_notification_channels(),
                },
            )

        if self.path == "/api/system/status":
            return json_response(self, system_status_payload())

        if self.path == "/api/system/snapshot":
            return json_response(self, build_snapshot())

        if self.path == "/api/metrics/tor":
            # Prometheus text-format scrape endpoint. Unauthenticated, read-only,
            # scraped by the prometheus container from inside dns_int.
            #
            # Use read_env_values_safe() (unmasked) so TOR_CONTROL_PASSWORD
            # reaches the auth call. get_config_values() masks secrets to
            # "***" for UI consumption, which would break the control-port
            # login silently.
            values = read_env_values_safe()
            runtime_info = get_tor_runtime_info(values)
            circuits_info = get_tor_circuits(values)
            body = render_tor_metrics_prom(runtime_info, circuits_info).encode("utf-8")
            try:
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except _CLIENT_GONE_EXCS:
                # Prometheus closes the connection after its scrape timeout
                # (or on shutdown) and lands us here on every reload. Swallow
                # the same way json_response does — the scrape will just miss
                # this cycle, Prometheus retries on the next interval.
                pass
            return

        if self.path == "/api/stream/queries":
            return self._stream_query_feed()

        if self.path.startswith("/api/containers/") and self.path.endswith("/logs"):
            name = self.path[len("/api/containers/"):-len("/logs")]
            return self._stream_container_logs(name)

        if self.path == "/api/services":
            return json_response(self, {"services": get_services_detail()})

        if self.path == "/api/config":
            try:
                return json_response(self, {"config": get_config_values()})
            except FileNotFoundError:
                return json_response(self, {"error": ".env file not found"}, status=HTTPStatus.NOT_FOUND)

        if self.path == "/api/dns/stats":
            return json_response(self, get_dns_stats())

        if self.path == "/api/dns/insights":
            return json_response(self, get_dns_insights())

        if self.path.startswith("/api/recovery/download"):
            query = parse_qs(urlparse(self.path).query)
            archive_name = query.get("archive", [""])[0]
            try:
                archive_path = resolve_backup_archive(archive_name)
            except FileNotFoundError:
                return json_response(self, {"error": "Archive not found"}, status=HTTPStatus.NOT_FOUND)
            except ValueError as exc:
                return json_response(self, {"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

            stat = archive_path.stat()
            try:
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/gzip")
                self.send_header("Content-Disposition", f'attachment; filename="{archive_path.name}"')
                self.send_header("Content-Length", str(stat.st_size))
                self.end_headers()
                with archive_path.open("rb") as handle:
                    while True:
                        chunk = handle.read(1024 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            except _CLIENT_GONE_EXCS:
                # User cancelled the download mid-stream (closed the browser
                # tab, hit the browser's stop button, etc). Nothing to recover;
                # the partial write just stops.
                pass
            return

        return json_response(self, {"error": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def _sse_send(self, payload):
        """Write one SSE event. Returns False if the client disconnected."""
        try:
            line = f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"
            self.wfile.write(line.encode("utf-8"))
            self.wfile.flush()
            return True
        except _CLIENT_GONE_EXCS:
            return False

    def _stream_container_logs(self, container_name):
        """SSE handler for GET /api/containers/{name}/logs.

        Validates that the container is in SERVICE_CATALOG (so an operator
        can't use this to dump arbitrary containers on the host), then
        pipes `docker logs -f --tail 200 --timestamps` to SSE events. One
        event per stdout line: {"line": "<text>", "stream": "docker"}.
        Subprocess is terminated when the client disconnects or when the
        container stops emitting.
        """
        known_containers = {s["container"] for s in SERVICE_CATALOG}
        if container_name not in known_containers:
            return json_response(
                self,
                {"error": f"Unknown container: {container_name!r}"},
                status=HTTPStatus.NOT_FOUND,
            )

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        # --timestamps prefixes each line with an RFC3339Nano timestamp.
        # --tail 200 gives the operator useful context on first connect.
        proc = subprocess.Popen(
            ["docker", "logs", "-f", "--tail", "200", "--timestamps", container_name],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        try:
            if proc.stdout is None:
                return
            for raw in proc.stdout:
                line = raw.rstrip("\n").rstrip("\r")
                if not self._sse_send({"line": line, "container": container_name}):
                    break
        except Exception:
            pass
        finally:
            try:
                proc.terminate()
            except Exception:
                pass
            try:
                proc.wait(timeout=2)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    def _stream_query_feed(self):
        """SSE handler for /api/stream/queries.

        Sends an initial dump of the last QUERY_FEED_INITIAL_N queries from
        each plane (sorted chronologically), then polls every QUERY_FEED_POLL_S
        seconds for new queries and streams them as SSE events. Each event is
        a JSON object with the normalized query shape from _normalize_pihole_query.
        """
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        values = read_env_values_safe()

        # Initial dump: last N queries from each plane, then sort chronologically.
        last_seen = {}
        initial = []
        for target in PIHOLE_API_TARGETS:
            try:
                queries = _fetch_pihole_queries(target, values, QUERY_FEED_INITIAL_N)
            except Exception:
                queries = []
            for q in queries:
                qid = q.get("id") or 0
                if qid > last_seen.get(target["id"], 0):
                    last_seen[target["id"]] = qid
                initial.append(q)
        initial.sort(key=lambda q: q.get("time") or 0)
        for q in initial:
            if not self._sse_send(q):
                return

        # Live tail: poll all planes, stream new queries, sleep, repeat.
        while True:
            time.sleep(QUERY_FEED_POLL_S)
            for target in PIHOLE_API_TARGETS:
                try:
                    queries = _fetch_pihole_queries(target, values, QUERY_FEED_BATCH_N)
                except Exception:
                    continue
                seen = last_seen.get(target["id"], 0)
                new_max = seen
                for q in queries:
                    qid = q.get("id") or 0
                    if qid > seen:
                        if not self._sse_send(q):
                            return
                        if qid > new_max:
                            new_max = qid
                last_seen[target["id"]] = new_max

    def do_POST(self):
        if not self._require_backend_auth():
            return

        if self.path == "/api/tor/rotate":
            values = read_env_values_safe()
            result = tor_rotate_identity(values)
            # Invalidate the snapshot cache so the next /api/system/snapshot
            # call sees the post-rotation state immediately.
            with _SNAPSHOT_CACHE_LOCK:
                _SNAPSHOT_CACHE["data"] = None
                _SNAPSHOT_CACHE["expires_at"] = 0.0
            status = HTTPStatus.OK if result["ok"] else HTTPStatus.INTERNAL_SERVER_ERROR
            return json_response(self, result, status=status)

        if self.path == "/api/notifications/test":
            result = send_test_alert()
            status = HTTPStatus.OK if result["ok"] else HTTPStatus.INTERNAL_SERVER_ERROR
            return json_response(self, result, status=status)

        if self.path == "/api/leak-test/run":
            result = run_leak_test()
            store_leak_test_result(result)
            with _SNAPSHOT_CACHE_LOCK:
                _SNAPSHOT_CACHE["data"] = None
                _SNAPSHOT_CACHE["expires_at"] = 0.0
            # Always return 200 — the result body tells the truth about pass/fail.
            return json_response(self, result, status=HTTPStatus.OK)

        if self.path == "/api/tor/rotate-plane":
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length > 0 else b""
            try:
                payload = json.loads(body) if body else {}
            except json.JSONDecodeError:
                return json_response(
                    self,
                    {"ok": False, "message": "invalid JSON body"},
                    status=HTTPStatus.BAD_REQUEST,
                )
            plane = (payload.get("plane") or "").strip()
            values = read_env_values_safe()
            result = tor_rotate_plane(values, plane)
            with _SNAPSHOT_CACHE_LOCK:
                _SNAPSHOT_CACHE["data"] = None
                _SNAPSHOT_CACHE["expires_at"] = 0.0
            status = HTTPStatus.OK if result["ok"] else HTTPStatus.INTERNAL_SERVER_ERROR
            return json_response(self, result, status=status)

        if self.path == "/api/recovery/backup":
            if recovery_busy():
                return json_response(
                    self,
                    {"error": "Another recovery operation is already running."},
                    status=HTTPStatus.CONFLICT,
                )
            result = run_script(str(ROOT_DIR / "ops/scripts/50-backup.sh"))
            if result.returncode != 0:
                return json_response(
                    self,
                    {
                        "error": "Backup failed",
                        "stdout": result.stdout,
                        "stderr": result.stderr,
                    },
                    status=HTTPStatus.INTERNAL_SERVER_ERROR,
                )

            return json_response(
                self,
                {
                    "message": "Backup completed.",
                    "status": read_status(),
                    "backups": list_backups(),
                },
            )

        if self.path == "/api/system/validate":
            if recovery_busy():
                return json_response(
                    self,
                    {"error": "Recovery is running. Wait until it finishes before validating the stack."},
                    status=HTTPStatus.CONFLICT,
                )

            payload = run_system_validation()
            return json_response(self, payload)

        if self.path == "/api/recovery/validate":
            if recovery_busy():
                return json_response(
                    self,
                    {"error": "Recovery is running. Wait until it finishes before validating the stack."},
                    status=HTTPStatus.CONFLICT,
                )

            payload = run_system_validation()
            return json_response(self, payload)

        if self.path == "/api/recovery/restore":
            if recovery_busy():
                return json_response(
                    self,
                    {"error": "Another recovery operation is already running."},
                    status=HTTPStatus.CONFLICT,
                )
            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length) if content_length else b"{}"

            try:
                payload = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                return json_response(self, {"error": "Invalid JSON body"}, status=HTTPStatus.BAD_REQUEST)

            archive = payload.get("archive", "")
            confirm = payload.get("confirm", "")
            if confirm != "RESTORE":
                return json_response(
                    self,
                    {"error": "Restore confirmation is required."},
                    status=HTTPStatus.BAD_REQUEST,
                )

            try:
                result = schedule_restore(archive)
            except FileNotFoundError:
                return json_response(self, {"error": "Archive not found"}, status=HTTPStatus.NOT_FOUND)
            except ValueError as exc:
                return json_response(self, {"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

            if result.returncode != 0:
                return json_response(
                    self,
                    {
                        "error": "Restore job failed to schedule",
                        "stdout": result.stdout,
                        "stderr": result.stderr,
                    },
                    status=HTTPStatus.INTERNAL_SERVER_ERROR,
                )

            return json_response(
                self,
                {
                    "message": "Restore job scheduled. The stack will go down briefly and come back on its own.",
                    "status": read_status(),
                },
                status=HTTPStatus.ACCEPTED,
            )

        if self.path == "/api/recovery/delete":
            if recovery_busy():
                return json_response(
                    self,
                    {"error": "Another recovery operation is already running."},
                    status=HTTPStatus.CONFLICT,
                )

            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length) if content_length else b"{}"

            try:
                payload = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                return json_response(self, {"error": "Invalid JSON body"}, status=HTTPStatus.BAD_REQUEST)

            archive = payload.get("archive", "")
            confirm = payload.get("confirm", "")
            archive_confirm = payload.get("archive_confirm", "")

            if confirm != "DELETE":
                return json_response(
                    self,
                    {"error": "Delete confirmation is required."},
                    status=HTTPStatus.BAD_REQUEST,
                )
            if archive_confirm != archive:
                return json_response(
                    self,
                    {"error": "Archive name confirmation does not match."},
                    status=HTTPStatus.BAD_REQUEST,
                )

            write_status("delete", "running", "Deleting recovery archive", archive)
            try:
                delete_backup_archive(archive)
            except FileNotFoundError:
                write_status("delete", "error", "Backup archive not found", archive)
                return json_response(self, {"error": "Archive not found"}, status=HTTPStatus.NOT_FOUND)
            except ValueError as exc:
                write_status("delete", "error", str(exc), archive)
                return json_response(self, {"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

            write_status("delete", "success", "Backup archive deleted", archive)
            return json_response(
                self,
                {
                    "message": "Backup deleted.",
                    "status": read_status(),
                    "backups": list_backups(),
                },
            )

        if self.path == "/api/services/action":
            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length) if content_length else b"{}"
            try:
                body = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                return json_response(self, {"error": "Invalid JSON body"}, status=HTTPStatus.BAD_REQUEST)
            service_id = body.get("id", "")
            action = body.get("action", "")
            try:
                container = service_action(service_id, action)
            except ValueError as exc:
                return json_response(self, {"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            except RuntimeError as exc:
                return json_response(self, {"error": str(exc)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return json_response(self, {"message": f"{action} sent to {container}.", "services": get_services_detail()})

        if self.path == "/api/config":
            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length) if content_length else b"{}"
            try:
                body = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                return json_response(self, {"error": "Invalid JSON body"}, status=HTTPStatus.BAD_REQUEST)
            key = body.get("key", "")
            value = body.get("value", "")
            force = bool(body.get("force", False))
            if not key:
                return json_response(self, {"error": "key is required"}, status=HTTPStatus.BAD_REQUEST)
            try:
                config = set_config_value(key, str(value), force=force)
            except ValueError as exc:
                return json_response(self, {"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            except FileNotFoundError:
                return json_response(self, {"error": ".env file not found"}, status=HTTPStatus.NOT_FOUND)
            return json_response(self, {"message": f"{key} updated.", "config": config})

        if self.path == "/api/config/web-access":
            if recovery_busy():
                return json_response(
                    self,
                    {"error": "Recovery is running. Wait until it finishes before changing web access."},
                    status=HTTPStatus.CONFLICT,
                )
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length > 196 * 1024:
                return json_response(
                    self,
                    {"error": "Certificate upload is larger than 196 KiB."},
                    status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                )
            raw = self.rfile.read(content_length) if content_length else b"{}"
            try:
                body = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                return json_response(self, {"error": "Invalid JSON body"}, status=HTTPStatus.BAD_REQUEST)
            mode = body.get("mode", "https-local")
            confirm_word = "UPLOAD" if mode == "https-custom" else "ENABLE"
            if body.get("confirm") != confirm_word:
                return json_response(
                    self,
                    {"error": f"Type {confirm_word} to confirm the HTTPS transition."},
                    status=HTTPStatus.BAD_REQUEST,
                )
            try:
                result = configure_https(
                    mode,
                    certificate=body.get("certificate"),
                    private_key=body.get("private_key"),
                )
            except ValueError as exc:
                return json_response(self, {"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            except (OSError, RuntimeError) as exc:
                return json_response(self, {"error": str(exc)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return json_response(self, result, status=HTTPStatus.ACCEPTED if result.get("scheduled") else HTTPStatus.OK)

        if self.path == "/api/setup/apply":
            # Setup wizard apply — writes non-secret config keys from the
            # wizard's captured state into .env. Does NOT auto-deploy;
            # the UI shows a "run deploy.sh on the host" message on success.
            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length) if content_length else b"{}"
            try:
                payload = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                return json_response(
                    self, {"error": "Invalid JSON body"},
                    status=HTTPStatus.BAD_REQUEST,
                )

            confirm = payload.get("confirm", "")
            if confirm != "APPLY":
                return json_response(
                    self,
                    {"error": "Confirmation token is required. Type APPLY to confirm."},
                    status=HTTPStatus.BAD_REQUEST,
                )

            try:
                result = apply_setup_config(payload)
            except ValueError as exc:
                return json_response(
                    self, {"error": str(exc)},
                    status=HTTPStatus.BAD_REQUEST,
                )
            except OSError as exc:
                return json_response(
                    self, {"error": f"Failed to write .env: {exc}"},
                    status=HTTPStatus.INTERNAL_SERVER_ERROR,
                )
            return json_response(self, result)

        if self.path == "/api/identity/password":
            # Change the admin password. Destructive (will log the user
            # out) so the UI gates this behind a ConfirmModal and passes
            # confirm:"UPDATE" in the body as a belt-and-braces check.
            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length) if content_length else b"{}"
            try:
                payload = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                return json_response(
                    self, {"error": "Invalid JSON body"},
                    status=HTTPStatus.BAD_REQUEST,
                )

            confirm = payload.get("confirm", "")
            if confirm != "UPDATE":
                return json_response(
                    self,
                    {"error": "Confirmation token is required. Type UPDATE to confirm."},
                    status=HTTPStatus.BAD_REQUEST,
                )

            current_password = payload.get("current_password", "")
            new_password = payload.get("new_password", "")
            confirm_password = payload.get("confirm_password", "")

            # Require a current-password field even if it's empty — the UI
            # always sends it, so a missing field means the caller is
            # bypassing the form and deserves a clear 400.
            if "current_password" not in payload:
                return json_response(
                    self,
                    {"error": "Current password is required."},
                    status=HTTPStatus.BAD_REQUEST,
                )

            if new_password != confirm_password:
                return json_response(
                    self,
                    {"error": "New password and confirmation do not match."},
                    status=HTTPStatus.BAD_REQUEST,
                )

            result = update_admin_password(new_password, current_password=current_password)
            if not result["ok"]:
                return json_response(
                    self, {"error": result["message"]},
                    status=HTTPStatus.BAD_REQUEST,
                )
            return json_response(
                self,
                {
                    "message": result["message"],
                    "backup": result.get("backup"),
                },
            )

        if self.path == "/api/notifications/channel":
            if recovery_busy():
                return json_response(
                    self,
                    {"error": "Recovery is running. Wait until it finishes before changing notification delivery."},
                    status=HTTPStatus.CONFLICT,
                )

            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length) if content_length else b"{}"

            try:
                payload = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                return json_response(self, {"error": "Invalid JSON body"}, status=HTTPStatus.BAD_REQUEST)

            channel = payload.get("channel", "")
            enabled = payload.get("enabled")
            if not isinstance(enabled, bool):
                return json_response(self, {"error": "Enabled must be a boolean."}, status=HTTPStatus.BAD_REQUEST)

            try:
                channels = set_notification_channel(channel, enabled)
            except ValueError as exc:
                return json_response(self, {"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            except RuntimeError as exc:
                return json_response(self, {"error": str(exc)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

            label = CHANNEL_FIELDS[channel]["label"]
            state = "enabled" if enabled else "muted"
            return json_response(
                self,
                {
                    "message": f"{label} notifications {state}.",
                    "channels": channels,
                },
            )

        return json_response(self, {"error": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    start_scheduled_leak_test()
    start_scheduled_backup()
    server = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
    server.serve_forever()
