"""Check release dependencies and execute the CI syntax check on broken input."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[3]


class CIContractTests(unittest.TestCase):
    def setUp(self):
        workflows = ROOT / ".github/workflows"
        self.ci = yaml.load((workflows / "ci.yml").read_text(), Loader=yaml.BaseLoader)
        self.release = yaml.load((workflows / "release.yml").read_text(), Loader=yaml.BaseLoader)

    def test_publish_depends_on_same_revision_full_ci(self):
        jobs = self.release["jobs"]
        publish = jobs["release"]
        needs = publish.get("needs", [])
        if isinstance(needs, str):
            needs = [needs]
        gates = [jobs[name] for name in needs if jobs[name].get("uses") == "./.github/workflows/ci.yml"]
        self.assertEqual(len(gates), 1, "Publishing is not gated on same-commit CI")
        self.assertNotIn("if", publish, "Release must use the default all-dependencies-success condition")
        self.assertIn("workflow_call", self.ci["on"])
        self.assertIn("integration", self.ci["jobs"])
        for job in self.ci["jobs"].values():
            self.assertNotEqual(job.get("continue-on-error"), "true")

    def test_syntax_gate_rejects_invalid_control_helper(self):
        steps = self.ci["jobs"]["validate"]["steps"]
        command = next(step["run"] for step in steps if step.get("name", "").startswith("Check Python syntax"))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "pi-dns-warden"
            for area in ("bootstrap", "home-dashboard", "control-helper", "monitoring", "ops", "../ansible/files"):
                (root / area).mkdir(parents=True)
            (root / "control-helper/server.py").write_text("def broken(:\n")
            result = subprocess.run(["bash", "-eu", "-c", command], cwd=root, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, "CI ignored invalid Python outside monitoring")

    def test_caddy_gate_renders_topology_before_native_validation(self):
        command = next(step["run"] for step in self.ci["jobs"]["validate"]["steps"]
                       if step.get("name") == "Validate Caddy config")
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            app = workspace / "pi-dns-warden"
            shutil.copytree(ROOT / "pi-dns-warden/ops", app / "ops")
            (app / "monitoring/caddy").mkdir(parents=True)
            shutil.copy2(ROOT / "pi-dns-warden/.env.example", app / ".env")
            # The container runtime is external. Assert the production CI step
            # has created its required bind-mounted include before calling it.
            shim = 'docker() { test -s "$GITHUB_WORKSPACE/pi-dns-warden/monitoring/caddy/topology-sites.caddy"; }\n'
            result = subprocess.run(["bash", "-eu", "-c", shim + command], cwd=app,
                                    env={**os.environ, "GITHUB_WORKSPACE": str(workspace)},
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, "CI called Caddy before rendering its required include")


if __name__ == "__main__":
    unittest.main()
