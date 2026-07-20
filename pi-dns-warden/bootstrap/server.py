#!/usr/bin/env python3
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


ROOT_DIR = Path(os.environ.get("TORHOLE_ROOT_DIR", "/workspace")).resolve()
UI_ROOT = Path(__file__).with_name("ui").resolve()
BOOTSTRAP_TOKEN = os.environ.get("TORHOLE_BOOTSTRAP_TOKEN", "")
HOST_ADDRESS = os.environ.get("TORHOLE_HOST_ADDRESS", "localhost")
OWNER_UID = int(os.environ.get("TORHOLE_OWNER_UID", "0"))
OWNER_GID = int(os.environ.get("TORHOLE_OWNER_GID", "0"))
BOOTSTRAP_RUN_DIR = ROOT_DIR / "pi-dns-warden" / "run" / "bootstrap"
ADVANCED_REQUEST_FILE = BOOTSTRAP_RUN_DIR / "advanced-request.json"
ADVANCED_PROCESSING_FILE = BOOTSTRAP_RUN_DIR / "advanced-request.processing.json"
ADVANCED_STATUS_FILE = BOOTSTRAP_RUN_DIR / "advanced-status.json"
ADVANCED_LOG_FILE = BOOTSTRAP_RUN_DIR / "advanced-install.log"
COOKIE_NAME = "torhole_bootstrap"
MAX_LOG_LINES = 300
MAX_REQUEST_BYTES = 256 * 1024
EDITION_RE = re.compile(r"^(home|advanced)$")
TOPOLOGY_RE = re.compile(r"^(single-lan|vlan)$")
WEB_MODE_RE = re.compile(r"^(http|https-local|https-custom)$")
ADMIN_RE = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,63}$")
TIMEZONE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$")
INTERFACE_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,15}$")
DOMAIN_RE = re.compile(
    r"^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$"
)
BLOCKLISTS = {
    "stevenblack": "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
    "oisd": "https://big.oisd.nl",
    "adguard": "https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt",
}
ALERT_SECRET_KEYS = {
    "ALERT_TELEGRAM_BOT_TOKEN",
    "ALERT_EMAIL_AUTH_PASSWORD",
    "ALERT_DISCORD_WEBHOOK_URL",
}
ADVANCED_DEFAULTS = {
    "PARENT_IF": "eth0",
    "TRUSTED_PARENT": "eth0",
    "IOT_PARENT": "eth0.50",
    "TRUSTED_VLAN_ID": "1",
    "IOT_VLAN_ID": "50",
    "TRUSTED_SUBNET_CIDR": "",
    "TRUSTED_GATEWAY": "",
    "IOT_SUBNET_CIDR": "",
    "IOT_GATEWAY": "",
    "PIHOLE_TRUSTED_IP": "",
    "PIHOLE_IOT_IP": "",
    "HOST_MGMT_IP": HOST_ADDRESS if HOST_ADDRESS != "localhost" else "",
    "REVERSE_PROXY_DOMAIN": "lan.home.arpa",
    "TORHOLE_WEB_MODE": "https-local",
}
ADVANCED_COMMON_KEYS = (
    "PARENT_IF",
    "HOST_MGMT_IP",
    "REVERSE_PROXY_DOMAIN",
)
ADVANCED_TRUSTED_KEYS = (
    "TRUSTED_PARENT",
    "TRUSTED_SUBNET_CIDR",
    "TRUSTED_GATEWAY",
    "PIHOLE_TRUSTED_IP",
)
ADVANCED_VLAN_KEYS = (
    "TRUSTED_VLAN_ID",
    "IOT_PARENT",
    "IOT_VLAN_ID",
    "IOT_SUBNET_CIDR",
    "IOT_GATEWAY",
    "PIHOLE_IOT_IP",
)
ADVANCED_SECRET_KEYS = (
    "PIHOLE_TRUSTED_PASSWORD",
    "PIHOLE_IOT_PASSWORD",
    "TORHOLE_ADMIN_PASSWORD",
    "TOR_CONTROL_PASSWORD",
)

_status_lock = threading.Lock()
_status = {
    "status": "idle",
    "message": "Ready to install.",
    "logs": [],
}


def resolve_ui_path(request_path, root=UI_ROOT):
    root = root.resolve()
    path = unquote(urlparse(request_path).path)
    relative = "index.html" if path in {"/", "/index.html"} else path.lstrip("/")
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        return None
    return candidate


def load_index():
    return (
        (UI_ROOT / "index.html")
        .read_text(encoding="utf-8")
        .replace(
            "</head>",
            '<script>window.__TORHOLE_MODE__="bootstrap"</script></head>',
        )
        .encode("utf-8")
    )


def parse_env(path):
    values = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def public_config():
    app_dir = ROOT_DIR / "pi-dns-warden"
    quick = parse_env(app_dir / ".env.quickstart.local")
    advanced = parse_env(app_dir / ".env")
    edition = advanced.get(
        "TORHOLE_EDITION", quick.get("TORHOLE_EDITION", "home")
    )
    result = {
        "TORHOLE_EDITION": edition,
        "TORHOLE_TOPOLOGY": advanced.get(
            "TORHOLE_TOPOLOGY", "vlan" if edition == "advanced" else "single-lan"
        ),
        "TZ": advanced.get("TZ", quick.get("TZ", os.environ.get("TZ", "UTC"))),
        "TORHOLE_ADMIN_USER": advanced.get(
            "TORHOLE_ADMIN_USER", quick.get("TORHOLE_ADMIN_USER", "admin")
        ),
        "PIHOLE_PASSWORD": "***" if quick.get("PIHOLE_PASSWORD") else "",
        "TORHOLE_BLOCKLISTS": advanced.get(
            "TORHOLE_BLOCKLISTS", quick.get("TORHOLE_BLOCKLISTS", "stevenblack")
        ),
    }
    for key, default in ADVANCED_DEFAULTS.items():
        value = advanced.get(key, default)
        result[key] = "" if value.startswith("CHANGE_ME") else value
    for key in ADVANCED_SECRET_KEYS:
        value = advanced.get(key, "")
        result[key] = "***" if value and not value.startswith("CHANGE_ME") else ""
    alert_keys = (
        "ALERT_EMAIL_TO",
        "ALERT_EMAIL_FROM",
        "ALERT_EMAIL_SMARTHOST",
        "ALERT_EMAIL_AUTH_USERNAME",
        "ALERT_EMAIL_AUTH_PASSWORD",
        "ALERT_EMAIL_REQUIRE_TLS",
        "ALERT_EMAIL_ENABLED",
        "ALERT_TELEGRAM_BOT_TOKEN",
        "ALERT_TELEGRAM_CHAT_ID",
        "ALERT_TELEGRAM_ENABLED",
        "ALERT_DISCORD_WEBHOOK_URL",
        "ALERT_DISCORD_USERNAME",
        "ALERT_DISCORD_ENABLED",
    )
    for key in alert_keys:
        value = advanced.get(key, "")
        result[key] = "***" if key in ALERT_SECRET_KEYS and value else value
    return result


def _tail_log(path, limit=MAX_LOG_LINES):
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]
    except OSError:
        return []


def advanced_result():
    values = parse_env(ROOT_DIR / "pi-dns-warden" / ".env")
    domain = values.get("REVERSE_PROXY_DOMAIN", "").strip()
    topology = values.get("TORHOLE_TOPOLOGY", "vlan").strip() or "vlan"
    web_mode = values.get("TORHOLE_WEB_MODE", "https-local").strip() or "https-local"
    scheme = "http" if web_mode == "http" else "https"
    host_ip = values.get("HOST_MGMT_IP", "").strip()
    credentials = {
        "TORHOLE_ADMIN_USER": values.get("TORHOLE_ADMIN_USER", "admin").strip() or "admin",
        "TORHOLE_ADMIN_PASSWORD": values.get("TORHOLE_ADMIN_PASSWORD", "").strip(),
        "PIHOLE_TRUSTED_USER": "admin",
        "PIHOLE_TRUSTED_PASSWORD": values.get("PIHOLE_TRUSTED_PASSWORD", "").strip(),
    }
    if topology == "vlan":
        credentials.update(
            {
                "PIHOLE_IOT_USER": "admin",
                "PIHOLE_IOT_PASSWORD": values.get("PIHOLE_IOT_PASSWORD", "").strip(),
            }
        )
    credentials = {
        key: value
        for key, value in credentials.items()
        if value and not value.startswith("CHANGE_ME")
    }

    def link(key, default, path="/"):
        label = values.get(key, default).strip() or default
        return f"{scheme}://{label}.{domain}{path}" if domain else ""

    return {
        "advanced_complete": True,
        "topology": topology,
        "web_mode": web_mode,
        "advanced_url": link("TORHOLE_HOST_TORHOLE", "torhole"),
        "direct_ip_url": f"http://{host_ip}/" if host_ip else "",
        "certificate_url": (
            f"http://{host_ip}/torhole-local-ca.crt"
            if host_ip and web_mode == "https-local"
            else ""
        ),
        "grafana_url": link("TORHOLE_HOST_GRAFANA", "grafana"),
        "pihole_trusted_url": link(
            "TORHOLE_HOST_PIHOLE_TRUSTED", "pihole-trusted", "/admin/"
        ),
        "pihole_iot_url": (
            link("TORHOLE_HOST_PIHOLE_IOT", "pihole-iot", "/admin/")
            if topology == "vlan"
            else ""
        ),
        "trusted_dns": values.get("PIHOLE_TRUSTED_IP", ""),
        "iot_dns": values.get("PIHOLE_IOT_IP", "") if topology == "vlan" else "",
        # This is computed only after a successful deployment and returned only
        # by the token-protected bootstrap API. It is not written to the host
        # runner's status file or exposed by the normal Torhole dashboard API.
        "credentials": credentials,
    }


def _host_install_snapshot(snapshot):
    request_id = snapshot.get("request_id")
    if snapshot.get("edition") != "advanced" or not request_id:
        return snapshot
    try:
        host_status = json.loads(ADVANCED_STATUS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return snapshot
    if host_status.get("request_id") != request_id:
        return snapshot
    status = host_status.get("status")
    if status not in {"running", "success", "error"}:
        return snapshot
    logs = _tail_log(ADVANCED_LOG_FILE) or snapshot.get("logs", [])
    merged = {
        **snapshot,
        "status": status,
        "message": host_status.get("message", snapshot.get("message", "")),
        "logs": logs,
    }
    if status == "success":
        merged.update(advanced_result())
    return merged


def status_snapshot():
    with _status_lock:
        snapshot = {**_status, "logs": list(_status.get("logs", []))}
    return _host_install_snapshot(snapshot)


def set_status(status, message, **extra):
    with _status_lock:
        # A new install attempt must not inherit edition-specific receipt data
        # (for example Advanced's request ID or Home's credentials). Keep the
        # current log only when the caller does not explicitly replace it.
        logs = extra.pop("logs", list(_status.get("logs", [])))
        _status.clear()
        _status.update({"status": status, "message": message, "logs": logs, **extra})


def append_log(line):
    line = line.rstrip()
    if not line:
        return
    with _status_lock:
        logs = _status.setdefault("logs", [])
        logs.append(line)
        del logs[:-MAX_LOG_LINES]
        _status["message"] = line


def install_result():
    values = parse_env(ROOT_DIR / "pi-dns-warden" / ".env.quickstart.local")
    web_port = values.get("WEB_PORT", "8080")
    pihole_port = values.get("PIHOLE_WEB_PORT", "8081")
    return {
        "edition": "home",
        "home_url": f"http://{HOST_ADDRESS}:{web_port}/",
        "pihole_url": f"http://{HOST_ADDRESS}:{pihole_port}/admin/",
        "pihole_password": values.get("PIHOLE_PASSWORD", ""),
        "control_pin": values.get("CONTROL_PIN", ""),
        "blocklists": [
            item
            for item in values.get("TORHOLE_BLOCKLISTS", "stevenblack").split(",")
            if item in BLOCKLISTS
        ],
    }


def existing_install_receipt():
    """Recover access details for an already installed local edition.

    The caller is the token-protected bootstrap API. Secrets are read from
    the private env file at request time and are never copied into the host
    runner status file.
    """
    app_dir = ROOT_DIR / "pi-dns-warden"
    advanced = parse_env(app_dir / ".env")
    if advanced.get("TORHOLE_EDITION") == "advanced":
        return {
            "status": "success",
            "message": "Recovered the existing Torhole Advanced access details.",
            "edition": "advanced",
            "env_path": str(app_dir / ".env"),
            **advanced_result(),
        }
    quick = parse_env(app_dir / ".env.quickstart.local")
    if quick.get("TORHOLE_EDITION", "home") == "home" and quick.get("PIHOLE_PASSWORD"):
        return {
            "status": "success",
            "message": "Recovered the existing Torhole Home access details.",
            **install_result(),
        }
    raise FileNotFoundError("No completed Torhole installation receipt is available.")


def validated_blocklists(value):
    if not isinstance(value, list) or not value:
        raise ValueError("Select at least one blocklist.")
    if any(not isinstance(item, str) or item not in BLOCKLISTS for item in value):
        raise ValueError("Blocklist selection contains an unsupported value.")
    if len(value) != len(set(value)):
        raise ValueError("Blocklist selection contains duplicates.")
    return [item for item in BLOCKLISTS if item in value]


def _alert_text(channel, field, value, limit=4096):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{channel} {field} must be text.")
    value = value.strip()
    if len(value) > limit or any(character in value for character in "\r\n\x00"):
        raise ValueError(f"{channel} {field} contains invalid characters.")
    return value


def validated_alerts(value, existing=None):
    """Validate optional setup channels and return flat .env updates.

    Empty secret fields retain an existing value, which lets an operator
    re-run setup without the bootstrap API disclosing stored credentials.
    """
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise ValueError("Alert configuration must be an object.")
    unknown = set(value) - {"telegram", "email", "discord"}
    if unknown:
        raise ValueError("Alert configuration contains an unsupported channel.")
    existing = existing or {}
    updates = {}
    enabled_channels = []

    def channel(name):
        selected = value.get(name, {})
        if not isinstance(selected, dict):
            raise ValueError(f"{name.title()} alert configuration must be an object.")
        enabled = selected.get("enabled", False)
        if not isinstance(enabled, bool):
            raise ValueError(f"{name.title()} enabled must be true or false.")
        return selected, enabled

    telegram, telegram_enabled = channel("telegram")
    telegram_token = _alert_text("Telegram", "bot token", telegram.get("bot_token"))
    telegram_chat = _alert_text("Telegram", "chat ID", telegram.get("chat_id"), 256)
    if telegram_enabled:
        if not (telegram_token or existing.get("ALERT_TELEGRAM_BOT_TOKEN")):
            raise ValueError("Telegram bot token is required when Telegram alerts are enabled.")
        if not (telegram_chat or existing.get("ALERT_TELEGRAM_CHAT_ID")):
            raise ValueError("Telegram chat ID is required when Telegram alerts are enabled.")
        enabled_channels.append("telegram")
    updates["ALERT_TELEGRAM_ENABLED"] = "true" if telegram_enabled else "false"
    if telegram_token:
        updates["ALERT_TELEGRAM_BOT_TOKEN"] = telegram_token
    if telegram_chat:
        updates["ALERT_TELEGRAM_CHAT_ID"] = telegram_chat

    email, email_enabled = channel("email")
    email_fields = {
        "ALERT_EMAIL_TO": _alert_text("Email", "recipient", email.get("to"), 320),
        "ALERT_EMAIL_FROM": _alert_text("Email", "sender", email.get("from"), 320),
        "ALERT_EMAIL_SMARTHOST": _alert_text("Email", "SMTP server", email.get("smarthost"), 512),
        "ALERT_EMAIL_AUTH_USERNAME": _alert_text("Email", "SMTP username", email.get("auth_username"), 512),
        "ALERT_EMAIL_AUTH_PASSWORD": _alert_text("Email", "SMTP password", email.get("auth_password")),
    }
    if email_enabled:
        for key, label in (
            ("ALERT_EMAIL_TO", "recipient"),
            ("ALERT_EMAIL_FROM", "sender"),
            ("ALERT_EMAIL_SMARTHOST", "SMTP server"),
        ):
            if not (email_fields[key] or existing.get(key)):
                raise ValueError(f"Email {label} is required when email alerts are enabled.")
        enabled_channels.append("email")
    require_tls = email.get("require_tls", True)
    if not isinstance(require_tls, bool):
        raise ValueError("Email require TLS must be true or false.")
    updates["ALERT_EMAIL_ENABLED"] = "true" if email_enabled else "false"
    updates["ALERT_EMAIL_REQUIRE_TLS"] = "true" if require_tls else "false"
    updates.update({key: field for key, field in email_fields.items() if field})

    discord, discord_enabled = channel("discord")
    discord_webhook = _alert_text("Discord", "webhook URL", discord.get("webhook_url"))
    discord_username = _alert_text("Discord", "username", discord.get("username"), 80)
    current_webhook = discord_webhook or existing.get("ALERT_DISCORD_WEBHOOK_URL", "")
    if discord_enabled:
        if not current_webhook:
            raise ValueError("Discord webhook URL is required when Discord alerts are enabled.")
        if not current_webhook.startswith("https://"):
            raise ValueError("Discord webhook URL must use HTTPS.")
        enabled_channels.append("discord")
    updates["ALERT_DISCORD_ENABLED"] = "true" if discord_enabled else "false"
    if discord_webhook:
        updates["ALERT_DISCORD_WEBHOOK_URL"] = discord_webhook
    if discord_username:
        updates["ALERT_DISCORD_USERNAME"] = discord_username

    return {"updates": updates, "enabled_channels": enabled_channels}


def _required_text(config, key):
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required.")
    value = value.strip()
    if "\n" in value or "\r" in value or "\x00" in value:
        raise ValueError(f"{key} contains invalid characters.")
    return value


def validated_advanced_config(value, topology="vlan"):
    if not isinstance(value, dict):
        raise ValueError("Advanced network configuration is required.")
    if not isinstance(topology, str) or not TOPOLOGY_RE.fullmatch(topology):
        raise ValueError("Advanced topology must be single-lan or vlan.")
    required_keys = ADVANCED_COMMON_KEYS + ADVANCED_TRUSTED_KEYS
    if topology == "vlan":
        required_keys += ADVANCED_VLAN_KEYS
    config = {key: _required_text(value, key) for key in required_keys}
    interface_keys = ["PARENT_IF", "TRUSTED_PARENT"]
    if topology == "vlan":
        interface_keys.append("IOT_PARENT")
    for key in interface_keys:
        if not INTERFACE_RE.fullmatch(config[key]):
            raise ValueError(f"{key} is not a valid Linux interface name.")
    if topology == "vlan":
        vlan_ids = []
        for key in ("TRUSTED_VLAN_ID", "IOT_VLAN_ID"):
            try:
                vlan = int(config[key])
            except ValueError as exc:
                raise ValueError(f"{key} must be a number from 1 to 4094.") from exc
            if not 1 <= vlan <= 4094:
                raise ValueError(f"{key} must be a number from 1 to 4094.")
            config[key] = str(vlan)
            vlan_ids.append(vlan)
        if vlan_ids[0] == vlan_ids[1]:
            raise ValueError("Trusted and IoT VLAN IDs must be different.")

    planes = [
        ("TRUSTED_SUBNET_CIDR", "TRUSTED_GATEWAY", "PIHOLE_TRUSTED_IP"),
    ]
    if topology == "vlan":
        planes.append(("IOT_SUBNET_CIDR", "IOT_GATEWAY", "PIHOLE_IOT_IP"))
    for subnet_key, gateway_key, pihole_key in planes:
        try:
            network = ipaddress.ip_network(config[subnet_key], strict=True)
            gateway = ipaddress.ip_address(config[gateway_key])
            pihole = ipaddress.ip_address(config[pihole_key])
        except ValueError as exc:
            raise ValueError(f"Invalid IPv4 network values for {subnet_key}.") from exc
        if network.version != 4 or gateway.version != 4 or pihole.version != 4:
            raise ValueError("The Advanced deployer currently requires IPv4 network values.")
        if gateway not in network or pihole not in network:
            raise ValueError(f"{gateway_key} and {pihole_key} must be inside {subnet_key}.")
        if gateway in {network.network_address, network.broadcast_address} or pihole in {
            network.network_address,
            network.broadcast_address,
        }:
            raise ValueError(f"{gateway_key} and {pihole_key} must be usable host addresses.")
        if gateway == pihole:
            raise ValueError(f"{gateway_key} and {pihole_key} must be different.")

    try:
        host_ip = ipaddress.ip_address(config["HOST_MGMT_IP"])
    except ValueError as exc:
        raise ValueError("HOST_MGMT_IP must be a valid IPv4 address.") from exc
    if host_ip.version != 4:
        raise ValueError("HOST_MGMT_IP must be a valid IPv4 address.")
    reverse_domain = config["REVERSE_PROXY_DOMAIN"].lower()
    if not DOMAIN_RE.fullmatch(reverse_domain):
        raise ValueError("REVERSE_PROXY_DOMAIN must be a domain such as lan.home.arpa.")
    if reverse_domain == "home.arpa":
        raise ValueError(
            "REVERSE_PROXY_DOMAIN cannot be bare home.arpa; use a private site label "
            "such as lan.home.arpa so Authelia can set its session cookie."
        )
    config["REVERSE_PROXY_DOMAIN"] = reverse_domain
    return config


def _replace_env_values(template, updates):
    remaining = dict(updates)
    lines = []
    for line in template.splitlines():
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=", line)
        if match and match.group(1) in remaining:
            key = match.group(1)
            lines.append(f"{key}={remaining.pop(key)}")
        else:
            lines.append(line)
    if remaining:
        lines.extend(f"{key}={value}" for key, value in remaining.items())
    return "\n".join(lines) + "\n"


def validated_web_access(value):
    if not isinstance(value, dict):
        raise ValueError("Web access configuration is required.")
    mode = value.get("mode")
    if not isinstance(mode, str) or not WEB_MODE_RE.fullmatch(mode):
        raise ValueError("Web access must be HTTP, generated HTTPS, or custom HTTPS.")
    result = {"mode": mode, "certificate": "", "private_key": ""}
    if mode != "https-custom":
        return result
    certificate = value.get("certificate")
    private_key = value.get("private_key")
    if not isinstance(certificate, str) or not isinstance(private_key, str):
        raise ValueError("Custom HTTPS requires a PEM certificate and private key.")
    if len(certificate.encode("utf-8")) > 128 * 1024 or len(private_key.encode("utf-8")) > 64 * 1024:
        raise ValueError("The uploaded certificate or private key is too large.")
    if "-----BEGIN CERTIFICATE-----" not in certificate or "-----END CERTIFICATE-----" not in certificate:
        raise ValueError("The custom certificate must be PEM encoded.")
    if not re.search(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----", private_key):
        raise ValueError("The custom private key must be PEM encoded.")
    result["certificate"] = certificate.strip() + "\n"
    result["private_key"] = private_key.strip() + "\n"
    return result


def _atomic_private_file(path, content, mode):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp_path = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    try:
        temp_path.write_text(content, encoding="utf-8")
        os.chmod(temp_path, mode)
        if OWNER_UID or OWNER_GID:
            os.chown(temp_path, OWNER_UID, OWNER_GID)
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def prepare_advanced_config(
    network_config,
    admin_user,
    timezone_name,
    topology="vlan",
    web_access=None,
    blocklists=None,
    alerts=None,
):
    app_dir = ROOT_DIR / "pi-dns-warden"
    env_path = app_dir / ".env"
    template_path = app_dir / ".env.example"
    existing = parse_env(env_path)
    selected_web = validated_web_access(web_access or {"mode": "https-local"})
    selected_blocklists = validated_blocklists(blocklists or ["stevenblack"])
    selected_alerts = validated_alerts(alerts, existing)
    web_mode = selected_web["mode"]
    updates = {
        "TORHOLE_EDITION": "advanced",
        "TORHOLE_TOPOLOGY": topology,
        # Docker helper containers need the real host-side project path for
        # validation and recovery bind mounts. Advanced curl installs are not
        # necessarily rooted at the historical /opt/pi-dns-warden default.
        "BACKUP_MANAGER_ROOT_DIR": str(app_dir.resolve()),
        "TORHOLE_WEB_MODE": web_mode,
        "TORHOLE_WEB_SCHEME": "http" if web_mode == "http" else "https",
        "TZ": timezone_name,
        "TORHOLE_ADMIN_USER": admin_user,
        "TORHOLE_BLOCKLISTS": ",".join(selected_blocklists),
        **selected_alerts["updates"],
        **network_config,
    }
    generated = {}
    secret_keys = [
        "PIHOLE_TRUSTED_PASSWORD",
        "TORHOLE_ADMIN_PASSWORD",
        "TOR_CONTROL_PASSWORD",
        "DNSCRYPT_SOCKS_PASS_TRUSTED",
    ]
    if topology == "vlan":
        secret_keys.extend(("PIHOLE_IOT_PASSWORD", "DNSCRYPT_SOCKS_PASS_IOT"))
    for key in secret_keys:
        current = existing.get(key, "")
        if current and not current.startswith("CHANGE_ME"):
            updates[key] = current
        else:
            updates[key] = secrets.token_urlsafe(24)
            generated[key] = updates[key]

    source = env_path if env_path.exists() else template_path
    if not source.exists():
        raise RuntimeError("Advanced .env template is missing.")
    if env_path.exists():
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        shutil.copy2(env_path, app_dir / f".env.bootstrap-backup-{stamp}")
    temp_path = app_dir / f".env.bootstrap-{secrets.token_hex(6)}.tmp"
    try:
        temp_path.write_text(
            _replace_env_values(source.read_text(encoding="utf-8"), updates),
            encoding="utf-8",
        )
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, env_path)
        if OWNER_UID or OWNER_GID:
            os.chown(env_path, OWNER_UID, OWNER_GID)
    finally:
        temp_path.unlink(missing_ok=True)
    if web_mode == "https-custom":
        tls_dir = app_dir / "monitoring" / "caddy" / "tls"
        _atomic_private_file(tls_dir / "custom.crt", selected_web["certificate"], 0o644)
        _atomic_private_file(tls_dir / "custom.key", selected_web["private_key"], 0o600)
    return {
        "env_path": str(env_path),
        "topology": topology,
        "web_mode": web_mode,
        "blocklists": selected_blocklists,
        "alerts": selected_alerts["enabled_channels"],
        "generated_credentials": generated,
    }


def _write_host_request(payload):
    BOOTSTRAP_RUN_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp_path = BOOTSTRAP_RUN_DIR / f".advanced-request-{secrets.token_hex(6)}.tmp"
    try:
        temp_path.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
        os.chmod(temp_path, 0o600)
        if OWNER_UID or OWNER_GID:
            os.chown(temp_path, OWNER_UID, OWNER_GID)
        os.replace(temp_path, ADVANCED_REQUEST_FILE)
    finally:
        temp_path.unlink(missing_ok=True)


def queue_advanced_install(config_receipt):
    request_id = secrets.token_hex(16)
    for path in (
        ADVANCED_REQUEST_FILE,
        ADVANCED_PROCESSING_FILE,
        ADVANCED_STATUS_FILE,
        ADVANCED_LOG_FILE,
    ):
        path.unlink(missing_ok=True)
    _write_host_request(
        {
            "operation": "deploy-advanced",
            "request_id": request_id,
            "created_at": time.time(),
            "token": BOOTSTRAP_TOKEN,
        }
    )
    topology = config_receipt.get("topology", "vlan")
    blocklists = ", ".join(config_receipt.get("blocklists", [])) or "stevenblack"
    alert_channels = ", ".join(config_receipt.get("alerts", [])) or "none"
    set_status(
        "running",
        "Advanced installation queued on the Torhole host.",
        logs=[
            f"Validated Advanced {topology} addressing configuration.",
            "Wrote pi-dns-warden/.env with mode 0600.",
            f"Selected blocklists: {blocklists}.",
            f"Selected alert channels: {alert_channels}.",
            "Queued the fixed Advanced deployer on the authorized host installer.",
        ],
        edition="advanced",
        request_id=request_id,
        **config_receipt,
    )
    return status_snapshot()


def container_command(args, timeout=20):
    result = subprocess.run(
        ["docker", *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"docker exited with status {result.returncode}")
    return result.stdout.strip()


def runtime_verification():
    verification = {
        "tor": {
            "ok": False,
            "exit_ip": "",
            "detail": "Tor egress check did not run.",
        },
        "dns": {
            "ok": False,
            "answer": "",
            "detail": "DNS path check did not run.",
        },
        "isolation": {
            "ok": False,
            "detail": "Network isolation check did not run.",
        },
    }

    try:
        raw = container_command(
            [
                "exec",
                "torhole-qs-tor",
                "curl",
                "--silent",
                "--fail",
                "--socks5-hostname",
                "127.0.0.1:9050",
                "https://check.torproject.org/api/ip",
            ],
            timeout=30,
        )
        result = json.loads(raw)
        is_tor = result.get("IsTor") is True
        verification["tor"] = {
            "ok": is_tor,
            "exit_ip": result.get("IP", ""),
            "detail": (
                "Tor Project confirmed this SOCKS connection used Tor."
                if is_tor
                else "Tor Project did not identify this SOCKS connection as Tor."
            ),
        }
    except Exception as exc:
        verification["tor"]["detail"] = f"Tor egress check failed: {exc}"

    try:
        answers = container_command(
            [
                "exec",
                "torhole-qs-pihole",
                "dig",
                "+short",
                "+time=5",
                "+tries=1",
                "@127.0.0.1",
                "example.com",
            ]
        ).splitlines()
        answer = next((line.strip() for line in answers if line.strip()), "")
        verification["dns"] = {
            "ok": bool(answer),
            "answer": answer,
            "detail": (
                "A real query resolved through Pi-hole and dnscrypt-proxy."
                if answer
                else "The DNS query returned no answer."
            ),
        }
    except Exception as exc:
        verification["dns"]["detail"] = f"DNS path check failed: {exc}"

    try:
        raw_networks = container_command(
            [
                "inspect",
                "torhole-qs-dnscrypt",
                "--format",
                "{{json .NetworkSettings.Networks}}",
            ]
        )
        network_names = list(json.loads(raw_networks))
        internal = [
            container_command(["network", "inspect", name, "--format", "{{.Internal}}"]).lower()
            == "true"
            for name in network_names
        ]
        isolated = len(network_names) == 1 and all(internal)
        verification["isolation"] = {
            "ok": isolated,
            "detail": (
                "dnscrypt-proxy has only an internal Docker network, so it cannot bypass Tor."
                if isolated
                else "dnscrypt-proxy has a network path that is not internal-only."
            ),
        }
    except Exception as exc:
        verification["isolation"]["detail"] = f"Network isolation check failed: {exc}"

    return verification


def run_home_install(timezone, blocklists):
    set_status("running", "Starting Torhole Home installation…", logs=[], edition="home")
    env = os.environ.copy()
    env["TORHOLE_INSTALL_ADDRESS"] = HOST_ADDRESS
    env["TORHOLE_INSTALL_TIMEZONE"] = timezone or env.get("TZ", "UTC")
    env["TORHOLE_INSTALL_BLOCKLISTS"] = ",".join(blocklists)
    try:
        process = subprocess.Popen(
            [str(ROOT_DIR / "install.sh"), "install-home"],
            cwd=ROOT_DIR,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert process.stdout is not None
        for line in process.stdout:
            append_log(line)
        returncode = process.wait()
        if returncode != 0:
            set_status(
                "error",
                f"Installer exited with status {returncode}. Review the log and retry.",
            )
            return
        env_path = ROOT_DIR / "pi-dns-warden" / ".env.quickstart.local"
        if OWNER_UID or OWNER_GID:
            try:
                os.chown(env_path, OWNER_UID, OWNER_GID)
            except OSError as exc:
                append_log(f"Warning: could not restore config ownership: {exc}")
        verification = runtime_verification()
        failed = [name for name, check in verification.items() if not check["ok"]]
        if failed:
            for name in failed:
                append_log(f"{name.title()} verification failed: {verification[name]['detail']}")
            set_status(
                "error",
                "Installation started, but privacy verification failed: " + ", ".join(failed),
                verification=verification,
            )
            return
        set_status(
            "success",
            "Torhole Home installed; DNS, Tor egress, and network isolation verified.",
            verification=verification,
            **install_result(),
        )
    except Exception as exc:
        append_log(f"Bootstrap error: {exc}")
        set_status("error", f"Bootstrap failed: {exc}")


def stop_bootstrap_container():
    # Give the HTTP response time to reach the browser before removing this
    # temporary, Docker-socket-enabled service.
    time.sleep(1)
    subprocess.run(
        ["docker", "rm", "-f", "torhole-bootstrap"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )


def cookie_authorized(header_value, expected=BOOTSTRAP_TOKEN):
    if not expected or not header_value:
        return False
    cookie = SimpleCookie()
    try:
        cookie.load(header_value)
    except Exception:
        return False
    morsel = cookie.get(COOKIE_NAME)
    return bool(morsel and secrets.compare_digest(morsel.value, expected))


class Handler(BaseHTTPRequestHandler):
    def send_json(self, payload, status=HTTPStatus.OK, headers=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        return cookie_authorized(self.headers.get("Cookie", ""))

    def require_api_auth(self):
        if not self.authorized():
            self.send_json({"error": "Bootstrap authorization required."}, HTTPStatus.FORBIDDEN)
            return False
        return True

    def serve_ui(self):
        candidate = resolve_ui_path(self.path)
        if candidate is None:
            return self.send_error(404)
        if candidate == UI_ROOT / "index.html":
            payload = load_index()
            content_type = "text/html; charset=utf-8"
            cache = "no-store"
        else:
            payload = candidate.read_bytes()
            content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
            cache = "public, max-age=31536000, immutable"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/" and "token" in parse_qs(parsed.query):
            supplied = parse_qs(parsed.query).get("token", [""])[0]
            if BOOTSTRAP_TOKEN and secrets.compare_digest(supplied, BOOTSTRAP_TOKEN):
                self.send_response(HTTPStatus.SEE_OTHER)
                self.send_header("Location", "/")
                self.send_header(
                    "Set-Cookie",
                    f"{COOKIE_NAME}={BOOTSTRAP_TOKEN}; HttpOnly; SameSite=Strict; Path=/",
                )
                self.end_headers()
                return
            return self.send_error(HTTPStatus.FORBIDDEN)

        if parsed.path == "/api/config":
            if not self.require_api_auth():
                return
            return self.send_json({"config": public_config()})
        if parsed.path == "/api/system/snapshot":
            if not self.require_api_auth():
                return
            return self.send_json(
                {
                    "schema_version": 1,
                    "generated_at": "",
                    "overall_status": "healthy",
                    "banner": None,
                    "planes": [],
                    "containers": [],
                }
            )
        if parsed.path == "/api/bootstrap/status":
            if not self.require_api_auth():
                return
            return self.send_json(status_snapshot())
        if parsed.path == "/api/bootstrap/receipt":
            if not self.require_api_auth():
                return
            try:
                return self.send_json(existing_install_receipt())
            except FileNotFoundError as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.NOT_FOUND)
        if parsed.path == "/health":
            return self.send_json({"ok": True})

        if parsed.path in {"/", "/index.html"} and not self.authorized():
            return self.send_error(HTTPStatus.FORBIDDEN, "Use the private installer URL printed in the terminal.")
        return self.serve_ui()

    def do_POST(self):
        if self.path not in {"/api/bootstrap/install", "/api/bootstrap/finish"}:
            return self.send_error(404)
        if not self.require_api_auth():
            return
        if self.headers.get("X-Torhole-Request") != "bootstrap":
            return self.send_json({"error": "Bootstrap request header required."}, HTTPStatus.FORBIDDEN)
        if self.path == "/api/bootstrap/finish":
            if status_snapshot()["status"] != "success":
                return self.send_json(
                    {"error": "Finish is available only after a successful installation."},
                    HTTPStatus.CONFLICT,
                )
            self.send_json({"ok": True, "message": "Closing the temporary setup service."})
            threading.Thread(target=stop_bootstrap_container, daemon=True).start()
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_REQUEST_BYTES:
            return self.send_json(
                {"error": "Setup request is too large."},
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            )
        try:
            payload = json.loads(self.rfile.read(length) if length else b"{}")
        except json.JSONDecodeError:
            return self.send_json({"error": "Invalid JSON body."}, HTTPStatus.BAD_REQUEST)
        if payload.get("confirm") != "INSTALL":
            return self.send_json({"error": "INSTALL confirmation is required."}, HTTPStatus.BAD_REQUEST)
        edition = payload.get("edition", "")
        admin_user = payload.get("admin_user", "admin")
        timezone = payload.get("timezone", "UTC")
        if not isinstance(edition, str) or not EDITION_RE.fullmatch(edition):
            return self.send_json({"error": "Edition must be home or advanced."}, HTTPStatus.BAD_REQUEST)
        if not isinstance(admin_user, str) or not ADMIN_RE.fullmatch(admin_user):
            return self.send_json({"error": "Invalid admin user."}, HTTPStatus.BAD_REQUEST)
        if not isinstance(timezone, str) or not TIMEZONE_RE.fullmatch(timezone):
            return self.send_json({"error": "Invalid timezone."}, HTTPStatus.BAD_REQUEST)
        current = status_snapshot()
        if current["status"] == "running":
            return self.send_json(current, HTTPStatus.CONFLICT)
        if edition == "advanced":
            topology = payload.get("topology")
            if not isinstance(topology, str) or not TOPOLOGY_RE.fullmatch(topology):
                return self.send_json(
                    {"error": "Advanced topology must be single-lan or vlan."},
                    HTTPStatus.BAD_REQUEST,
                )
            try:
                network_config = validated_advanced_config(
                    payload.get("advanced_config"), topology
                )
                web_access = validated_web_access(
                    payload.get("web_access") or {"mode": "https-local"}
                )
                blocklists = validated_blocklists(payload.get("blocklists"))
                alerts = validated_alerts(
                    payload.get("alerts"),
                    parse_env(ROOT_DIR / "pi-dns-warden" / ".env"),
                )
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            try:
                receipt = prepare_advanced_config(
                    network_config,
                    admin_user,
                    timezone,
                    topology,
                    web_access,
                    blocklists,
                    payload.get("alerts"),
                )
                result = queue_advanced_install(receipt)
            except (OSError, RuntimeError) as exc:
                set_status("error", f"Could not queue Advanced installation: {exc}")
                return self.send_json(
                    {"error": f"Could not queue Advanced installation: {exc}"},
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                )
            return self.send_json(result, HTTPStatus.ACCEPTED)
        try:
            blocklists = validated_blocklists(payload.get("blocklists"))
        except ValueError as exc:
            return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        set_status("running", "Installer queued…", logs=[], edition="home")
        thread = threading.Thread(
            target=run_home_install,
            args=(timezone, blocklists),
            daemon=True,
        )
        thread.start()
        return self.send_json(status_snapshot(), HTTPStatus.ACCEPTED)

    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)


def main():
    if not BOOTSTRAP_TOKEN or len(BOOTSTRAP_TOKEN) < 32:
        raise SystemExit("TORHOLE_BOOTSTRAP_TOKEN must contain at least 32 characters")
    ThreadingHTTPServer(("0.0.0.0", 8099), Handler).serve_forever()


if __name__ == "__main__":
    main()
