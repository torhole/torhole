import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SERVER_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("torhole_bootstrap_server", SERVER_PATH)
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class BootstrapAuthTests(unittest.TestCase):
    def test_cookie_requires_exact_token(self):
        token = "a" * 48
        self.assertTrue(
            server.cookie_authorized(f"other=x; {server.COOKIE_NAME}={token}", token)
        )
        self.assertFalse(server.cookie_authorized(f"{server.COOKIE_NAME}=wrong", token))
        self.assertFalse(server.cookie_authorized("", token))
        self.assertFalse(server.cookie_authorized(f"{server.COOKIE_NAME}={token}", ""))


class ResolveUiPathTests(unittest.TestCase):
    def test_resolves_assets_but_rejects_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve() / "ui"
            root.mkdir()
            (root / "index.html").write_text("index", encoding="utf-8")
            (root / "app.js").write_text("app", encoding="utf-8")
            (root.parent / "secret").write_text("secret", encoding="utf-8")

            self.assertEqual(server.resolve_ui_path("/", root), root / "index.html")
            self.assertEqual(server.resolve_ui_path("/app.js?v=1", root), root / "app.js")
            self.assertIsNone(server.resolve_ui_path("/%2e%2e/secret", root))


class PublicConfigTests(unittest.TestCase):
    def test_masks_password_and_exposes_only_bootstrap_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = root / "pi-dns-warden"
            app.mkdir()
            (app / ".env.quickstart.local").write_text(
                "TORHOLE_EDITION=home\nTZ=Europe/London\nPIHOLE_PASSWORD=secret\nCONTROL_PIN=123456\n",
                encoding="utf-8",
            )
            with mock.patch.object(server, "ROOT_DIR", root):
                config = server.public_config()

        self.assertEqual(config["TORHOLE_EDITION"], "home")
        self.assertEqual(config["TZ"], "Europe/London")
        self.assertEqual(config["PIHOLE_PASSWORD"], "***")
        self.assertNotIn("CONTROL_PIN", config)

    def test_install_result_returns_credentials_only_for_success_handoff(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = root / "pi-dns-warden"
            app.mkdir()
            (app / ".env.quickstart.local").write_text(
                "WEB_PORT=8080\nPIHOLE_WEB_PORT=8081\nPIHOLE_PASSWORD=secret\nCONTROL_PIN=123456\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(server, "ROOT_DIR", root),
                mock.patch.object(server, "HOST_ADDRESS", "192.0.2.10"),
            ):
                result = server.install_result()

        self.assertEqual(result["pihole_password"], "secret")
        self.assertEqual(result["control_pin"], "123456")
        self.assertEqual(result["home_url"], "http://192.0.2.10:8080/")


class RuntimeVerificationTests(unittest.TestCase):
    def test_collects_tor_dns_and_isolation_evidence(self):
        outputs = [
            json.dumps({"IsTor": True, "IP": "203.0.113.7"}),
            "93.184.216.34\n",
            json.dumps({"torhole_qs_dns_int": {}}),
            "true",
        ]
        with mock.patch.object(server, "container_command", side_effect=outputs):
            result = server.runtime_verification()

        self.assertTrue(result["tor"]["ok"])
        self.assertEqual(result["tor"]["exit_ip"], "203.0.113.7")
        self.assertTrue(result["dns"]["ok"])
        self.assertEqual(result["dns"]["answer"], "93.184.216.34")
        self.assertTrue(result["isolation"]["ok"])

    def test_failed_probe_is_reported_without_raising(self):
        with mock.patch.object(server, "container_command", side_effect=RuntimeError("unavailable")):
            result = server.runtime_verification()

        self.assertFalse(result["tor"]["ok"])
        self.assertFalse(result["dns"]["ok"])
        self.assertFalse(result["isolation"]["ok"])


if __name__ == "__main__":
    unittest.main()
