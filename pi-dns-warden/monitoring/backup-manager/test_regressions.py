import importlib.util
import io
import os
import stat
import subprocess
import tempfile
import threading
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("backup_regressions", Path(__file__).with_name("server.py"))
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class EnvTransactionTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.env = Path(tmp.name) / ".env"
        self.env.write_text("TZ=UTC\nTORHOLE_ADMIN_USER=admin\nTORHOLE_ADMIN_PASSWORD=OriginalPass123\n")
        patch = mock.patch.object(server.env_store, "ENV_FILE", self.env)
        patch.start()
        self.addCleanup(patch.stop)

    def test_ansible_quoted_credentials_match_backend_and_literal_loader(self):
        self.env.write_text(
            "TORHOLE_ADMIN_PASSWORD='Admin'\"'\"'s good 123'\n"
            'PIHOLE_TRUSTED_PASSWORD="Pi hole $literal 123" # operator comment\n'
            "TOR_CONTROL_PASSWORD='Tor $(no-execution) 123'\n"
        )
        values = server.read_env_values()
        self.assertTrue(server.verify_admin_password("Admin's good 123"))
        self.assertEqual(values["PIHOLE_TRUSTED_PASSWORD"], "Pi hole $literal 123")
        self.assertEqual(values["TOR_CONTROL_PASSWORD"], "Tor $(no-execution) 123")
        loader = Path(__file__).resolve().parents[2] / "ops/lib/load-env.sh"
        result = subprocess.run(
            ["bash", "-c", 'source "$1"; load_env_file "$2"; printf "%s\\0%s\\0%s" "$TORHOLE_ADMIN_PASSWORD" "$PIHOLE_TRUSTED_PASSWORD" "$TOR_CONTROL_PASSWORD"', "test", str(loader), str(self.env)],
            capture_output=True, check=True,
        )
        self.assertEqual(result.stdout.decode().split("\0"), [
            "Admin's good 123", "Pi hole $literal 123", "Tor $(no-execution) 123",
        ])

    def test_updated_quoted_and_backslash_passwords_roundtrip(self):
        for password in ("'QuotedPass123'", r"Backslash\1Pass123", "Admin's good 123 # literal"):
            with self.subTest(password_kind=password[:3]):
                server.update_env_keys({"TORHOLE_ADMIN_PASSWORD": password}, allow_secret_keys=True)
                self.assertTrue(server.verify_admin_password(password))

    def test_malformed_quoted_credentials_are_rejected(self):
        for text in ("TOKEN='unterminated", "TOKEN='first' second"):
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    server.parse_env_text(text)

    def run_concurrently(self, first, second, entered):
        errors = []
        second_done = threading.Event()

        def run(action, done=None):
            try:
                action()
            except Exception as exc:
                errors.append(exc)
            finally:
                if done:
                    done.set()

        a = threading.Thread(target=run, args=(first,), name="first")
        b = threading.Thread(target=run, args=(second, second_done), name="second")
        a.start()
        self.assertTrue(entered.wait(2), "first operation did not reach the controlled boundary")
        b.start()
        return a, b, errors, second_done

    def test_concurrent_updates_preserve_both_changes(self):
        entered, release = threading.Event(), threading.Event()
        original_read = server.env_store.read_env_text
        held = False

        def read():
            nonlocal held
            text = original_read()
            if threading.current_thread().name == "first" and not held:
                held = True
                entered.set()
                release.wait(2)
            return text

        with mock.patch.object(server.env_store, "read_env_text", side_effect=read):
            a, b, errors, done = self.run_concurrently(
                lambda: server.update_env_keys({"TZ": "Europe/Zurich"}),
                lambda: server.update_env_keys({"TORHOLE_ADMIN_USER": "operator"}), entered,
            )
            done.wait(0.2)
            release.set()
            a.join(2)
            b.join(2)
        self.assertFalse(a.is_alive() or b.is_alive())
        self.assertEqual(errors, [])
        values = server.read_env_values()
        self.assertEqual(values["TZ"], "Europe/Zurich")
        self.assertEqual(values["TORHOLE_ADMIN_USER"], "operator")

    def test_password_rollback_cannot_erase_concurrent_config_update(self):
        entered, release = threading.Event(), threading.Event()
        results = []

        def failed_render():
            entered.set()
            release.wait(2)
            return mock.Mock(returncode=1, stderr="fixture render failure")

        with mock.patch.object(server, "run_auth_render", side_effect=failed_render):
            a, b, errors, done = self.run_concurrently(
                lambda: results.append(server.update_admin_password("ReplacementPass123", "OriginalPass123")),
                lambda: server.update_env_keys({"TZ": "Europe/Zurich"}), entered,
            )
            done.wait(0.2)
            release.set()
            a.join(2)
            b.join(2)
        self.assertFalse(a.is_alive() or b.is_alive())
        self.assertEqual(errors, [])
        self.assertFalse(results[0]["ok"])
        values = server.read_env_values()
        self.assertEqual(values["TORHOLE_ADMIN_PASSWORD"], "OriginalPass123")
        self.assertEqual(values["TZ"], "Europe/Zurich")

    def test_backup_names_do_not_collide_within_one_second(self):
        with mock.patch.object(server.env_store, "datetime") as clock:
            clock.now.return_value.strftime.return_value = "20260913T000000Z"
            first, _ = server.update_env_keys({"TZ": "Europe/Zurich"})
            second, _ = server.update_env_keys({"TZ": "Europe/London"})
        self.assertNotEqual(first, second)
        self.assertIn("TZ=UTC", first.read_text())
        self.assertIn("TZ=Europe/Zurich", second.read_text())

    def test_update_does_not_follow_preexisting_temp_symlink(self):
        unrelated = self.env.parent / "unrelated"
        unrelated.write_text("keep me")
        self.env.with_name(".env.new").symlink_to(unrelated)
        server.update_env_keys({"TZ": "Europe/Zurich"})
        self.assertEqual(unrelated.read_text(), "keep me")
        self.assertFalse(self.env.is_symlink())

    def test_failed_replace_preserves_original_and_cleans_temp(self):
        original = self.env.read_bytes()
        with mock.patch.object(server.env_store.os, "replace", side_effect=OSError("fixture write failure")):
            with self.assertRaises(OSError):
                server.update_env_keys({"TZ": "Europe/Zurich"})
        self.assertEqual(self.env.read_bytes(), original)
        self.assertEqual(list(self.env.parent.glob(".env.new-*")), [])

    def test_files_are_private_before_writing_secrets(self):
        real_fdopen = os.fdopen
        modes = []

        def fdopen(fd, *args, **kwargs):
            modes.append(stat.S_IMODE(os.fstat(fd).st_mode))
            return real_fdopen(fd, *args, **kwargs)

        with mock.patch.object(server.env_store.os, "fdopen", side_effect=fdopen):
            backup, _ = server.update_env_keys({"TZ": "Europe/Zurich"})
            server.restore_env_from_backup(backup)
        self.assertEqual(modes, [0o600, 0o600, 0o600])
        self.assertEqual(server.read_env_values()["TZ"], "UTC")


class PrivacySnapshotTests(unittest.TestCase):
    def snapshot(self, failed_signal=None, states=("healthy",), topology="single-lan"):
        assurance = {
            "overall_status": "degraded" if failed_signal else "healthy",
            "summary": "fixture",
            "bootstrap": {"status": "healthy"}, "isolation": {"status": "healthy"},
            "network_path": {"status": "healthy"},
            "plane_identities": {"overall_status": "healthy"},
        }
        if failed_signal:
            field, state = failed_signal
            key = "overall_status" if field == "plane_identities" else "status"
            assurance[field][key] = state
        # External probes and disk reads are fixtures; snapshot aggregation is real.
        fixtures = {
            "read_env_values_safe": {}, "get_dns_stats": {"planes": [{"status": x} for x in states]},
            "get_services_detail": [], "build_tor_assurance": assurance,
            "get_tor_circuits": {}, "get_tor_runtime_info": {}, "build_notification_summary": {},
            "read_validation_result": {}, "list_backups": [], "build_recovery_summary": {},
            "build_public_links": {}, "build_info": {}, "get_leak_test_state": {},
        }
        with ExitStack() as stack:
            for name, value in fixtures.items():
                stack.enter_context(mock.patch.object(server, name, return_value=value))
            stack.enter_context(mock.patch.object(server, "TORHOLE_TOPOLOGY", topology))
            return server._compute_snapshot()["torhole"]

    def test_failed_or_missing_assurance_cannot_report_privacy_intact(self):
        for field in ("bootstrap", "isolation", "network_path", "plane_identities"):
            for state in ("degraded", "offline", None):
                with self.subTest(field=field, state=state):
                    result = self.snapshot((field, state))
                    self.assertFalse(result["privacy_intact"])
                    self.assertNotIn("guarantee", result["headline"].lower())
                    self.assertNotIn("compromised", result["headline"].lower())

    def test_every_active_plane_must_be_available(self):
        for states in ((), ("offline",), ("healthy", "offline"), ("healthy", "degraded")):
            with self.subTest(states=states):
                self.assertFalse(self.snapshot(states=states, topology="vlan")["privacy_intact"])

    def test_healthy_single_lan_and_vlan_report_only_observed_posture(self):
        for states, topology in ((("healthy",), "single-lan"), (("healthy", "healthy"), "vlan")):
            with self.subTest(topology=topology):
                result = self.snapshot(states=states, topology=topology)
                self.assertTrue(result["privacy_intact"])
                self.assertNotIn("guarantee", result["headline"].lower())
                self.assertNotIn("serving via Tor", result["headline"])


class QueryStreamTests(unittest.TestCase):
    def handler(self, output):
        handler = object.__new__(server.Handler)
        handler.wfile = output
        handler.send_response = lambda *args: None
        handler.send_header = lambda *args: None
        handler.end_headers = lambda: None
        return handler

    def test_idle_or_failed_source_releases_disconnected_handler(self):
        class DisconnectedOutput:
            def write(self, data):
                raise BrokenPipeError("fixture disconnected browser")

        class PollingLimit(Exception):
            pass

        for failure in (None, OSError("fixture Pi-hole unavailable")):
            with self.subTest(source_failure=bool(failure)):
                handler = self.handler(DisconnectedOutput())
                with mock.patch.object(server, "read_env_values_safe", return_value={}), \
                     mock.patch.object(server, "PIHOLE_API_TARGETS", [{"id": "trusted"}]), \
                     mock.patch.object(server, "_fetch_pihole_queries", return_value=[], side_effect=failure), \
                     mock.patch.object(server.time, "sleep", side_effect=[None, PollingLimit]):
                    try:
                        handler._stream_query_feed()
                    except PollingLimit:
                        self.fail("Disconnected stream kept polling without detecting the closed output")

    def test_heartbeats_are_comments_and_query_events_still_flow(self):
        class Output(io.BytesIO):
            def __init__(self):
                super().__init__()
                self.flushes = 0

            def flush(self):
                self.flushes += 1
                if self.flushes == 3:
                    raise ConnectionResetError("fixture disconnect after query and heartbeat")

        class PollingLimit(Exception):
            pass

        output = Output()
        handler = self.handler(output)
        with mock.patch.object(server, "read_env_values_safe", return_value={}), \
             mock.patch.object(server, "PIHOLE_API_TARGETS", [{"id": "trusted"}]), \
             mock.patch.object(server, "_fetch_pihole_queries", return_value=[{"id": 1, "time": 10}]), \
             mock.patch.object(server.time, "sleep", side_effect=[None, None, None, PollingLimit]):
            try:
                handler._stream_query_feed()
            except PollingLimit:
                self.fail("Idle stream never flushed a heartbeat")
        wire = output.getvalue().decode()
        self.assertEqual(wire.count('data: {"id":1,"time":10}'), 1)
        self.assertIn(": keepalive\n\n", wire)
        self.assertNotIn("data: null", wire)


if __name__ == "__main__":
    unittest.main()
