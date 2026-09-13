"""Run the actual deployment role on localhost in a disposable directory.

Requires ansible-core, ansible.posix and rsync. Set ANSIBLE_PLAYBOOK to its binary.
Only root ownership is removed from fixture tasks for unprivileged runners.
Backup/deploy executables are fixture stubs; no Docker/host network commands run.
"""
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

try:
    import yaml
except ImportError:
    yaml = None

ROOT = Path(__file__).resolve().parents[3]
BINARY = os.environ.get("ANSIBLE_PLAYBOOK") or shutil.which("ansible-playbook")


@unittest.skipUnless(BINARY and yaml, "Ansible and PyYAML required")
class DeploymentRole(unittest.TestCase):
    def deploy_fixture(self, topology, backup_status=0):
        with tempfile.TemporaryDirectory(prefix="torhole-ansible-test-") as directory:
            root = Path(directory)
            role = root / "roles/pihole_dns"
            shutil.copytree(ROOT / "ansible/roles/pihole_dns", role)
            tasks_file = role / "tasks/main.yml"
            tasks = yaml.safe_load(tasks_file.read_text())

            def unprivileged(value):
                if isinstance(value, dict):
                    # Only ownership differs from production: all paths and real
                    # task order, modules, backup/merge/handoff remain intact.
                    value.pop("owner", None)
                    value.pop("group", None)
                    for child in value.values():
                        unprivileged(child)
                elif isinstance(value, list):
                    for child in value:
                        unprivileged(child)
            unprivileged(tasks)
            tasks_file.write_text(yaml.safe_dump(tasks, sort_keys=False))
            shutil.copytree(ROOT / "ansible/files", root / "files")
            source, installed = root / "source", root / "installed"
            source.mkdir()
            (installed / "ops/scripts").mkdir(parents=True)
            (installed / ".env").write_text("TORHOLE_TOPOLOGY=vlan\nAUTHELIA_STORAGE_ENCRYPTION_KEY=preserve-fixture\n")
            (source / ".env").write_text("SHOULD_NOT_SYNC=controller-secret\n")
            (source / "run").mkdir()
            (source / "run/secret").write_text("controller-runtime")
            event = shlex.quote(str(root / "events"))
            backup = installed / "ops/scripts/50-backup.sh"
            backup.write_text(f'echo backup >> {event}\ncp .env {shlex.quote(str(root / "backup.env"))}\nexit {backup_status}\n')
            (source / "deploy.sh").write_text(f'echo deploy >> {event}\n')
            managed = root / "input.env"
            managed.write_text(f"TORHOLE_TOPOLOGY={topology}\nTORHOLE_ADMIN_PASSWORD=new-fixture\n")
            playbook = [{"hosts": "localhost", "gather_facts": False, "connection": "local", "vars": {
                "project_src": str(source), "project_dest": str(installed),
                "torhole_env_file": str(managed), "ansible_python_interpreter": sys.executable,
            }, "roles": ["pihole_dns"]}]
            path = root / "playbook.yml"
            path.write_text(yaml.safe_dump(playbook))
            env = {**os.environ, "ANSIBLE_HOME": str(root / "ansible-home"),
                   "ANSIBLE_LOCAL_TEMP": str(root / "local-tmp"),
                   "ANSIBLE_REMOTE_TEMP": str(root / "remote-tmp")}
            result = subprocess.run([BINARY, "-i", "localhost,", str(path)], env=env, text=True, capture_output=True)
            events = (root / "events").read_text().splitlines() if (root / "events").exists() else []
            if backup_status:
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(events, ["backup"], result.stdout + result.stderr)
                self.assertFalse((installed / "deploy.sh").exists())
                self.assertNotIn("TORHOLE_ADMIN_PASSWORD", (installed / ".env").read_text())
            else:
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(events, ["backup", "deploy"])
                self.assertIn("TORHOLE_TOPOLOGY=vlan", (root / "backup.env").read_text())
                content = (installed / ".env").read_text()
                self.assertIn(f"TORHOLE_TOPOLOGY={topology}\n", content)
                self.assertIn("AUTHELIA_STORAGE_ENCRYPTION_KEY=preserve-fixture\n", content)
                self.assertNotIn("SHOULD_NOT_SYNC", content)
                self.assertFalse((installed / "run/secret").exists())
                self.assertFalse(list(installed.glob(".env-ansible-*")))
                self.assertEqual((installed / ".env").stat().st_mode & 0o777, 0o600)

    def test_both_topologies_backup_preserve_secrets_and_handoff(self):
        for topology in ("single-lan", "vlan"):
            with self.subTest(topology=topology):
                self.deploy_fixture(topology)

    def test_backup_failure_stops_sync_and_config_mutation(self):
        self.deploy_fixture("single-lan", backup_status=23)


if __name__ == "__main__":
    unittest.main()
