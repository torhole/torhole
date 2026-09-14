"""Offline maintenance regressions; Docker and host changes are always stubbed."""
import os
import importlib.util
import json
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


class TorPasswordRendering(unittest.TestCase):
    def run_tor_fixture(self, malformed=False):
        spec = importlib.util.spec_from_file_location("tor_password_env", APP / "monitoring/backup-manager/env_store.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / "ops/scripts"
            scripts.mkdir(parents=True)
            (root / "ops/lib").mkdir()
            (root / "tor").mkdir()
            (root / "bin").mkdir()
            shutil.copy(APP / "ops/scripts/20-render-torrc.sh", scripts)
            shutil.copy(APP / "ops/lib/load-env.sh", root / "ops/lib")
            (root / "tor/torrc").write_text("# BEGIN HASHED_CONTROL_PASSWORD (generated)\nHashedControlPassword 16:OLD\n# END HASHED_CONTROL_PASSWORD\n")
            docker = root / "bin/docker"
            docker.write_text("#!/bin/sh\nif [ \"$1\" = ps ]; then echo tor; else printf '%s' \"$5\" > \"$PASSWORD_LOG\"; echo 16:FIXTURE; fi\n")
            docker.chmod(0o755)
            payload = "  fixture' \\ $dollar \"quote\"  "
            (root / ".env").write_text('TOR_CONTROL_PASSWORD="unterminated\n' if malformed else
                "TOR_CONTROL_PASSWORD=ignored\nTOR_CONTROL_PASSWORD=" + module.serialize_env_value(payload) + "\n")
            log = root / "password"
            result = subprocess.run(["bash", str(scripts / "20-render-torrc.sh")],
                env={**os.environ, "PATH": str(root / "bin") + ":" + os.environ["PATH"], "PASSWORD_LOG": str(log), "TOR_CONTROL_PASSWORD": "inherited-fixture"},
                capture_output=True, text=True)
            if malformed:
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(log.exists(), "Malformed dotenv reached Tor hashing")
                self.assertIn("HashedControlPassword 16:OLD", (root / "tor/torrc").read_text())
            else:
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(log.read_text(), payload)

    def test_tor_hash_receives_decoded_literal_password(self):
        self.run_tor_fixture()

    def test_malformed_env_cannot_hash_inherited_password(self):
        self.run_tor_fixture(malformed=True)


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
    def test_backend_serializer_rejects_line_injection_and_preserves_legacy_values(self):
        spec = importlib.util.spec_from_file_location("fixture_env_store", APP / "monitoring/backup-manager/env_store.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for value in ("line\nbreak", "line\rbreak", "nul\x00byte"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                module.serialize_env_value(value)
        for value in ("fixture'password", "two$$dollars", '"quotes" \\ backslash # hash'):
            with self.subTest(value=value):
                encoded = module.serialize_env_value(value)
                self.assertEqual(module.parse_env_text("VALUE=" + encoded)["VALUE"], value)
                self.assertEqual(module.parse_env_text("VALUE=" + shlex.quote(value))["VALUE"], value)

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
    def test_secret_punctuation_round_trips_through_loader_and_compose(self):
        if not shutil.which("docker"):
            self.skipTest("Docker Compose required")
        environment = jinja2.Environment(undefined=jinja2.StrictUndefined)
        environment.filters["quote"] = shlex.quote
        filter_path = ROOT / "ansible/filter_plugins/dotenv.py"
        if filter_path.exists():
            spec = importlib.util.spec_from_file_location("ansible_dotenv", filter_path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            environment.filters.update(module.FilterModule().filters())
        template = environment.from_string((ROOT / "ansible/templates/env.j2").read_text())
        values = yaml.safe_load((ROOT / "ansible/group_vars/dns_warden.yml.example").read_text())
        values.update(yaml.safe_load((ROOT / "ansible/group_vars/dns_warden_vault.yml.example").read_text()))
        payloads = ["fixture'password", 'space # hash $HOME ${USER} `literal` "quote"',
                    "back\\slash\\'quote", "trailing\\", "two$$dollars", ""]
        keys = ["TORHOLE_ADMIN_PASSWORD", "TOR_CONTROL_PASSWORD", "PIHOLE_TRUSTED_PASSWORD",
                "PIHOLE_IOT_PASSWORD", "DNSCRYPT_SOCKS_PASS_TRUSTED", "DNSCRYPT_SOCKS_PASS_IOT",
                "ALERT_EMAIL_AUTH_PASSWORD", "ALERT_TELEGRAM_BOT_TOKEN"]
        for payload in payloads:
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as directory:
                settings = dict(values, torhole_admin_password=payload, tor_control_password=payload,
                                pihole_passwords={"trusted": payload, "iot": payload},
                                dnscrypt_socks={"trusted_user": "trusted", "iot_user": "iot",
                                                "trusted_pass": payload, "iot_pass": payload},
                                alert_email_auth_password=payload, alert_telegram_bot_token=payload)
                root = Path(directory)
                path = root / ".env"
                path.write_text(template.render(settings))
                compose = root / "compose.yml"
                compose.write_text("services:\n  fixture:\n    image: busybox\n")
                env = {k: v for k, v in os.environ.items() if k not in keys}
                result = subprocess.run(["docker", "compose", "--env-file", str(path), "-f", str(compose),
                                         "config", "--environment"], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                parsed = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
                for key in keys:
                    self.assertEqual(parsed[key], payload, key)
                result = subprocess.run(["bash", "-c",
                    'source "$1"; load_env_file "$2"; python3 -c \'import json, os, sys; print(json.dumps({k: os.environ[k] for k in sys.argv[1:]}))\' "${@:3}"',
                    "_", str(APP / "ops/lib/load-env.sh"), str(path), *keys], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), dict.fromkeys(keys, payload))

    def test_yaml_syntax_and_render_both_topologies(self):
        for path in (ROOT / "ansible").rglob("*.yml"):
            # Local inventory/Vault data must never be read by a source test.
            if "group_vars" not in path.parts:
                yaml.safe_load(path.read_text())
        values = yaml.safe_load((ROOT / "ansible/group_vars/dns_warden.yml.example").read_text())
        values.update(yaml.safe_load((ROOT / "ansible/group_vars/dns_warden_vault.yml.example").read_text()))
        environment = jinja2.Environment(undefined=jinja2.StrictUndefined)
        spec = importlib.util.spec_from_file_location("ansible_dotenv", ROOT / "ansible/filter_plugins/dotenv.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        environment.filters.update(module.FilterModule().filters())
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
