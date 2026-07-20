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
                request_id="a" * 32,
                advanced_complete=True,
                generated_credentials={"secret": "value"},
            )
            server.set_status("running", "Starting Home", edition="home")
            current = server.status_snapshot()
            self.assertEqual(current["logs"], ["advanced log"])
            self.assertEqual(current["edition"], "home")
            self.assertNotIn("request_id", current)
            self.assertNotIn("advanced_complete", current)
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
        self.assertEqual(config["TORHOLE_TOPOLOGY"], "single-lan")
        self.assertEqual(config["TZ"], "Europe/London")
        self.assertEqual(config["PIHOLE_PASSWORD"], "***")
        self.assertNotIn("CONTROL_PIN", config)

    def test_install_result_returns_home_credentials_for_success_receipt(self):
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

    def test_advanced_result_returns_preserved_administrator_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = root / "pi-dns-warden"
            app.mkdir()
            (app / ".env").write_text(
                "TORHOLE_TOPOLOGY=single-lan\n"
                "TORHOLE_ADMIN_USER=operator\n"
                "TORHOLE_ADMIN_PASSWORD=sso-secret\n"
                "PIHOLE_TRUSTED_PASSWORD=pihole-secret\n",
                encoding="utf-8",
            )
            with mock.patch.object(server, "ROOT_DIR", root):
                result = server.advanced_result()

        self.assertEqual(
            result["credentials"],
            {
                "TORHOLE_ADMIN_USER": "operator",
                "TORHOLE_ADMIN_PASSWORD": "sso-secret",
                "PIHOLE_TRUSTED_USER": "admin",
                "PIHOLE_TRUSTED_PASSWORD": "pihole-secret",
            },
        )
        self.assertNotIn("PIHOLE_IOT_PASSWORD", result["credentials"])

    def test_existing_install_receipt_recovers_advanced_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = root / "pi-dns-warden"
            app.mkdir()
            (app / ".env").write_text(
                "TORHOLE_EDITION=advanced\n"
                "TORHOLE_TOPOLOGY=single-lan\n"
                "TORHOLE_ADMIN_PASSWORD=sso-secret\n"
                "PIHOLE_TRUSTED_PASSWORD=pihole-secret\n",
                encoding="utf-8",
            )
            with mock.patch.object(server, "ROOT_DIR", root):
                result = server.existing_install_receipt()

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["edition"], "advanced")
        self.assertEqual(
            result["credentials"]["PIHOLE_TRUSTED_PASSWORD"], "pihole-secret"
        )


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


class AlertValidationTests(unittest.TestCase):
    def test_accepts_every_optional_alert_channel(self):
        result = server.validated_alerts(
            {
                "telegram": {
                    "enabled": True,
                    "bot_token": "123456:token",
                    "chat_id": "-100123456",
                },
                "email": {
                    "enabled": True,
                    "to": "operator@example.net",
                    "from": "torhole@example.net",
                    "smarthost": "smtp.example.net:587",
                    "auth_username": "torhole",
                    "auth_password": "secret",
                    "require_tls": True,
                },
                "discord": {
                    "enabled": True,
                    "webhook_url": "https://discord.com/api/webhooks/test",
                    "username": "torhole",
                },
            }
        )
        self.assertEqual(result["enabled_channels"], ["telegram", "email", "discord"])
        self.assertEqual(result["updates"]["ALERT_TELEGRAM_ENABLED"], "true")
        self.assertEqual(result["updates"]["ALERT_EMAIL_REQUIRE_TLS"], "true")
        self.assertEqual(result["updates"]["ALERT_DISCORD_ENABLED"], "true")

    def test_allows_no_channels_and_rejects_incomplete_enabled_channels(self):
        result = server.validated_alerts({})
        self.assertEqual(result["enabled_channels"], [])
        self.assertEqual(result["updates"]["ALERT_EMAIL_ENABLED"], "false")
        for value, message in (
            ({"telegram": {"enabled": True}}, "Telegram bot token"),
            ({"email": {"enabled": True}}, "Email recipient"),
            ({"discord": {"enabled": True}}, "Discord webhook URL"),
            (
                {
                    "discord": {
                        "enabled": True,
                        "webhook_url": "http://example.net/hook",
                    }
                },
                "must use HTTPS",
            ),
        ):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, message):
                server.validated_alerts(value)

    def test_keeps_existing_masked_secrets_on_reinstall(self):
        result = server.validated_alerts(
            {
                "telegram": {"enabled": True, "bot_token": "", "chat_id": ""},
                "discord": {"enabled": True, "webhook_url": ""},
            },
            {
                "ALERT_TELEGRAM_BOT_TOKEN": "stored-token",
                "ALERT_TELEGRAM_CHAT_ID": "stored-chat",
                "ALERT_DISCORD_WEBHOOK_URL": "https://discord.com/api/webhooks/stored",
            },
        )
        self.assertNotIn("ALERT_TELEGRAM_BOT_TOKEN", result["updates"])
        self.assertNotIn("ALERT_DISCORD_WEBHOOK_URL", result["updates"])


class AdvancedConfigTests(unittest.TestCase):
    def valid_config(self):
        return {
            "PARENT_IF": "eth0",
            "HOST_MGMT_IP": "192.168.1.10",
            "REVERSE_PROXY_DOMAIN": "lan.home.arpa",
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
        result = server.validated_advanced_config(self.valid_config(), "vlan")
        self.assertEqual(result["IOT_VLAN_ID"], "50")

        invalid = self.valid_config()
        invalid["PIHOLE_IOT_IP"] = "192.168.10.53"
        with self.assertRaisesRegex(ValueError, "inside IOT_SUBNET_CIDR"):
            server.validated_advanced_config(invalid, "vlan")

        duplicate = self.valid_config()
        duplicate["IOT_VLAN_ID"] = duplicate["TRUSTED_VLAN_ID"]
        with self.assertRaisesRegex(ValueError, "must be different"):
            server.validated_advanced_config(duplicate, "vlan")

        public_suffix = self.valid_config()
        public_suffix["REVERSE_PROXY_DOMAIN"] = "home.arpa"
        with self.assertRaisesRegex(ValueError, "cannot be bare home.arpa"):
            server.validated_advanced_config(public_suffix, "vlan")

    def test_validates_single_lan_without_iot_or_vlan_fields(self):
        config = self.valid_config()
        for key in (
            "TRUSTED_VLAN_ID",
            "IOT_PARENT",
            "IOT_VLAN_ID",
            "IOT_SUBNET_CIDR",
            "IOT_GATEWAY",
            "PIHOLE_IOT_IP",
        ):
            config.pop(key)

        result = server.validated_advanced_config(config, "single-lan")

        self.assertEqual(result["PIHOLE_TRUSTED_IP"], "192.168.10.53")
        self.assertNotIn("PIHOLE_IOT_IP", result)

    def test_rejects_unknown_advanced_topology(self):
        with self.assertRaisesRegex(ValueError, "single-lan or vlan"):
            server.validated_advanced_config(self.valid_config(), "flat")

    def test_validates_simple_web_access_modes(self):
        self.assertEqual(
            server.validated_web_access({"mode": "http"})["mode"], "http"
        )
        self.assertEqual(
            server.validated_web_access({"mode": "https-local"})["mode"],
            "https-local",
        )
        with self.assertRaisesRegex(ValueError, "HTTP, generated HTTPS"):
            server.validated_web_access({"mode": "automatic"})

    def test_custom_https_requires_pem_certificate_and_key(self):
        result = server.validated_web_access(
            {
                "mode": "https-custom",
                "certificate": "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----",
                "private_key": "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----",
            }
        )
        self.assertEqual(result["mode"], "https-custom")
        with self.assertRaisesRegex(ValueError, "PEM encoded"):
            server.validated_web_access(
                {"mode": "https-custom", "certificate": "bad", "private_key": "bad"}
            )

    def test_prepares_private_env_for_the_host_installer(self):
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
                    self.valid_config(),
                    "admin",
                    "Europe/Zurich",
                    "vlan",
                    blocklists=["oisd", "adguard"],
                    alerts={
                        "telegram": {
                            "enabled": True,
                            "bot_token": "123456:token",
                            "chat_id": "-100123456",
                        }
                    },
                )

            env_path = app / ".env"
            values = server.parse_env(env_path)
            self.assertEqual(values["TORHOLE_EDITION"], "advanced")
            self.assertEqual(values["TORHOLE_TOPOLOGY"], "vlan")
            self.assertEqual(values["BACKUP_MANAGER_ROOT_DIR"], str(app.resolve()))
            self.assertEqual(values["TORHOLE_WEB_MODE"], "https-local")
            self.assertEqual(values["TORHOLE_BLOCKLISTS"], "oisd,adguard")
            self.assertEqual(values["ALERT_TELEGRAM_ENABLED"], "true")
            self.assertEqual(values["ALERT_TELEGRAM_CHAT_ID"], "-100123456")
            self.assertEqual(values["PIHOLE_IOT_IP"], "192.168.50.53")
            self.assertNotEqual(values["TORHOLE_ADMIN_PASSWORD"], "CHANGE_ME")
            self.assertEqual(env_path.stat().st_mode & 0o777, 0o600)
            self.assertNotIn("deployment_command", result)
            self.assertIn("TORHOLE_ADMIN_PASSWORD", result["generated_credentials"])
            self.assertEqual(result["blocklists"], ["oisd", "adguard"])
            self.assertEqual(result["alerts"], ["telegram"])

    def test_single_lan_does_not_generate_unused_iot_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = root / "pi-dns-warden"
            app.mkdir()
            (app / ".env.example").write_text(
                "TORHOLE_EDITION=advanced\nTORHOLE_TOPOLOGY=vlan\nTZ=UTC\n"
                "PIHOLE_TRUSTED_PASSWORD=CHANGE_ME\n"
                "PIHOLE_IOT_PASSWORD=CHANGE_ME\n"
                "TORHOLE_ADMIN_PASSWORD=CHANGE_ME\n"
                "TOR_CONTROL_PASSWORD=CHANGE_ME\n"
                "DNSCRYPT_SOCKS_PASS_TRUSTED=CHANGE_ME\n"
                "DNSCRYPT_SOCKS_PASS_IOT=CHANGE_ME\n",
                encoding="utf-8",
            )
            config = self.valid_config()
            for key in server.ADVANCED_VLAN_KEYS:
                config.pop(key)
            with mock.patch.object(server, "ROOT_DIR", root):
                result = server.prepare_advanced_config(
                    config, "admin", "Europe/Zurich", "single-lan"
                )

            values = server.parse_env(app / ".env")
            self.assertEqual(values["TORHOLE_TOPOLOGY"], "single-lan")
            self.assertEqual(values["PIHOLE_IOT_PASSWORD"], "CHANGE_ME")
            self.assertNotIn("PIHOLE_IOT_PASSWORD", result["generated_credentials"])

    def test_custom_https_files_are_written_privately(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = root / "pi-dns-warden"
            app.mkdir()
            (app / ".env.example").write_text(
                "TORHOLE_EDITION=advanced\nTORHOLE_WEB_MODE=https-local\n"
                "PIHOLE_TRUSTED_PASSWORD=CHANGE_ME\n"
                "PIHOLE_IOT_PASSWORD=CHANGE_ME\n"
                "TORHOLE_ADMIN_PASSWORD=CHANGE_ME\n"
                "TOR_CONTROL_PASSWORD=CHANGE_ME\n"
                "DNSCRYPT_SOCKS_PASS_TRUSTED=CHANGE_ME\n"
                "DNSCRYPT_SOCKS_PASS_IOT=CHANGE_ME\n",
                encoding="utf-8",
            )
            cert = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n"
            key = "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n"
            with mock.patch.object(server, "ROOT_DIR", root):
                server.prepare_advanced_config(
                    self.valid_config(),
                    "admin",
                    "UTC",
                    "vlan",
                    {"mode": "https-custom", "certificate": cert, "private_key": key},
                )

            tls_dir = app / "monitoring" / "caddy" / "tls"
            self.assertEqual((tls_dir / "custom.crt").read_text(), cert)
            self.assertEqual((tls_dir / "custom.key").read_text(), key)
            self.assertEqual((tls_dir / "custom.key").stat().st_mode & 0o777, 0o600)
            values = server.parse_env(app / ".env")
            self.assertEqual(values["TORHOLE_WEB_MODE"], "https-custom")
            self.assertEqual(values["TORHOLE_WEB_SCHEME"], "https")

    def test_queues_only_the_fixed_host_operation_and_merges_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = root / "pi-dns-warden"
            run_dir = app / "run" / "bootstrap"
            run_dir.mkdir(parents=True)
            (app / ".env").write_text(
                "TORHOLE_TOPOLOGY=single-lan\nREVERSE_PROXY_DOMAIN=lan.home.arpa\n"
                "TORHOLE_HOST_TORHOLE=privacy\n",
                encoding="utf-8",
            )
            request = run_dir / "advanced-request.json"
            processing = run_dir / "advanced-request.processing.json"
            status = run_dir / "advanced-status.json"
            log = run_dir / "advanced-install.log"
            original = server.status_snapshot()
            try:
                with (
                    mock.patch.object(server, "ROOT_DIR", root),
                    mock.patch.object(server, "BOOTSTRAP_RUN_DIR", run_dir),
                    mock.patch.object(server, "ADVANCED_REQUEST_FILE", request),
                    mock.patch.object(server, "ADVANCED_PROCESSING_FILE", processing),
                    mock.patch.object(server, "ADVANCED_STATUS_FILE", status),
                    mock.patch.object(server, "ADVANCED_LOG_FILE", log),
                    mock.patch.object(server, "BOOTSTRAP_TOKEN", "t" * 48),
                ):
                    queued = server.queue_advanced_install(
                        {"env_path": str(app / ".env"), "generated_credentials": {}}
                    )
                    payload = json.loads(request.read_text(encoding="utf-8"))
                    self.assertEqual(payload["operation"], "deploy-advanced")
                    self.assertEqual(payload["token"], "t" * 48)
                    self.assertEqual(request.stat().st_mode & 0o777, 0o600)

                    log.write_text("Advanced checks passed.\n", encoding="utf-8")
                    status.write_text(
                        json.dumps(
                            {
                                "request_id": queued["request_id"],
                                "status": "success",
                                "message": "installed",
                            }
                        ),
                        encoding="utf-8",
                    )
                    complete = server.status_snapshot()
                    self.assertEqual(complete["status"], "success")
                    self.assertTrue(complete["advanced_complete"])
                    self.assertEqual(complete["topology"], "single-lan")
                    self.assertEqual(complete["pihole_iot_url"], "")
                    self.assertEqual(
                        complete["advanced_url"], "https://privacy.lan.home.arpa/"
                    )
                    self.assertEqual(complete["logs"], ["Advanced checks passed."])
            finally:
                with server._status_lock:
                    server._status.clear()
                    server._status.update(original)


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
