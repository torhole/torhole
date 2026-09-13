"""Opt-in Docker recovery drill using uniquely named, disposable volumes only."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
IMAGE = os.environ.get("TORHOLE_TEST_IMAGE", "python:3.12-slim")


@unittest.skipUnless(os.environ.get("TORHOLE_RUN_DOCKER_TESTS") == "1", "set TORHOLE_RUN_DOCKER_TESTS=1 for disposable Docker tests")
class DockerRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.project = "torhole-recovery-test-" + uuid.uuid4().hex[:12]
        self.restored = self.project + "-restored"
        self.volumes = [self.project + "_authelia_data", self.restored + "_authelia_data"]
        self.addCleanup(self.remove_volumes)
        for name in ("dnscrypt", "monitoring", "ops", "pihole", "tor", "tor-image"):
            (self.root / name).mkdir()
        for name in ("VERSION", ".env", "docker-compose.yml", "docker-compose.monitoring.yml", "deploy.sh"):
            (self.root / name).write_text("# disposable test fixture\n")
        (self.root / "ops/scripts").mkdir()
        for name in ("17-render-alertmanager.sh", "16-render-reverse-proxy-dns.sh", "13-render-prometheus.sh", "14-render-caddy-topology.sh", "19-validate-stack.sh", "20-up.sh"):
            (self.root / "ops/scripts" / name).write_text("#!/bin/sh\nexit 0\n")
        (self.root / "run").mkdir()
        self.docker("volume", "create", self.volumes[0])
        self.docker("run", "--rm", "--network", "none", "-v", self.volumes[0] + ":/volume", IMAGE,
                    "python3", "-c", "import sqlite3; c=sqlite3.connect('/volume/db.sqlite3'); c.execute('create table identity (name text)'); c.execute(\"insert into identity values ('recovery-fixture')\"); c.commit()")

    def docker(self, *args):
        return subprocess.run(["docker", *args], check=True, capture_output=True, text=True)

    def remove_volumes(self):
        for name in self.volumes:
            subprocess.run(["docker", "volume", "rm", name], capture_output=True, text=True)

    def shell(self, commands):
        return subprocess.run(["bash", "-eu", "-c", 'source "$RECOVERY_LIBRARY"\n' + commands],
                              env={**os.environ, "ROOT_DIR": str(self.root), "TORHOLE_HOST_ROOT_DIR": str(self.root),
                                   "COMPOSE_PROJECT_NAME": self.project, "BACKUP_MANAGER_IMAGE": IMAGE,
                                   "RECOVERY_LIBRARY": str(ROOT / "ops/scripts/_recovery.sh"),
                                   "RESTORED_PROJECT": self.restored},
                              capture_output=True, text=True)

    def test_authentication_database_survives_fresh_volume_restore(self):
        result = self.shell('''
backup_to_archive "$ROOT_DIR/run/backup.tar.gz"
python3 "$RECOVERY_ARCHIVE_TOOL" extract "$ROOT_DIR/run/backup.tar.gz" "$ROOT_DIR/run/staged"
PROJECT_NAME="$RESTORED_PROJECT"
restore_volumes "$ROOT_DIR/run/staged"
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        metadata = json.loads((self.root / "run/staged/metadata.json").read_text())
        self.assertIn("authelia_data", metadata["captured_volumes"])
        recovered = self.docker("run", "--rm", "--network", "none", "-v", self.volumes[1] + ":/volume:ro", IMAGE,
                                "python3", "-c", "import sqlite3; c=sqlite3.connect('file:/volume/db.sqlite3?mode=ro',uri=True); print(c.execute('select name from identity').fetchone()[0])")
        self.assertEqual(recovered.stdout.strip(), "recovery-fixture")

    def test_missing_bind_payload_does_not_erase_existing_volume(self):
        (self.root / "run/missing").mkdir()
        result = self.shell('helper_restore_volume "${PROJECT_NAME}_authelia_data" "$ROOT_DIR/run/missing" authelia_data')
        self.assertNotEqual(result.returncode, 0)
        retained = self.docker("run", "--rm", "--network", "none", "-v", self.volumes[0] + ":/volume:ro", IMAGE,
                               "python3", "-c", "import sqlite3; c=sqlite3.connect('file:/volume/db.sqlite3?mode=ro',uri=True); print(c.execute('select name from identity').fetchone()[0])")
        self.assertEqual(retained.stdout.strip(), "recovery-fixture")


if __name__ == "__main__":
    unittest.main()
