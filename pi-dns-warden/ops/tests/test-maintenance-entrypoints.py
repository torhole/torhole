"""Offline maintenance regressions; Docker and host changes are always stubbed."""
import os
from pathlib import Path
import shutil
import shlex

try:
    import jinja2
    import yaml
except ImportError:
    jinja2 = yaml = None
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
APP = ROOT / "pi-dns-warden"


class UpdateOrdering(unittest.TestCase):
    def run_update(self, backup_status=0):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / "ops/scripts"
            scripts.mkdir(parents=True)
            shutil.copy(APP / "ops/scripts/40-update.sh", scripts)
            (scripts / "_compose.sh").write_text('COMPOSE=(true)\n')
            log = root / "events"
            for original in (APP / "ops/scripts").glob("*.sh"):
                if original.name in {"40-update.sh", "_compose.sh"}:
                    continue
                code = backup_status if original.name == "50-backup.sh" else 0
                (scripts / original.name).write_text(
                    f'echo {original.name} >> "$EVENT_LOG"\nexit {code}\n'
                )
            result = subprocess.run(
                ["bash", str(scripts / "40-update.sh")],
                env={**os.environ, "EVENT_LOG": str(log)}, capture_output=True, text=True,
            )
            return result, log.read_text().splitlines()

    def test_backup_precedes_every_mutation(self):
        result, events = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events[0], "50-backup.sh", events)

    def test_backup_failure_prevents_every_mutation(self):
        result, events = self.run_update(23)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(events, ["50-backup.sh"])


class AnsibleEntrypoints(unittest.TestCase):
    def test_production_hands_rendering_and_services_to_deployer(self):
        playbook = (ROOT / "ansible/playbook.yml").read_text()
        role = (ROOT / "ansible/roles/pihole_dns/tasks/main.yml").read_text()
        self.assertIn("ansible.builtin.command: bash ./deploy.sh", role)
        self.assertNotIn("docker compose", role)
        for parallel_role in ("networking", "systemd", "docker"):
            self.assertNotIn(f"    - {parallel_role}\n", playbook)

    def test_staging_reuses_safe_deployment_role(self):
        staging = (ROOT / "ansible/playbook.staging.yml").read_text()
        self.assertIn("    - pihole_dns", staging)
        self.assertIn('torhole_env_file: "{{ staging_env_file }}"', staging)
        self.assertNotIn("ansible.posix.synchronize", staging)

    def test_service_restart_preserves_selected_topology(self):
        template = (ROOT / "ansible/templates/pihole-tor.service.j2").read_text()
        self.assertIn("/ops/scripts/22-stack-service.sh up", template)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / "ops/scripts"
            scripts.mkdir(parents=True)
            for name in ("22-stack-service.sh", "_compose.sh", "12-sync-topology.sh"):
                shutil.copy(APP / "ops/scripts" / name, scripts)
            binary = root / "bin"
            binary.mkdir()
            docker = binary / "docker"
            docker.write_text('#!/bin/sh\n[ "$1 $2" = "container inspect" ] && exit 1\nprintf "%s\\n" "$*" >> "$EVENT_LOG"\n')
            docker.chmod(0o755)
            for topology in ("single-lan", "vlan"):
                (root / ".env").write_text(f"TORHOLE_TOPOLOGY={topology}\n")
                log = root / topology
                env = {**os.environ, "PATH": f"{binary}:{os.environ['PATH']}", "EVENT_LOG": str(log)}
                env.pop("TORHOLE_TOPOLOGY", None)
                result = subprocess.run(["bash", str(scripts / "22-stack-service.sh"), "up"], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                commands = log.read_text()
                self.assertEqual("--profile vlan" in commands, topology == "vlan", commands)


class ManagedEnvironment(unittest.TestCase):
    def test_merge_preserves_generated_secrets_and_unmanaged_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / ".env"
            candidate = root / "managed.env"
            destination.write_text("TORHOLE_ADMIN_PASSWORD=old\nAUTHELIA_STORAGE_ENCRYPTION_KEY=keep-me\nCUSTOM_SETTING=retained\n")
            candidate.write_text("TORHOLE_ADMIN_PASSWORD=new\nTORHOLE_TOPOLOGY=single-lan\n")
            result = subprocess.run(["python3", str(ROOT / "ansible/files/merge-env.py"), str(candidate), str(destination)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            content = destination.read_text()
            self.assertIn("AUTHELIA_STORAGE_ENCRYPTION_KEY=keep-me\n", content)
            self.assertIn("CUSTOM_SETTING=retained\n", content)
            self.assertNotIn("TORHOLE_ADMIN_PASSWORD=old", content)
            self.assertIn("TORHOLE_ADMIN_PASSWORD=new\n", content)
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)

    def test_ansible_backs_up_existing_install_before_sync_or_env_mutation(self):
        role = (ROOT / "ansible/roles/pihole_dns/tasks/main.yml").read_text()
        self.assertLess(role.index("ops/scripts/50-backup.sh"), role.index("ansible.posix.synchronize"))
        self.assertIn("--exclude=.env*", role)
        self.assertIn("--exclude=monitoring/authelia/configuration.yml", role)
        self.assertIn("--exclude=restore-safety", role)


@unittest.skipUnless(jinja2 and yaml, "Jinja2 and PyYAML required for Ansible template checks")
class AnsibleTemplates(unittest.TestCase):
    def test_yaml_syntax_and_render_both_topologies(self):
        for path in (ROOT / "ansible").rglob("*.yml"):
            # Local inventory/Vault data must never be read by a source test.
            if "group_vars" not in path.parts:
                yaml.safe_load(path.read_text())
        values = yaml.safe_load((ROOT / "ansible/group_vars/dns_warden.yml.example").read_text())
        values.update(yaml.safe_load((ROOT / "ansible/group_vars/dns_warden_vault.yml.example").read_text()))
        environment = jinja2.Environment(undefined=jinja2.StrictUndefined)
        environment.filters["quote"] = shlex.quote
        template = environment.from_string((ROOT / "ansible/templates/env.j2").read_text())
        for topology in ("vlan", "single-lan"):
            settings = dict(values, torhole_topology=topology)
            if topology == "single-lan":
                for name in ("iot_vlan_id", "iot_gateway", "iot_subnet_cidr", "pihole_iot_ip", "trusted_vlan_id"):
                    settings.pop(name, None)
                settings["pihole_passwords"] = {"trusted": "fixture-password"}
            rendered = template.render(settings)
            self.assertIn(f"TORHOLE_TOPOLOGY={topology}\n", rendered)
            self.assertIn("TRUSTED_PARENT=eth0\n", rendered)
            self.assertIn("TORHOLE_ADMIN_PASSWORD=CHANGE_ME\n", rendered)
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / ".env"
                path.write_text(rendered)
                result = subprocess.run(["bash", "-c", 'source "$1"; load_env_file "$2"', "_", str(APP / "ops/lib/load-env.sh"), str(path)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
