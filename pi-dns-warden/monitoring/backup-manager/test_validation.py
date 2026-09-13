"""Validation contracts, including the real shell runner against a fake daemon."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("validation_server", Path(__file__).with_name("server.py"))
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)
PROJECT = Path(__file__).resolve().parents[2]


class ValidationRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("ops/scripts/19-validate-stack.sh", "ops/scripts/_compose.sh", "ops/lib/torhole-hostnames.sh", "ops/lib/load-env.sh"):
            dest = self.root / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(PROJECT / name, dest)
        for name in ("13-render-prometheus.sh", "14-render-caddy-topology.sh"):
            (self.root / "ops/scripts" / name).write_text("exit 99\n")
        for name, content in {
            "monitoring/grafana/dashboards/test.json": "{}",
            "monitoring/backup-manager/server.py": "x = 1\n",
            "monitoring/pihole-exporter/exporter.py": "x = 2\n",
            "monitoring/authelia/configuration.yml": "fixture: true\n",
            "monitoring/alloy/config.alloy": "// fixture\n",
        }.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        docker = self.bin / "docker"
        docker.write_text('''#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$DOCKER_CALLS"
if [[ "$*" == *"check config"* && "${FAIL_CONFIG:-0}" == 1 ]]; then exit 42; fi
''')
        docker.chmod(0o755)
        self.env = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}",
                    "DOCKER_CALLS": str(self.root / "calls"), "TORHOLE_TOPOLOGY": "single-lan",
                    "TORHOLE_HOST_ROOT_DIR": str(self.root)}

    def run_validation(self, *args, **env):
        return subprocess.run(["bash", str(self.root / "ops/scripts/19-validate-stack.sh"), *args],
                              env={**self.env, **env}, capture_output=True, text=True)

    def test_success_is_explicit_and_configuration_is_unchanged(self):
        before = {str(p): p.read_bytes() for p in (self.root / "monitoring").rglob("*") if p.is_file()}
        result = self.run_validation()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count("[validate:success]"), 10)
        after = {str(p): p.read_bytes() for p in (self.root / "monitoring").rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        calls = (self.root / "calls").read_text().splitlines()
        runs = [c for c in calls if c.startswith("run ")]
        self.assertTrue(runs)
        self.assertTrue(all("--pull never" in c for c in runs))
        self.assertTrue(all(" -v " not in c for c in runs), "-v creates missing bind sources on the host")
        self.assertFalse(any("authelia_validate_data" in c for c in runs))

    def test_failure_stops_later_checks_and_does_not_emit_success(self):
        result = self.run_validation(FAIL_CONFIG="1")
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertIn("[validate:success] compose render", result.stdout)
        self.assertNotIn("[validate:success] prometheus config", result.stdout)
        self.assertNotIn("[validate] prometheus rules", result.stdout)

    def test_uses_installed_env_for_validator_image(self):
        (self.root / ".env").write_text("PROMETHEUS_IMAGE=example.invalid/prometheus:pinned\n")
        result = self.run_validation()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("example.invalid/prometheus:pinned", (self.root / "calls").read_text())

    def test_deployment_may_explicitly_fetch_missing_validator_images(self):
        result = self.run_validation("--allow-image-pulls")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--pull missing", (self.root / "calls").read_text())

    def test_real_shell_output_agrees_with_backend_catalog(self):
        (self.root / "monitoring/authelia/configuration.yml").unlink()
        with mock.patch.object(server, "ROOT_DIR", self.root):
            parsed = server.parse_validation_checks(self.run_validation().stdout, 0)
        self.assertEqual(len(parsed), 9)
        self.assertNotIn("authelia_config", [c["id"] for c in parsed])
        self.assertTrue(all(c["status"] == "success" for c in parsed))


class ValidationResultTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        for key, value in {"RUN_DIR": root, "RECOVERY_LOCK_FILE": root / "recovery.lock",
                           "VALIDATION_FILE": root / "validation.json"}.items():
            patch = mock.patch.object(server, key, value)
            patch.start()
            self.addCleanup(patch.stop)

    def test_empty_successful_process_is_not_a_successful_validation(self):
        with mock.patch.object(server, "run_validation_script", return_value=subprocess.CompletedProcess([], 0, "", "")), \
             mock.patch.object(server, "write_validation_result"):
            result = server.run_system_validation()
        self.assertEqual(result["status"], "error")

    def test_preview_is_read_only_and_explains_scope(self):
        with mock.patch.object(server, "run_script", side_effect=AssertionError("Preview executed a command")):
            preview = server.validation_preview()
        self.assertFalse(preview["running"])
        self.assertIsNone(preview["last_result"])
        self.assertIn("DNS", preview["scope"])
        self.assertTrue(preview["checks"])
        for check in preview["checks"]:
            self.assertTrue(check["description"])
            self.assertTrue(check["remediation"])

    def test_progress_never_guesses_success(self):
        checks = server.parse_validation_checks("[validate] compose render\n", None)
        self.assertEqual(checks[0]["status"], "running")
        self.assertEqual(checks[1]["status"], "queued")

    def test_validation_rejects_overlap_with_recovery(self):
        with server.RECOVERY_LOCK_FILE.open("a+") as handle:
            server.fcntl.flock(handle, server.fcntl.LOCK_EX)
            with self.assertRaises(server.ValidationBusyError):
                server.run_system_validation()

    def test_unredacted_output_is_not_in_result(self):
        process = subprocess.CompletedProcess([], 1, "[validate] compose render\n", "secret-token-123")
        with mock.patch.object(server, "run_validation_script", return_value=process):
            result = server.run_system_validation()
        self.assertNotIn("secret-token-123", str(result))

    def test_hung_validator_process_group_times_out(self):
        root = server.RUN_DIR
        script = root / "ops/scripts/19-validate-stack.sh"
        script.parent.mkdir(parents=True)
        script.write_text("echo '[validate] compose render'\nsleep 30\n")
        with mock.patch.object(server, "ROOT_DIR", root):
            result = server.run_validation_script(timeout=0.05)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("[validate] compose render", result.stdout)

    def test_running_job_is_visible_rejects_duplicates_and_releases_lock(self):
        def execute():
            self.assertTrue(server.validation_preview()["running"])
            with self.assertRaises(server.ValidationBusyError):
                server.run_system_validation()
            return subprocess.CompletedProcess([], 1, "", "")
        with mock.patch.object(server, "run_validation_script", side_effect=execute):
            server.run_system_validation()
            self.assertFalse(server.validation_preview()["running"])
            server.run_system_validation()


if __name__ == "__main__":
    unittest.main()
