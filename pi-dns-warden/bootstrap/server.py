#!/usr/bin/env python3
import json
import mimetypes
import os
import re
import secrets
import subprocess
import threading
import time
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
    values = parse_env(ROOT_DIR / "pi-dns-warden" / ".env.quickstart.local")
    return {
        "TORHOLE_EDITION": values.get("TORHOLE_EDITION", "home"),
        "TZ": values.get("TZ", os.environ.get("TZ", "UTC")),
        "TORHOLE_ADMIN_USER": values.get("TORHOLE_ADMIN_USER", "admin"),
        "HOST_MGMT_IP": values.get("BIND_ADDRESS", HOST_ADDRESS),
        "PIHOLE_PASSWORD": "***" if values.get("PIHOLE_PASSWORD") else "",
    }


def status_snapshot():
    with _status_lock:
        return {**_status, "logs": list(_status.get("logs", []))}


def set_status(status, message, **extra):
    with _status_lock:
        _status.update({"status": status, "message": message, **extra})


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
        "control_pin": values.get("CONTROL_PIN", ""),
    }


def run_home_install(timezone):
    set_status("running", "Starting Torhole Home installation…", logs=[], edition="home")
    env = os.environ.copy()
    env["TORHOLE_INSTALL_ADDRESS"] = HOST_ADDRESS
    env["TORHOLE_INSTALL_TIMEZONE"] = timezone or env.get("TZ", "UTC")
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
        set_status(
            "success",
            "Torhole Home installed and private DNS verified.",
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
        if edition != "home":
            return self.send_json(
                {"error": "Advanced activation is blocked until its network fields are complete."},
                HTTPStatus.CONFLICT,
            )
        current = status_snapshot()
        if current["status"] == "running":
            return self.send_json(current, HTTPStatus.CONFLICT)
        set_status("running", "Installer queued…", logs=[], edition="home")
        thread = threading.Thread(target=run_home_install, args=(timezone,), daemon=True)
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
