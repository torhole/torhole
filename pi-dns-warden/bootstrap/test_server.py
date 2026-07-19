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


class StatusTransitionTests(unittest.TestCase):
    def test_new_install_drops_stale_edition_receipt_fields_but_keeps_logs(self):
        original = server.status_snapshot()
        try:
            server.set_status(
                "success",
                "Advanced ready",
                logs=["advanced log"],
                edition="advanced",
                handoff=True,
                generated_credentials={"secret": "value"},
            )
            server.set_status("running", "Starting Home", edition="home")
            current = server.status_snapshot()
            self.assertEqual(current["logs"], ["advanced log"])
            self.assertEqual(current["edition"], "home")
            self.assertNotIn("handoff", current)
            self.assertNotIn("generated_credentials", current)
        finally:
            with server._status_lock:
                server._status.clear()
                server._status.update(original)


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
                "WEB_PORT=8080\nPIHOLE_WEB_PORT=8081\nPIHOLE_PASSWORD=secret\nCONTROL_PIN=123456\nTORHOLE_BLOCKLISTS=stevenblack,oisd\n",
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
        self.assertEqual(result["blocklists"], ["stevenblack", "oisd"])


class BlocklistValidationTests(unittest.TestCase):
    def test_accepts_known_lists_in_canonical_order(self):
        self.assertEqual(
            server.validated_blocklists(["adguard", "stevenblack"]),
            ["stevenblack", "adguard"],
        )

    def test_rejects_empty_unknown_and_duplicate_lists(self):
        for value in ([], ["unknown"], ["oisd", "oisd"], "oisd", None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                server.validated_blocklists(value)


class AdvancedConfigTests(unittest.TestCase):
    def valid_config(self):
        return {
            "PARENT_IF": "eth0",
            "HOST_MGMT_IP": "192.168.1.10",
            "REVERSE_PROXY_DOMAIN": "home.arpa",
            "TRUSTED_PARENT": "eth0.10",
            "TRUSTED_VLAN_ID": "10",
            "TRUSTED_SUBNET_CIDR": "192.168.10.0/24",
            "TRUSTED_GATEWAY": "192.168.10.1",
            "PIHOLE_TRUSTED_IP": "192.168.10.53",
            "IOT_PARENT": "eth0.50",
            "IOT_VLAN_ID": "50",
            "IOT_SUBNET_CIDR": "192.168.50.0/24",
            "IOT_GATEWAY": "192.168.50.1",
            "PIHOLE_IOT_IP": "192.168.50.53",
        }

    def test_validates_vlan_and_address_relationships(self):
        result = server.validated_advanced_config(self.valid_config())
        self.assertEqual(result["IOT_VLAN_ID"], "50")

        invalid = self.valid_config()
        invalid["PIHOLE_IOT_IP"] = "192.168.10.53"
        with self.assertRaisesRegex(ValueError, "inside IOT_SUBNET_CIDR"):
            server.validated_advanced_config(invalid)

        duplicate = self.valid_config()
        duplicate["IOT_VLAN_ID"] = duplicate["TRUSTED_VLAN_ID"]
        with self.assertRaisesRegex(ValueError, "must be different"):
            server.validated_advanced_config(duplicate)

    def test_prepares_private_env_without_touching_host_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = root / "pi-dns-warden"
            app.mkdir()
            (app / ".env.example").write_text(
                "TORHOLE_EDITION=advanced\nTZ=UTC\nPARENT_IF=eth0\n"
                "PIHOLE_TRUSTED_PASSWORD=CHANGE_ME\n"
                "PIHOLE_IOT_PASSWORD=CHANGE_ME\n"
                "TORHOLE_ADMIN_PASSWORD=CHANGE_ME\n"
                "TOR_CONTROL_PASSWORD=CHANGE_ME\n"
                "DNSCRYPT_SOCKS_PASS_TRUSTED=CHANGE_ME\n"
                "DNSCRYPT_SOCKS_PASS_IOT=CHANGE_ME\n",
                encoding="utf-8",
            )
            with mock.patch.object(server, "ROOT_DIR", root):
                result = server.prepare_advanced_config(
                    self.valid_config(), "admin", "Europe/Zurich"
                )

            env_path = app / ".env"
            values = server.parse_env(env_path)
            self.assertEqual(values["TORHOLE_EDITION"], "advanced")
            self.assertEqual(values["PIHOLE_IOT_IP"], "192.168.50.53")
            self.assertNotEqual(values["TORHOLE_ADMIN_PASSWORD"], "CHANGE_ME")
            self.assertEqual(env_path.stat().st_mode & 0o777, 0o600)
            self.assertIn("sudo ./deploy.sh", result["deployment_command"])
            self.assertIn("TORHOLE_ADMIN_PASSWORD", result["generated_credentials"])


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
