"""Characterization tests for backup-manager/server.py (T-049, audit T1/M3.2).

These tests pin the CURRENT behavior of the pure logic layer so the planned
modularization (T-048) and privileged-helper split (T-054) can refactor with
confidence. They intentionally document quirks (e.g. last-duplicate-wins env
parsing) rather than fix them — behavior changes belong in their own commits.

Runs under plain unittest (python3 test_characterization.py) and pytest.
No network, no Docker, no filesystem writes outside tempdirs.
"""

import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

SERVER_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("backup_manager_server_char", SERVER_PATH)
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class HostRootDetectionTests(unittest.TestCase):
    def test_uses_workspace_bind_source_from_docker_metadata(self):
        inspect_payload = json.dumps(
            [
                {
                    "Mounts": [
                        {
                            "Type": "bind",
                            "Source": "/home/debian/torhole/pi-dns-warden",
                            "Destination": "/workspace",
                        }
                    ]
                }
            ]
        )
        completed = mock.Mock(returncode=0, stdout=inspect_payload)
        with mock.patch.object(server.subprocess, "run", return_value=completed):
            result = server._detect_host_root_dir(
                Path("/workspace"), Path("/opt/pi-dns-warden")
            )

        self.assertEqual(result, Path("/home/debian/torhole/pi-dns-warden"))

    def test_falls_back_to_configured_path_when_inspection_fails(self):
        completed = mock.Mock(returncode=1, stdout="")
        with mock.patch.object(server.subprocess, "run", return_value=completed):
            result = server._detect_host_root_dir(
                Path("/workspace"), Path("/srv/torhole")
            )

        self.assertEqual(result, Path("/srv/torhole"))


class RecoveryBusyTests(unittest.TestCase):
    def test_stale_running_status_does_not_count_as_busy(self):
        with self.subTest("kernel lock is authoritative"):
            import tempfile

            with tempfile.TemporaryDirectory() as tmp:
                lock_file = Path(tmp) / "recovery.lock"
                with mock.patch.object(server, "RUN_DIR", Path(tmp)), mock.patch.object(
                    server, "RECOVERY_LOCK_FILE", lock_file
                ), mock.patch.object(
                    server,
                    "read_status",
                    return_value={"status": "running"},
                ):
                    self.assertFalse(server.recovery_busy())

    def test_active_kernel_lock_counts_as_busy(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            lock_file = Path(tmp) / "recovery.lock"
            with lock_file.open("a+", encoding="utf-8") as holder:
                server.fcntl.flock(holder.fileno(), server.fcntl.LOCK_EX)
                with mock.patch.object(server, "RUN_DIR", Path(tmp)), mock.patch.object(
                    server, "RECOVERY_LOCK_FILE", lock_file
                ):
                    self.assertTrue(server.recovery_busy())
                server.fcntl.flock(holder.fileno(), server.fcntl.LOCK_UN)


class WebAccessUpgradeTests(unittest.TestCase):
    def test_http_upgrade_renders_validates_and_schedules_narrow_activation(self):
        current = {"TORHOLE_WEB_MODE": "http", "HOST_MGMT_IP": "10.0.0.149"}
        updated = {
            "TORHOLE_WEB_MODE": "https-local",
            "HOST_MGMT_IP": "10.0.0.149",
            "REVERSE_PROXY_DOMAIN": "hplab.local",
            "TORHOLE_HOST_TORHOLE": "torhole",
        }
        completed = mock.Mock(returncode=0, stdout="", stderr="")
        with mock.patch.object(
            server, "read_env_values_safe", side_effect=[current, updated]
        ), mock.patch.object(
            server, "update_env_keys", return_value=(Path("/tmp/env-backup"), updated)
        ) as update, mock.patch.object(
            server, "run_auth_render", return_value=completed
        ), mock.patch.object(
            server,
            "run_system_validation",
            return_value={"status": "success", "summary": "ok"},
        ), mock.patch.object(
            server, "schedule_local_https_activation", return_value=completed
        ) as schedule, mock.patch.object(
            server, "get_config_values", return_value=updated
        ):
            result = server.enable_local_https()

        update.assert_called_once_with(
            {"TORHOLE_WEB_MODE": "https-local", "TORHOLE_WEB_SCHEME": "https"},
            allow_secret_keys=False,
        )
        schedule.assert_called_once_with()
        self.assertTrue(result["scheduled"])
        self.assertEqual(result["https_url"], "https://torhole.hplab.local/")
        self.assertEqual(
            result["certificate_url"],
            "http://10.0.0.149/torhole-local-ca.crt",
        )

    def test_custom_https_can_switch_back_to_generated_https(self):
        current = {"TORHOLE_WEB_MODE": "https-custom"}
        updated = {
            "TORHOLE_WEB_MODE": "https-local",
            "HOST_MGMT_IP": "10.0.0.149",
            "REVERSE_PROXY_DOMAIN": "hplab.local",
        }
        completed = mock.Mock(returncode=0, stdout="", stderr="")
        with mock.patch.object(
            server,
            "read_env_values_safe",
            side_effect=[current, updated],
        ), mock.patch.object(
            server, "update_env_keys", return_value=(Path("/tmp/env-backup"), updated)
        ) as update, mock.patch.object(
            server, "run_auth_render", return_value=completed
        ), mock.patch.object(
            server,
            "run_system_validation",
            return_value={"status": "success", "summary": "ok"},
        ), mock.patch.object(
            server, "schedule_local_https_activation", return_value=completed
        ), mock.patch.object(server, "get_config_values", return_value=updated):
            result = server.enable_local_https()

        update.assert_called_once_with(
            {"TORHOLE_WEB_MODE": "https-local", "TORHOLE_WEB_SCHEME": "https"},
            allow_secret_keys=False,
        )
        self.assertTrue(result["scheduled"])
        self.assertEqual(
            result["certificate_url"],
            "http://10.0.0.149/torhole-local-ca.crt",
        )

    def test_custom_https_writes_private_files_then_validates_and_schedules(self):
        cert = "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----\n"
        key = "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n"
        completed = mock.Mock(returncode=0, stdout="", stderr="")
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            server, "ROOT_DIR", Path(tmp)
        ), mock.patch.object(
            server,
            "read_env_values_safe",
            side_effect=[
                {"TORHOLE_WEB_MODE": "https-local"},
                {
                    "TORHOLE_WEB_MODE": "https-custom",
                    "HOST_MGMT_IP": "10.0.0.149",
                    "REVERSE_PROXY_DOMAIN": "hplab.local",
                },
            ],
        ), mock.patch.object(
            server,
            "update_env_keys",
            return_value=(Path(tmp) / ".env.backup", {}),
        ), mock.patch.object(
            server, "run_auth_render", return_value=completed
        ), mock.patch.object(
            server,
            "run_system_validation",
            return_value={"status": "success", "summary": "ok"},
        ), mock.patch.object(
            server, "schedule_local_https_activation", return_value=completed
        ), mock.patch.object(server, "get_config_values", return_value={}):
            result = server.configure_https("https-custom", cert, key)
            cert_path = Path(tmp) / "monitoring/caddy/tls/custom.crt"
            key_path = Path(tmp) / "monitoring/caddy/tls/custom.key"
            self.assertEqual(cert_path.read_text(), cert)
            self.assertEqual(key_path.read_text(), key)
            self.assertEqual(key_path.stat().st_mode & 0o777, 0o600)

        self.assertTrue(result["scheduled"])
        self.assertIsNone(result["certificate_url"])

    def test_custom_https_rejects_non_pem_before_writing(self):
        with mock.patch.object(server, "update_env_keys") as update:
            with self.assertRaisesRegex(ValueError, "must be PEM encoded"):
                server.configure_https("https-custom", "not a cert", "not a key")
        update.assert_not_called()

    def test_activation_helper_mounts_project_at_real_host_path(self):
        completed = mock.Mock(returncode=0, stdout="container-id", stderr="")
        with mock.patch.object(server, "HOST_ROOT_DIR", Path("/srv/torhole")), mock.patch.object(
            server.subprocess, "run", return_value=completed
        ) as run:
            result = server.schedule_local_https_activation()

        self.assertEqual(result.returncode, 0)
        command = run.call_args.args[0]
        self.assertIn("/srv/torhole:/srv/torhole", command)
        self.assertIn("./ops/scripts/25-apply-web-access.sh", command[-1])


class ParseEnvTextTests(unittest.TestCase):
    def test_basic_pairs_and_whitespace(self):
        values = server.parse_env_text("A=1\n B = spaced \nC=with=equals\n")
        self.assertEqual(values["A"], "1")
        self.assertEqual(values["B"], "spaced")
        self.assertEqual(values["C"], "with=equals")

    def test_comments_and_blank_lines_skipped(self):
        values = server.parse_env_text("# comment\n\nA=1\n  # indented comment\n")
        self.assertEqual(values, {"A": "1"})

    def test_line_without_equals_skipped(self):
        self.assertEqual(server.parse_env_text("JUNK\nA=1"), {"A": "1"})

    def test_duplicate_key_last_wins(self):
        # Characterizes the exact quirk behind the 2026-07-13 staging telegram
        # outage: a later empty duplicate silently overrides the real value.
        values = server.parse_env_text("TOKEN=real\nTOKEN=\n")
        self.assertEqual(values["TOKEN"], "")

    def test_empty_value_preserved(self):
        self.assertEqual(server.parse_env_text("A="), {"A": ""})


class UpdateEnvValueTextTests(unittest.TestCase):
    def test_updates_existing_key_in_place(self):
        text = "A=1\nB=2\n"
        self.assertEqual(server.update_env_value_text(text, "A", "9"), "A=9\nB=2\n")

    def test_appends_missing_key_with_newline(self):
        self.assertEqual(server.update_env_value_text("A=1\n", "B", "2"), "A=1\nB=2\n")

    def test_appends_adds_newline_when_text_lacks_one(self):
        self.assertEqual(server.update_env_value_text("A=1", "B", "2"), "A=1\nB=2\n")

    def test_only_first_duplicate_is_replaced(self):
        # With duplicates present, only the FIRST occurrence is rewritten while
        # parse_env_text honors the LAST — a real footgun this suite pins so
        # the refactor must address it deliberately (or keep documenting it).
        text = "TOKEN=old\nTOKEN=\n"
        updated = server.update_env_value_text(text, "TOKEN", "new")
        self.assertEqual(updated, "TOKEN=new\nTOKEN=\n")
        self.assertEqual(server.parse_env_text(updated)["TOKEN"], "")

    def test_key_is_regex_escaped(self):
        text = "A.B=1\nAxB=2\n"
        updated = server.update_env_value_text(text, "A.B", "9")
        self.assertIn("A.B=9", updated)
        self.assertIn("AxB=2", updated)


class RejectControlCharsTests(unittest.TestCase):
    def test_rejects_newline_cr_nul(self):
        for bad in ("a\nb", "a\rb", "a\x00b"):
            with self.assertRaises(ValueError):
                server._reject_env_control_chars("KEY", bad)

    def test_accepts_normal_and_tab(self):
        server._reject_env_control_chars("KEY", "ordinary value")
        server._reject_env_control_chars("KEY", "tab\tallowed")


class ApplySetupConfigTests(unittest.TestCase):
    def test_persists_home_edition_through_atomic_env_writer(self):
        with mock.patch.object(
            server, "read_env_values_safe", return_value={"TORHOLE_EDITION": "advanced"}
        ), mock.patch.object(
            server,
            "update_env_keys",
            return_value=(Path("/workspace/.env.bak-test"), {"TORHOLE_EDITION": "home"}),
        ) as update:
            result = server.apply_setup_config({"edition": "home"})

        update.assert_called_once_with(
            {"TORHOLE_EDITION": "home"}, allow_secret_keys=False
        )
        self.assertTrue(result["ok"])
        self.assertEqual(
            result["changes"],
            [{"key": "TORHOLE_EDITION", "old": "advanced", "new": "home"}],
        )
        self.assertIn("not stopped or replaced", result["message"])

    def test_rejects_unknown_edition_before_writing(self):
        with mock.patch.object(server, "update_env_keys") as update:
            with self.assertRaisesRegex(ValueError, "home.*advanced"):
                server.apply_setup_config({"edition": "enterprise"})
        update.assert_not_called()

    def test_records_advanced_single_lan_topology_for_explicit_deploy(self):
        current = {
            "TORHOLE_EDITION": "advanced",
            "TORHOLE_TOPOLOGY": "vlan",
        }
        with mock.patch.object(
            server, "read_env_values_safe", return_value=current
        ), mock.patch.object(
            server,
            "update_env_keys",
            return_value=(Path("/workspace/.env.bak-test"), {}),
        ) as update:
            result = server.apply_setup_config(
                {"edition": "advanced", "topology": "single-lan"}
            )

        update.assert_called_once_with(
            {"TORHOLE_TOPOLOGY": "single-lan"}, allow_secret_keys=False
        )
        self.assertEqual(result["changes"][0]["key"], "TORHOLE_TOPOLOGY")
        self.assertIn("deploy.sh", result["message"])

    def test_rejects_unknown_topology_before_writing(self):
        with mock.patch.object(server, "update_env_keys") as update:
            with self.assertRaisesRegex(ValueError, "single-lan.*vlan"):
                server.apply_setup_config({"topology": "flat"})
        update.assert_not_called()


class BackendAuthTests(unittest.TestCase):
    def test_public_routes(self):
        self.assertFalse(server.requires_backend_auth("/health"))
        self.assertFalse(server.requires_backend_auth("/api/metrics/tor"))

    def test_unknown_routes_are_protected(self):
        self.assertTrue(server.requires_backend_auth("/api/anything-else"))
        self.assertTrue(server.requires_backend_auth("/"))

    def test_token_comparison(self):
        tok = "x" * 32
        ok = server.is_backend_request_authorized({"Authorization": f"Bearer {tok}"}, tok)
        self.assertTrue(ok)
        self.assertFalse(server.is_backend_request_authorized({}, tok))
        self.assertFalse(
            server.is_backend_request_authorized({"Authorization": "Bearer wrong"}, tok)
        )

    def test_no_expected_token_fails_closed(self):
        self.assertFalse(
            server.is_backend_request_authorized({"Authorization": "Bearer any"}, "")
        )
        self.assertFalse(
            server.is_backend_request_authorized({"Authorization": "Bearer any"}, None)
        )


class ArchiveNameTests(unittest.TestCase):
    def test_pattern_accepts_canonical_name(self):
        self.assertTrue(
            server.ARCHIVE_PATTERN.fullmatch("torhole-backup-20260713-160910.tar.gz")
        )

    def test_resolve_rejects_traversal_and_junk(self):
        for bad in (
            "../../../etc/passwd",
            "torhole-backup-20260713-160910.tar.gz/../x",
            "torhole-backup-2026-bad.tar.gz",
            "other-backup-20260713-160910.tar.gz",
            "",
        ):
            with self.assertRaises(ValueError, msg=bad):
                server.resolve_backup_archive(bad)


class IsTruthyTests(unittest.TestCase):
    def test_truthy_variants(self):
        for v in ("1", "true", "TRUE", "yes", "on", "True"):
            self.assertTrue(server.is_truthy(v), v)

    def test_falsy_variants(self):
        for v in ("", "0", "false", "no", "off", None):
            self.assertFalse(server.is_truthy(v), repr(v))


class TimeHelpersTests(unittest.TestCase):
    def test_parse_iso_z_suffix(self):
        parsed = server.parse_iso_datetime("2026-07-13T12:00:00Z")
        self.assertEqual(parsed.tzinfo, timezone.utc)

    def test_parse_invalid_returns_none(self):
        self.assertIsNone(server.parse_iso_datetime("not-a-date"))
        self.assertIsNone(server.parse_iso_datetime(""))
        self.assertIsNone(server.parse_iso_datetime(None))

    def test_humanize_buckets(self):
        now = datetime.now(timezone.utc)
        fmt = lambda dt: dt.strftime("%Y-%m-%dT%H:%M:%S+00:00")
        self.assertEqual(server.humanize_time_ago(fmt(now)), "just now")
        self.assertEqual(server.humanize_time_ago(fmt(now - timedelta(minutes=5))), "5 minutes ago")
        self.assertEqual(server.humanize_time_ago(fmt(now - timedelta(hours=1))), "1 hour ago")
        self.assertEqual(server.humanize_time_ago(fmt(now - timedelta(days=3))), "3 days ago")
        self.assertEqual(server.humanize_time_ago("garbage"), "unknown time")

    def test_future_timestamps_clamp_to_just_now(self):
        future = datetime.now(timezone.utc) + timedelta(hours=2)
        self.assertEqual(
            server.humanize_time_ago(future.strftime("%Y-%m-%dT%H:%M:%S+00:00")),
            "just now",
        )


class StatusMathTests(unittest.TestCase):
    def test_status_rank_order(self):
        self.assertEqual(server.status_rank("offline"), 2)
        self.assertEqual(server.status_rank("degraded"), 1)
        self.assertEqual(server.status_rank("healthy"), 0)
        self.assertEqual(server.status_rank("anything-unknown"), 0)

    def test_combine_statuses_takes_worst(self):
        self.assertEqual(server.combine_statuses("healthy", "degraded", "healthy"), "degraded")
        self.assertEqual(server.combine_statuses("degraded", "offline"), "offline")
        self.assertEqual(server.combine_statuses(), "healthy")

    def test_service_counts_unknown_status_counts_offline(self):
        counts = server.service_counts(
            [{"status": "healthy"}, {"status": "weird"}, {}]
        )
        self.assertEqual(counts, {"healthy": 1, "degraded": 0, "offline": 2, "total": 3})

    def test_overall_and_summary(self):
        counts = {"healthy": 1, "degraded": 0, "offline": 1, "total": 2}
        self.assertEqual(server.overall_status_from_counts(counts), "offline")
        self.assertEqual(server.summary_from_counts(counts), "1 healthy, 0 degraded, 1 offline")


class QueryNormalizationTests(unittest.TestCase):
    def test_status_buckets(self):
        self.assertEqual(server._normalize_query_status("GRAVITY"), "blocked")
        self.assertEqual(server._normalize_query_status("REGEX_CNAME"), "blocked")
        self.assertEqual(server._normalize_query_status("EXTERNAL_BLOCKED_IP"), "blocked")
        self.assertEqual(server._normalize_query_status("FORWARDED"), "forwarded")
        self.assertEqual(server._normalize_query_status("RETRIED"), "forwarded")
        self.assertEqual(server._normalize_query_status("CACHE"), "cached")
        self.assertEqual(server._normalize_query_status("CACHE_STALE"), "cached")
        self.assertEqual(server._normalize_query_status("SPECIAL_DOMAIN"), "other")
        self.assertEqual(server._normalize_query_status(None), "other")

    def test_normalize_pihole_query_shape(self):
        raw = {
            "id": 7,
            "time": 1234.5,
            "domain": "example.com",
            "type": "A",
            "status": "FORWARDED",
            "client": {"ip": "192.0.2.5", "name": "laptop"},
            "reply": {"type": "IP", "time": 0.0421},
        }
        out = server._normalize_pihole_query(raw, "trusted")
        self.assertEqual(out["plane"], "trusted")
        self.assertEqual(out["status"], "forwarded")
        self.assertEqual(out["raw_status"], "FORWARDED")
        self.assertEqual(out["client_ip"], "192.0.2.5")
        self.assertEqual(out["reply_time_ms"], 42.1)

    def test_normalize_tolerates_missing_fields(self):
        out = server._normalize_pihole_query({}, "iot")
        self.assertEqual(out["plane"], "iot")
        self.assertIsNone(out["domain"])
        self.assertIsNone(out["client_ip"])
        self.assertIsNone(out["reply_time_ms"])


class TorCircuitParsingTests(unittest.TestCase):
    PAYLOAD = (
        "250+circuit-status=\r\n"
        "1 BUILT $AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA~guard,"
        "$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB~middle,"
        "$CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC~exit"
        " PURPOSE=GENERAL TIME_CREATED=2026-07-13T12:00:00.000000"
        ' SOCKS_USERNAME="trusted"\r\n'
        "2 LAUNCHED $DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD\r\n"
        ".\r\n"
        "250 OK\r\n"
    ).replace("\r\n", "\n")

    def test_parses_paths_and_kv(self):
        circuits = server._parse_circuit_status(self.PAYLOAD)
        self.assertEqual(len(circuits), 2)
        built = circuits[0]
        self.assertEqual(built["id"], "1")
        self.assertEqual(built["state"], "BUILT")
        self.assertEqual(built["hops"], 3)
        self.assertEqual(built["path"][0]["nickname"], "guard")
        self.assertEqual(built["purpose"], "GENERAL")
        self.assertEqual(built["socks_username"], "trusted")
        launched = circuits[1]
        self.assertEqual(launched["state"], "LAUNCHED")
        self.assertEqual(launched["path"][0]["nickname"], "(unnamed)")

    def test_ignores_noise_outside_envelope(self):
        self.assertEqual(server._parse_circuit_status("650 NOTICE whatever\n250 OK\n"), [])


class ChunkedDecoderTests(unittest.TestCase):
    def test_decodes_two_chunks(self):
        body = b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"
        self.assertEqual(server._decode_chunked(body), b"hello world")

    def test_chunk_extension_ignored(self):
        body = b"5;ext=1\r\nhello\r\n0\r\n\r\n"
        self.assertEqual(server._decode_chunked(body), b"hello")

    def test_truncated_chunk_stops_cleanly(self):
        body = b"ff\r\nshort"
        self.assertEqual(server._decode_chunked(body), b"")

    def test_garbage_size_stops_cleanly(self):
        self.assertEqual(server._decode_chunked(b"zz\r\nnope\r\n"), b"")


class Socks5ReasonTests(unittest.TestCase):
    def test_known_and_unknown_codes(self):
        self.assertEqual(server._socks5_reason(5), "connection refused")
        self.assertEqual(server._socks5_reason(99), "unknown")


class PublicLinksTests(unittest.TestCase):
    def test_no_domain_no_links(self):
        self.assertEqual(server.build_public_links({}), {})

    def test_links_use_custom_hosts_and_defaults(self):
        values = {
            "REVERSE_PROXY_DOMAIN": "lab.example.com",
            "TORHOLE_HOST_TORHOLE": "custom",
        }
        links = server.build_public_links(values)
        self.assertEqual(links["torhole"], "https://custom.lab.example.com")
        self.assertEqual(links["auth"], "https://auth.lab.example.com")
        self.assertTrue(links["pihole_trusted"].endswith("/admin/"))
        # Guest plane must not resurface (removed 2026-07-13).
        self.assertNotIn("pihole_guest", links)


class ConfigCapabilityTests(unittest.TestCase):
    def test_single_lan_config_hides_vlan_and_iot_parameters(self):
        values = {
            "TORHOLE_TOPOLOGY": "single-lan",
            "PIHOLE_TRUSTED_IP": "10.0.0.151",
            "TRUSTED_VLAN_ID": "1",
            "PIHOLE_IOT_IP": "10.0.50.53",
            "DNSCRYPT_SOCKS_USER_IOT": "iot",
            "TORHOLE_HOST_PIHOLE_IOT": "pihole-iot",
        }
        with mock.patch.object(server, "TORHOLE_TOPOLOGY", "single-lan"), mock.patch.object(
            server, "read_env_values", return_value=values
        ):
            result = server.get_config_values()

        self.assertEqual(result["PIHOLE_TRUSTED_IP"], "10.0.0.151")
        self.assertNotIn("TRUSTED_VLAN_ID", result)
        self.assertNotIn("PIHOLE_IOT_IP", result)
        self.assertNotIn("DNSCRYPT_SOCKS_USER_IOT", result)
        self.assertNotIn("TORHOLE_HOST_PIHOLE_IOT", result)

    def test_vlan_config_keeps_iot_parameters(self):
        values = {
            "TORHOLE_TOPOLOGY": "vlan",
            "PIHOLE_IOT_IP": "10.0.50.53",
            "DNSCRYPT_SOCKS_USER_IOT": "iot",
        }
        with mock.patch.object(server, "TORHOLE_TOPOLOGY", "vlan"), mock.patch.object(
            server, "read_env_values", return_value=values
        ):
            result = server.get_config_values()

        self.assertEqual(result["PIHOLE_IOT_IP"], "10.0.50.53")
        self.assertEqual(result["DNSCRYPT_SOCKS_USER_IOT"], "iot")

    def test_single_lan_rejects_direct_edit_of_inactive_iot_key(self):
        with mock.patch.object(server, "TORHOLE_TOPOLOGY", "single-lan"), mock.patch.object(
            server, "update_env_keys"
        ) as update:
            with self.assertRaisesRegex(ValueError, "not active.*single-lan"):
                server.set_config_value("PIHOLE_IOT_IP", "10.0.50.53")

        update.assert_not_called()


class ValidationParsingTests(unittest.TestCase):
    def test_all_success_when_returncode_zero(self):
        checks = server.parse_validation_checks("", 0)
        self.assertTrue(checks)
        self.assertTrue(all(c["status"] == "success" for c in checks))

    def test_failure_marks_last_seen_marker_as_error(self):
        expected = server.detect_validation_checks()
        first, second = expected[0], expected[1]
        output = f"[validate] {first['marker']}\n[validate] {second['marker']}\n"
        checks = server.parse_validation_checks(output, 1)
        by_id = {c["id"]: c["status"] for c in checks}
        self.assertEqual(by_id[second["id"]], "error")
        self.assertEqual(by_id[first["id"]], "success")
        # Everything after the failure point is skipped, not success.
        remaining = [c["status"] for c in checks if c["id"] not in (first["id"], second["id"])]
        self.assertTrue(all(s == "skipped" for s in remaining))

    def test_summary_names_failed_step(self):
        checks = [{"id": "x", "label": "Step X", "status": "error"}]
        self.assertEqual(server.validation_summary(checks, False), "Validation failed at Step X.")
        self.assertEqual(
            server.validation_summary([], True), "Stack configuration validated successfully."
        )


class SnapshotHeadlineTests(unittest.TestCase):
    def test_privacy_lost_dominates(self):
        headline = server._compose_snapshot_headline(
            False, "healthy", {"healthy": 2, "total": 2}, {"offline": 0, "degraded": 0}
        )
        self.assertIn("compromised", headline)

    def test_all_healthy(self):
        headline = server._compose_snapshot_headline(
            True, "healthy", {"healthy": 2, "total": 2}, {"offline": 0, "degraded": 0}
        )
        self.assertEqual(
            headline, "Privacy guarantee intact. 2/2 DNS planes serving via Tor."
        )

    def test_intact_but_container_issues(self):
        headline = server._compose_snapshot_headline(
            True, "degraded", {"healthy": 2, "total": 2}, {"offline": 1, "degraded": 2}
        )
        self.assertEqual(
            headline,
            "Privacy guarantee intact, but 1 container offline and 2 containers degraded.",
        )


class ComposeBannerTests(unittest.TestCase):
    def test_no_text_means_no_banner(self):
        self.assertIsNone(server._compose_banner({}))
        self.assertIsNone(server._compose_banner({"TORHOLE_BANNER_TEXT": "  "}))

    def test_level_normalization(self):
        b = server._compose_banner(
            {"TORHOLE_BANNER_TEXT": "Staging", "TORHOLE_BANNER_LEVEL": "WARNING"}
        )
        self.assertEqual(b, {"text": "Staging", "level": "warning"})

    def test_unknown_level_defaults_to_info(self):
        b = server._compose_banner(
            {"TORHOLE_BANNER_TEXT": "x", "TORHOLE_BANNER_LEVEL": "purple"}
        )
        self.assertEqual(b["level"], "info")

    def test_missing_level_defaults_to_info(self):
        b = server._compose_banner({"TORHOLE_BANNER_TEXT": "x"})
        self.assertEqual(b["level"], "info")


class InsightsNormalizationTests(unittest.TestCase):
    def test_top_domains_shape_and_defenses(self):
        payload = {
            "domains": [
                {"domain": "example.com", "count": 42},
                {"domain": "", "count": 5},          # dropped: empty name
                "garbage",                             # dropped: not a dict
                {"domain": "no-count.io"},            # count defaults to 0
            ]
        }
        self.assertEqual(
            server._normalize_top_domains(payload),
            [{"name": "example.com", "count": 42}, {"name": "no-count.io", "count": 0}],
        )
        self.assertEqual(server._normalize_top_domains(None), [])
        self.assertEqual(server._normalize_top_domains({}), [])

    def test_top_clients_shape(self):
        payload = {
            "clients": [
                {"ip": "192.0.2.5", "name": "laptop", "count": 7},
                {"ip": "192.0.2.6", "name": "", "count": 3},  # empty name -> None
                {"name": "no-ip", "count": 1},                # dropped: no ip
            ]
        }
        self.assertEqual(
            server._normalize_top_clients(payload),
            [
                {"ip": "192.0.2.5", "name": "laptop", "count": 7},
                {"ip": "192.0.2.6", "name": None, "count": 3},
            ],
        )


class BackupScheduleConfigTests(unittest.TestCase):
    def _with_env(self, values):
        with mock.patch.object(server, "read_env_values_safe", return_value=values):
            return server._backup_schedule_config()

    def test_defaults_disabled_with_keep_7(self):
        self.assertEqual(self._with_env({}), (0.0, 7))

    def test_parses_interval_and_retention(self):
        self.assertEqual(
            self._with_env(
                {"TORHOLE_BACKUP_INTERVAL_H": "24", "TORHOLE_BACKUP_RETENTION": "3"}
            ),
            (24.0, 3),
        )

    def test_garbage_values_fall_back(self):
        self.assertEqual(
            self._with_env(
                {"TORHOLE_BACKUP_INTERVAL_H": "daily", "TORHOLE_BACKUP_RETENTION": "many"}
            ),
            (0.0, 7),
        )

    def test_negative_values_clamped(self):
        self.assertEqual(
            self._with_env(
                {"TORHOLE_BACKUP_INTERVAL_H": "-5", "TORHOLE_BACKUP_RETENTION": "-1"}
            ),
            (0.0, 0),
        )


class PruneBackupArchivesTests(unittest.TestCase):
    def test_keeps_newest_n_deletes_rest(self):
        backups = [{"name": f"torhole-backup-2026071{i}-000000.tar.gz"} for i in range(5)]
        deleted = []
        with mock.patch.object(server, "list_backups", return_value=backups), mock.patch.object(
            server, "delete_backup_archive", side_effect=lambda n: deleted.append(n)
        ):
            result = server.prune_backup_archives(2)
        # list_backups is newest-first; entries [2:] are the oldest three.
        self.assertEqual(result, [b["name"] for b in backups[2:]])
        self.assertEqual(deleted, result)

    def test_keep_zero_disables_retention(self):
        with mock.patch.object(server, "list_backups") as lb:
            self.assertEqual(server.prune_backup_archives(0), [])
            lb.assert_not_called()

    def test_delete_errors_do_not_abort(self):
        backups = [{"name": f"torhole-backup-2026071{i}-000000.tar.gz"} for i in range(3)]

        def flaky(name):
            if name.endswith("1-000000.tar.gz"):
                raise OSError("busy")

        with mock.patch.object(server, "list_backups", return_value=backups), mock.patch.object(
            server, "delete_backup_archive", side_effect=flaky
        ):
            result = server.prune_backup_archives(1)
        # The failing archive is skipped; the other old one is still deleted.
        self.assertEqual(result, [backups[2]["name"]])


class PiholeTlsContextTests(unittest.TestCase):
    def test_no_ca_file_falls_back_to_unverified(self):
        import os
        import ssl as _ssl

        with mock.patch.dict(os.environ, {"PIHOLE_CA_FILE": ""}):
            ctx = server._pihole_tls_context()
        self.assertEqual(ctx.verify_mode, _ssl.CERT_NONE)

    def test_nonexistent_ca_path_falls_back(self):
        import os
        import ssl as _ssl

        with mock.patch.dict(os.environ, {"PIHOLE_CA_FILE": "/no/such/ca.pem"}):
            ctx = server._pihole_tls_context()
        self.assertEqual(ctx.verify_mode, _ssl.CERT_NONE)


class SendTestAlertTests(unittest.TestCase):
    def _capture_alert(self):
        captured = {}

        class FakeResp:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return FakeResp()

        with mock.patch.object(server, "urlopen", fake_urlopen):
            result = server.send_test_alert()
        return result, captured

    def test_posts_unique_autoresolving_alert(self):
        result, captured = self._capture_alert()
        self.assertTrue(result["ok"])
        alert = captured["body"][0]
        self.assertTrue(alert["labels"]["alertname"].startswith("TorholeTest-"))
        self.assertIn("endsAt", alert)
        self.assertGreater(alert["endsAt"], alert["startsAt"])
        self.assertTrue(captured["url"].endswith("/api/v2/alerts"))

    def test_network_error_returns_ok_false(self):
        def boom(req, timeout=None):
            raise OSError("connection refused")

        with mock.patch.object(server, "urlopen", boom):
            result = server.send_test_alert()
        self.assertFalse(result["ok"])
        self.assertIn("OSError", result["message"])


class TorEgressMetricTests(unittest.TestCase):
    def tearDown(self):
        with server._LEAK_TEST_LOCK:
            server._LEAK_TEST_HISTORY.clear()

    def _render(self, history, backup_age=None, backup_interval=24):
        with server._LEAK_TEST_LOCK:
            server._LEAK_TEST_HISTORY[:] = history
        with mock.patch.object(
            server, "_latest_backup_age_seconds", return_value=backup_age
        ), mock.patch.object(
            server,
            "_backup_schedule_config",
            return_value=(backup_interval, 7),
        ):
            return server.render_tor_metrics_prom(
                {"available": False}, {"available": False}
            )

    def test_no_history_and_no_backup_emit_explicit_unavailable_state(self):
        metrics = self._render([])
        self.assertIn("torhole_leak_test_result_available 0", metrics)
        self.assertIn("torhole_leak_test_pass 0", metrics)
        self.assertIn("torhole_tor_egress_verifier_available 0", metrics)
        self.assertIn("torhole_leak_test_age_seconds 0", metrics)
        self.assertIn("torhole_backup_archive_available 0", metrics)
        self.assertIn("torhole_last_backup_age_seconds 0", metrics)

    def test_valid_non_tor_response_is_distinct_from_verifier_error(self):
        non_tor = {
            "pass": False,
            "ran_at": datetime.now(timezone.utc).isoformat(),
            "verification_status": "confirmed_not_tor",
            "error": "leak detected: response says IsTor=false",
        }
        metrics = self._render([non_tor])
        self.assertIn("torhole_leak_test_result_available 1", metrics)
        self.assertIn("torhole_tor_egress_verifier_available 1", metrics)
        self.assertIn("torhole_leak_test_pass 0", metrics)

        unavailable = dict(non_tor, verification_status="unavailable", error="HTTP 503")
        metrics = self._render([unavailable])
        self.assertIn("torhole_tor_egress_verifier_available 0", metrics)
        self.assertIn("torhole_leak_test_pass 0", metrics)

    def test_legacy_result_status_is_normalized_without_api_break(self):
        self.assertEqual(
            server._tor_egress_verification_status({"pass": True}),
            "confirmed_tor",
        )
        self.assertEqual(
            server._tor_egress_verification_status(
                {"pass": False, "error": "leak detected: response says IsTor=false"}
            ),
            "confirmed_not_tor",
        )
        self.assertEqual(
            server._tor_egress_verification_status(
                {"pass": False, "error": "TimeoutError: timed out"}
            ),
            "unavailable",
        )

    def _run_with_verifier_payload(self, payload):
        class FakeSocket:
            def close(self):
                return None

        class FakeContext:
            def wrap_socket(self, sock, server_hostname=None):
                return sock

        sock = FakeSocket()
        body = json.dumps(payload).encode("utf-8")
        with mock.patch.object(
            server, "_socks5_connect", return_value=sock
        ), mock.patch.object(
            server.ssl, "create_default_context", return_value=FakeContext()
        ), mock.patch.object(
            server, "_http_get_via_socket", return_value=(200, {}, body)
        ):
            return server.run_leak_test()

    def test_only_explicit_false_is_confirmed_non_tor(self):
        missing = self._run_with_verifier_payload({"IP": "198.51.100.1"})
        self.assertEqual(missing["verification_status"], "unavailable")

        non_tor = self._run_with_verifier_payload(
            {"IsTor": False, "IP": "198.51.100.1"}
        )
        self.assertEqual(non_tor["verification_status"], "confirmed_not_tor")

        tor = self._run_with_verifier_payload({"IsTor": True, "IP": "192.0.2.1"})
        self.assertEqual(tor["verification_status"], "confirmed_tor")


if __name__ == "__main__":
    unittest.main()
