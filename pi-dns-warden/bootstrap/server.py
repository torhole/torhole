#!/usr/bin/env python3
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import shlex
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
COOKIE_NAME = "torhole_bootstrap"
MAX_LOG_LINES = 300
EDITION_RE = re.compile(r"^(home|advanced)$")
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
    "REVERSE_PROXY_DOMAIN": "home.arpa",
}
ADVANCED_PUBLIC_KEYS = tuple(ADVANCED_DEFAULTS)
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
    result = {
        "TORHOLE_EDITION": advanced.get(
            "TORHOLE_EDITION", quick.get("TORHOLE_EDITION", "home")
        ),
        "TZ": advanced.get("TZ", quick.get("TZ", os.environ.get("TZ", "UTC"))),
        "TORHOLE_ADMIN_USER": advanced.get(
            "TORHOLE_ADMIN_USER", quick.get("TORHOLE_ADMIN_USER", "admin")
        ),
        "PIHOLE_PASSWORD": "***" if quick.get("PIHOLE_PASSWORD") else "",
        "TORHOLE_BLOCKLISTS": quick.get("TORHOLE_BLOCKLISTS", "stevenblack"),
    }
    for key, default in ADVANCED_DEFAULTS.items():
        value = advanced.get(key, default)
        result[key] = "" if value.startswith("CHANGE_ME") else value
    for key in ADVANCED_SECRET_KEYS:
        value = advanced.get(key, "")
        result[key] = "***" if value and not value.startswith("CHANGE_ME") else ""
    return result


def status_snapshot():
    with _status_lock:
        return {**_status, "logs": list(_status.get("logs", []))}


def set_status(status, message, **extra):
    with _status_lock:
        # A new install attempt must not inherit edition-specific receipt data
        # (for example Advanced's handoff flag or Home's credentials). Keep the
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


def validated_blocklists(value):
    if not isinstance(value, list) or not value:
        raise ValueError("Select at least one blocklist.")
    if any(not isinstance(item, str) or item not in BLOCKLISTS for item in value):
        raise ValueError("Blocklist selection contains an unsupported value.")
    if len(value) != len(set(value)):
        raise ValueError("Blocklist selection contains duplicates.")
    return [item for item in BLOCKLISTS if item in value]


def _required_text(config, key):
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required.")
    value = value.strip()
    if "\n" in value or "\r" in value or "\x00" in value:
        raise ValueError(f"{key} contains invalid characters.")
    return value


def validated_advanced_config(value):
    if not isinstance(value, dict):
        raise ValueError("Advanced network configuration is required.")
    config = {key: _required_text(value, key) for key in ADVANCED_PUBLIC_KEYS}
    for key in ("PARENT_IF", "TRUSTED_PARENT", "IOT_PARENT"):
        if not INTERFACE_RE.fullmatch(config[key]):
            raise ValueError(f"{key} is not a valid Linux interface name.")
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

    planes = (
        ("TRUSTED_SUBNET_CIDR", "TRUSTED_GATEWAY", "PIHOLE_TRUSTED_IP"),
        ("IOT_SUBNET_CIDR", "IOT_GATEWAY", "PIHOLE_IOT_IP"),
    )
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
    if not DOMAIN_RE.fullmatch(config["REVERSE_PROXY_DOMAIN"]):
        raise ValueError("REVERSE_PROXY_DOMAIN must be a domain such as home.arpa.")
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


def prepare_advanced_config(network_config, admin_user, timezone_name):
    app_dir = ROOT_DIR / "pi-dns-warden"
    env_path = app_dir / ".env"
    template_path = app_dir / ".env.example"
    existing = parse_env(env_path)
    updates = {
        "TORHOLE_EDITION": "advanced",
        "TZ": timezone_name,
        "TORHOLE_ADMIN_USER": admin_user,
        **network_config,
    }
    generated = {}
    for key in (
        "PIHOLE_TRUSTED_PASSWORD",
        "PIHOLE_IOT_PASSWORD",
        "TORHOLE_ADMIN_PASSWORD",
        "TOR_CONTROL_PASSWORD",
        "DNSCRYPT_SOCKS_PASS_TRUSTED",
        "DNSCRYPT_SOCKS_PASS_IOT",
    ):
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
    return {
        "env_path": str(env_path),
        "deployment_command": f"cd {shlex.quote(str(app_dir))} && sudo ./deploy.sh",
        "generated_credentials": generated,
    }


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
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'")
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
            if payload.get("topology") != "vlan":
                return self.send_json(
                    {"error": "The current Advanced deployer requires segmented VLANs."},
                    HTTPStatus.BAD_REQUEST,
                )
            try:
                network_config = validated_advanced_config(payload.get("advanced_config"))
                handoff = prepare_advanced_config(network_config, admin_user, timezone)
            except (ValueError, OSError, RuntimeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            set_status(
                "success",
                "Advanced configuration saved. Approve the host deployment in your terminal.",
                logs=[
                    "Validated Advanced VLAN and addressing configuration.",
                    "Wrote pi-dns-warden/.env with mode 0600.",
                    "No host network or service changes were made by the web wizard.",
                ],
                edition="advanced",
                handoff=True,
                **handoff,
            )
            return self.send_json(status_snapshot(), HTTPStatus.OK)
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
