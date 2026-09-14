"""Opt-in HTTP checks against the real Caddyfile and disposable TLS containers.

Only synthetic configuration and assets are mounted. Authentication is a fixture
401 gate, so logout must bypass it; no deployment services are contacted.
"""
from contextlib import contextmanager
import http.client
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
IMAGE = os.environ.get("TORHOLE_CADDY_TEST_IMAGE", "caddy:latest")


@unittest.skipUnless(os.environ.get("TORHOLE_RUN_DOCKER_TESTS") == "1", "set TORHOLE_RUN_DOCKER_TESTS=1 for disposable Docker tests")
class CaddyLogoutTests(unittest.TestCase):
    @contextmanager
    def caddy(self, auth_host="auth01"):
        with tempfile.TemporaryDirectory(prefix="torhole-caddy-test-") as directory:
            root = Path(directory)
            config = (ROOT / "monitoring/caddy/Caddyfile").read_text()
            (root / "Caddyfile").write_text(config)
            (root / "auth-snippets.caddy").write_text('''(access_gate) {
  @denied not header X-Fixture-Auth allowed
  respond @denied "Authentication required" 401
}
(ip_access_gate) {
  import access_gate
}
''')
            (root / "tls-snippets.caddy").write_text("(tls_mode) { tls internal }\n")
            (root / "topology-sites.caddy").write_text("# Single-LAN fixture\n")
            assets = root / "public"
            (assets / "assets").mkdir(parents=True)
            (assets / "index.html").write_text("<!doctype html><title>Fixture</title>")
            (assets / "assets/app.js").write_text("window.fixture = true;")
            variables = {key: key.lower().replace("_", "-") for key in re.findall(r"\{\$([A-Z0-9_]+)", config)}
            variables.update(TORHOLE_WEB_SCHEME="https", REVERSE_PROXY_DOMAIN="fixture.invalid",
                             TORHOLE_HOST_TORHOLE="tor-fixture", TORHOLE_ALIAS_TORHOLE="th-fixture",
                             TORHOLE_HOST_AUTH=auth_host, HOST_MGMT_IP="127.0.0.1",
                             BACKUP_MANAGER_API_TOKEN="synthetic-fixture-token")
            name = "torhole-caddy-test-" + uuid.uuid4().hex[:12]
            command = ["docker", "run", "--rm", "--detach", "--pull", "never", "--name", name,
                       "--publish", "127.0.0.1::443",
                       "--mount", f"type=bind,src={root},dst=/etc/caddy,readonly",
                       "--mount", f"type=bind,src={assets},dst=/srv/admin-ui,readonly"]
            for key, value in variables.items():
                command.extend(("--env", f"{key}={value}"))
            command.append(IMAGE)
            try:
                subprocess.run(command, capture_output=True, text=True, check=True)
                port = int(subprocess.check_output(["docker", "port", name, "443/tcp"], text=True).strip().rsplit(":", 1)[1])

                def request(path, authenticated=False, alias=False):
                    host = ("th-fixture" if alias else "tor-fixture") + ".fixture.invalid"
                    context = ssl._create_unverified_context()  # Disposable Caddy-local CA only.
                    with socket.create_connection(("127.0.0.1", port), timeout=3) as connection:
                        with context.wrap_socket(connection, server_hostname=host) as tls:
                            auth = "X-Fixture-Auth: allowed\r\n" if authenticated else ""
                            tls.sendall(f"GET {path} HTTP/1.1\r\nHost: {host}\r\n{auth}Connection: close\r\n\r\n".encode())
                            response = http.client.HTTPResponse(tls)
                            response.begin()
                            return response.status, dict(response.getheaders()), response.read()

                deadline = time.monotonic() + 15
                while True:
                    try:
                        status, _, _ = request("/")
                        self.assertEqual(status, 401, "Fixture auth gate is not active")
                        break
                    except (OSError, http.client.HTTPException):
                        if time.monotonic() >= deadline:
                            logs = subprocess.run(["docker", "logs", name], capture_output=True, text=True)
                            self.fail("Caddy did not start: " + logs.stderr)
                        time.sleep(0.1)
                yield request
            finally:
                subprocess.run(["docker", "rm", "--force", name], capture_output=True, text=True)

    def test_logout_uses_configured_auth_host_before_access_gate(self):
        for auth_host in ("auth01", "auth02"):
            with self.subTest(auth_host=auth_host), self.caddy(auth_host) as request:
                for alias in (False, True):
                    status, headers, _ = request("/logout?rd=https://unused.invalid/", alias=alias)
                    self.assertEqual(status, 302)
                    self.assertEqual(headers.get("Location"), f"https://{auth_host}.fixture.invalid/logout")
                    self.assertEqual(headers.get("Cache-Control"), "no-store")

    def test_html_fallback_is_not_stored(self):
        with self.caddy() as request:
            for path in ("/", "/index.html", "/unknown-spa-page", "/v2/old-spa-page"):
                with self.subTest(path=path):
                    status, headers, body = request(path, authenticated=True)
                    self.assertEqual(status, 200)
                    self.assertIn(b"<title>Fixture</title>", body)
                    self.assertEqual(headers.get("Cache-Control"), "no-store")

    def test_assets_keep_their_normal_cache_behavior(self):
        with self.caddy() as request:
            status, headers, body = request("/assets/app.js", authenticated=True)
            self.assertEqual(status, 200)
            self.assertIn(b"window.fixture", body)
            self.assertNotEqual(headers.get("Cache-Control"), "no-store")


if __name__ == "__main__":
    unittest.main()
