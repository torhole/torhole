import importlib.util
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path


RUNNER_PATH = Path(__file__).with_name("host_runner.py")
SPEC = importlib.util.spec_from_file_location("torhole_bootstrap_host_runner", RUNNER_PATH)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class HostRunnerTests(unittest.TestCase):
    def make_root(self, tmp):
        root = Path(tmp)
        app = root / "pi-dns-warden"
        (app / "run" / "bootstrap").mkdir(parents=True)
        (app / "deploy.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
        return root

    def write_request(self, root, token="t" * 48, **changes):
        payload = {
            "operation": "deploy-advanced",
            "request_id": "a" * 32,
            "created_at": time.time(),
            "token": token,
            **changes,
        }
        path = root / "pi-dns-warden" / "run" / "bootstrap" / "advanced-request.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_validates_token_operation_id_and_age(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp)
            path = self.write_request(root)
            self.assertEqual(runner.validated_request(path, "t" * 48)["request_id"], "a" * 32)

            for changes in (
                {"token": "wrong"},
                {"operation": "shell"},
                {"request_id": "../bad"},
                {"created_at": time.time() - runner.MAX_REQUEST_AGE_SECONDS - 1},
            ):
                with self.subTest(changes=changes):
                    path = self.write_request(root, **changes)
                    with self.assertRaises(ValueError):
                        runner.validated_request(path, "t" * 48)

    def test_runs_only_injected_fixed_command_and_writes_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp)
            self.write_request(root)
            command = [
                sys.executable,
                "-c",
                "print('validated host deploy')",
            ]
            self.assertTrue(
                runner.process_request(root, "t" * 48, use_sudo=False, command=command)
            )
            run_dir = root / "pi-dns-warden" / "run" / "bootstrap"
            status = json.loads((run_dir / "advanced-status.json").read_text())
            self.assertEqual(status["status"], "success")
            self.assertEqual(status["returncode"], 0)
            self.assertIn(
                "validated host deploy",
                (run_dir / "advanced-install.log").read_text(),
            )
            self.assertFalse((run_dir / "advanced-request.processing.json").exists())

    def test_nonzero_deploy_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp)
            self.write_request(root)
            runner.process_request(
                root,
                "t" * 48,
                use_sudo=False,
                command=[sys.executable, "-c", "raise SystemExit(7)"],
            )
            status_path = root / "pi-dns-warden" / "run" / "bootstrap" / "advanced-status.json"
            status = json.loads(status_path.read_text())
            self.assertEqual(status["status"], "error")
            self.assertEqual(status["returncode"], 7)

    def test_stale_runner_does_not_consume_new_sessions_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.make_root(tmp)
            request = self.write_request(root, token="n" * 48)
            self.assertFalse(runner.process_request(root, "o" * 48, use_sudo=False))
            self.assertTrue(request.exists())
            self.assertFalse(
                (root / "pi-dns-warden" / "run" / "bootstrap" / "advanced-status.json").exists()
            )

    def test_detects_when_a_runner_token_has_been_superseded(self):
        with tempfile.TemporaryDirectory() as tmp:
            token_file = Path(tmp) / ".env.bootstrap.local"
            token_file.write_text(
                "TORHOLE_BOOTSTRAP_TOKEN=" + "a" * 48 + "\n", encoding="utf-8"
            )
            self.assertTrue(runner.token_is_current(token_file, "a" * 48))
            self.assertFalse(runner.token_is_current(token_file, "b" * 48))


if __name__ == "__main__":
    unittest.main()
