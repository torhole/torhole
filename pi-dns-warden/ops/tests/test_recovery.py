"""Recovery regressions use temporary installations; never a Docker daemon."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
LIBRARY = ROOT / "ops/scripts/_recovery.sh"
REQUIRED_FILES = (".env", "docker-compose.yml", "docker-compose.monitoring.yml", "deploy.sh")
REQUIRED_DIRS = ("dnscrypt", "monitoring", "ops", "pihole", "tor", "tor-image")


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.install = self.base / "install"
        shutil.copytree(ROOT / "ops", self.install / "ops")
        (self.install / "monitoring").mkdir()
        self.marker = self.install / "monitoring/keep"
        self.marker.write_text("original")
        self.events = self.base / "events"
        # Stub only external effects in the copied installation. Validation,
        # extraction and project replacement still execute production code.
        with (self.install / "ops/scripts/_recovery.sh").open("a") as handle:
            handle.write('''
load_recovery_env() { :; }
acquire_recovery_lock() { :; }
backup_to_archive() { echo backup >> "$TEST_EVENTS"; }
''')
        down = self.install / "ops/scripts/90-down.sh"
        down.write_text('#!/bin/sh\necho down >> "$TEST_EVENTS"\n')
        down.chmod(0o755)

    def shell(self, command, *args):
        return subprocess.run(
            ["bash", "-c", 'source "$1"; shift; ' + command,
             "test", str(LIBRARY), *map(str, args)],
            env={**os.environ, "ROOT_DIR": str(self.install)},
            capture_output=True, text=True,
        )

    def archive(self, kind="modern", omit=None, volume=None):
        tree = self.base / ("tree-" + kind)
        tree.mkdir(exist_ok=True)
        project = tree / "project" if kind == "modern" else tree
        project.mkdir(exist_ok=True)
        for name in REQUIRED_FILES:
            if name != omit:
                (project / name).write_text("# fixture\n")
        for name in REQUIRED_DIRS:
            (project / name).mkdir(exist_ok=True)
        scripts = project / "ops/scripts"
        scripts.mkdir()
        for name in ("17-render-alertmanager.sh", "16-render-reverse-proxy-dns.sh", "13-render-prometheus.sh", "14-render-caddy-topology.sh", "19-validate-stack.sh", "20-up.sh"):
            (scripts / name).write_text("#!/bin/sh\nexit 0\n")
        if kind == "modern":
            (tree / "volumes").mkdir(exist_ok=True)
            (tree / "metadata.json").write_text(json.dumps({
                "format_version": 2, "configured_volumes": ["authelia_data"],
                "captured_volumes": ["authelia_data"] if volume else [],
            }))
            if volume:
                (tree / "volumes/authelia_data.tar.gz").write_bytes(volume)
        archive = self.base / (kind + ".tar.gz")
        with tarfile.open(archive, "w:gz") as tar:
            for entry in tree.iterdir():
                tar.add(entry, arcname=entry.name)
        return archive

    def assert_restore_rejected(self, archive):
        result = subprocess.run(
            ["bash", str(self.install / "ops/scripts/60-restore.sh"), "--yes", str(archive)],
            env={**os.environ, "TEST_EVENTS": str(self.events)},
            capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.events.exists(), result.stderr)
        self.assertTrue(self.marker.exists(), "preflight deleted the installed tree")
        self.assertEqual(self.marker.read_text(), "original")

    def test_corrupt_archive_does_not_stop_or_replace_installation(self):
        archive = self.base / "corrupt.tar.gz"
        archive.write_bytes(b"not a backup")
        self.assert_restore_rejected(archive)

    def test_empty_archive_does_not_stop_or_replace_installation(self):
        archive = self.base / "empty.tar.gz"
        with tarfile.open(archive, "w:gz"):
            pass
        self.assert_restore_rejected(archive)

    def test_incomplete_archive_does_not_stop_or_replace_installation(self):
        self.assert_restore_rejected(self.archive(omit=".env"))

    def test_missing_restore_validator_is_rejected_before_shutdown(self):
        archive = self.archive()
        tree = self.base / "tree-modern"
        (tree / "project/ops/scripts/19-validate-stack.sh").unlink()
        with tarfile.open(archive, "w:gz") as tar:
            for entry in tree.iterdir():
                tar.add(entry, arcname=entry.name)
        self.assert_restore_rejected(archive)

    def test_direct_project_restore_rejects_missing_tree_before_deletion(self):
        empty = self.base / "empty"
        empty.mkdir()
        result = self.shell('restore_project_tree "$1"', empty)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.marker.exists(), "preflight deleted the installed tree")
        self.assertEqual(self.marker.read_text(), "original")

    def test_modern_and_legacy_backups_are_accepted(self):
        for kind in ("modern", "legacy"):
            with self.subTest(kind=kind):
                result = self.shell('validate_archive_safety "$1"', self.archive(kind))
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_valid_backup_is_staged_and_replaces_project(self):
        archive = self.archive()
        stage = self.base / "stage"
        result = self.shell('''
python3 "$RECOVERY_ARCHIVE_TOOL" extract "$1" "$2"
restore_project_tree "$2"
''', archive, stage)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.marker.exists())
        self.assertEqual((self.install / ".env").read_text(), "# fixture\n")

    def test_missing_captured_volume_is_rejected_before_shutdown(self):
        archive = self.archive(volume=b"placeholder")
        tree = self.base / "tree-modern"
        (tree / "volumes/authelia_data.tar.gz").unlink()
        with tarfile.open(archive, "w:gz") as tar:
            for entry in tree.iterdir():
                tar.add(entry, arcname=entry.name)
        self.assert_restore_rejected(archive)

    def test_valid_nested_volume_and_internal_symlink_are_accepted(self):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as tar:
            info = tarfile.TarInfo("db.sqlite3")
            info.size = 3
            tar.addfile(info, io.BytesIO(b"db!"))
        archive = self.archive(volume=data.getvalue())
        tree = self.base / "tree-modern"
        (tree / "project/monitoring/current").symlink_to("../.env")
        with tarfile.open(archive, "w:gz") as tar:
            for entry in tree.iterdir():
                tar.add(entry, arcname=entry.name)
        result = self.shell('validate_archive_safety "$1"', archive)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_truncated_gzip_is_rejected(self):
        archive = self.archive()
        archive.write_bytes(archive.read_bytes()[:-8])
        self.assert_restore_rejected(archive)

    def test_macos_volume_metadata_is_not_treated_as_a_payload(self):
        archive = self.archive()
        tree = self.base / "tree-modern"
        (tree / "volumes/._authelia_data.tar.gz").write_bytes(b"AppleDouble metadata")
        with tarfile.open(archive, "w:gz") as tar:
            for entry in tree.iterdir():
                tar.add(entry, arcname=entry.name)
        result = self.shell('validate_archive_safety "$1"', archive)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_container_path_mapping_rejects_unshared_staging(self):
        result = self.shell('''
HOST_ROOT_DIR=/srv/torhole
to_host_path /tmp/unshared/extract/volumes
''')
        self.assertNotEqual(result.returncode, 0)

    def test_restore_stages_under_shared_run_directory(self):
        with (self.install / "ops/scripts/_recovery.sh").open("a") as handle:
            handle.write('''
restore_project_tree() {
  case "$1" in "$RUN_DIR"/restore.*/extract) ;; *) return 19;; esac
  test -f "$1/project/.env"
}
restore_volumes() { :; }
check_cached_restore_images() { :; }
''')
        for name in ("17-render-alertmanager.sh", "16-render-reverse-proxy-dns.sh", "13-render-prometheus.sh", "14-render-caddy-topology.sh", "19-validate-stack.sh"):
            (self.install / "ops/scripts" / name).write_text("#!/bin/sh\nexit 0\n")
        result = subprocess.run(
            ["bash", str(self.install / "ops/scripts/60-restore.sh"), "--yes", str(self.archive())],
            env={**os.environ, "TEST_EVENTS": str(self.events)}, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def cached_restore_fixture(self, missing=False, topology="single-lan"):
        archive = self.archive()
        tree = self.base / "tree-modern"
        project = tree / "project"
        (project / ".env").write_text(f"TORHOLE_TOPOLOGY={topology}\n" if topology else "# legacy topology defaults to VLAN\n")
        for script in (project / "ops/scripts").glob("*.sh"):
            script.chmod(0o755)
        # An older archive's startup script still tries the network. Recovery
        # must use its retained cached-start implementation instead.
        (project / "ops/scripts/20-up.sh").write_text("#!/bin/sh\ndocker compose pull\n")
        with tarfile.open(archive, "w:gz") as tar:
            for entry in tree.iterdir():
                tar.add(entry, arcname=entry.name)
        binary = self.base / "bin"
        binary.mkdir()
        docker = binary / "docker"
        docker.write_text('''#!/bin/sh
printf '%s\n' "$*" >> "$TEST_EVENTS"
case "$*" in
  *' pull'|*' pull '*|*' build'|*' build '*) echo 'fixture registry unavailable' >&2; exit 23 ;;
  *'config --images'*) echo fixture-tor; echo fixture-auth; echo "${PIHOLE_IMAGE:-fixture-default-pihole}" ;;
  'image inspect fixture-auth') [ "$MISSING_IMAGE" != 1 ] ;;
  *'up '*) case "$*" in *'--pull never'*'--no-build'*) exit 0;; *) exit 24;; esac ;;
  *) exit 0 ;;
esac
''')
        docker.chmod(0o755)
        result = subprocess.run(["bash", str(self.install / "ops/scripts/60-restore.sh"), "--yes", "--auto-restart", str(archive)],
            env={**os.environ, "PATH": str(binary) + ":" + os.environ["PATH"],
                 "TEST_EVENTS": str(self.events), "TORHOLE_TOPOLOGY": "single-lan", "PIHOLE_IMAGE": "fixture-installed-pihole", "MISSING_IMAGE": "1" if missing else "0"},
            capture_output=True, text=True)
        return result, self.events.read_text()

    def test_restore_uses_cached_images_without_archived_network_startup(self):
        result, events = self.cached_restore_fixture()
        self.assertEqual(result.returncode, 0, result.stderr + events)
        self.assertIn("--pull never --no-build", events)
        self.assertLess(events.index("image inspect fixture-auth"), events.index("down"))
        startup = next(line for line in events.splitlines() if " up " in line)
        self.assertNotIn("--profile vlan", startup)
        self.assertIn("--project-name install", startup)

    def test_missing_cached_image_is_rejected_before_shutdown(self):
        result, events = self.cached_restore_fixture(missing=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("down", events)
        self.assertTrue(self.marker.exists())
        self.assertIn("cached image", result.stderr.lower())

    def test_cached_restore_preserves_vlan_profile(self):
        result, events = self.cached_restore_fixture(topology="vlan")
        self.assertEqual(result.returncode, 0, result.stderr + events)
        startup = next(line for line in events.splitlines() if " up " in line)
        self.assertIn("--profile vlan", startup)

    def test_legacy_archive_defaults_to_vlan_despite_current_single_lan(self):
        result, events = self.cached_restore_fixture(topology=None)
        self.assertEqual(result.returncode, 0, result.stderr + events)
        inventory = next(line for line in events.splitlines() if "config --images" in line)
        startup = next(line for line in events.splitlines() if " up " in line)
        self.assertIn("--profile vlan", inventory)
        self.assertIn("--profile vlan", startup)

    def test_cached_inventory_uses_archive_defaults_not_installed_image_override(self):
        result, events = self.cached_restore_fixture()
        self.assertEqual(result.returncode, 0, result.stderr + events)
        self.assertIn("image inspect fixture-default-pihole", events)
        self.assertNotIn("fixture-installed-pihole", events)

    def test_corrupt_nested_volume_is_rejected(self):
        result = self.shell('validate_archive_safety "$1"', self.archive(volume=b"broken"))
        self.assertNotEqual(result.returncode, 0)

    def test_escaping_link_is_rejected(self):
        archive = self.archive()
        tree = self.base / "tree-modern"
        (tree / "project/monitoring/escape").symlink_to("../../../outside")
        with tarfile.open(archive, "w:gz") as tar:
            for entry in tree.iterdir():
                tar.add(entry, arcname=entry.name)
        result = self.shell('validate_archive_safety "$1"', archive)
        self.assertNotEqual(result.returncode, 0)

    def test_link_cannot_escape_project_when_wrapper_is_removed(self):
        archive = self.archive()
        tree = self.base / "tree-modern"
        (tree / "project/monitoring/out").symlink_to("../../outside")
        with tarfile.open(archive, "w:gz") as tar:
            for entry in tree.iterdir():
                tar.add(entry, arcname=entry.name)
        self.assert_restore_rejected(archive)

    def test_link_cannot_leave_project_and_reenter_wrapper(self):
        archive = self.archive()
        tree = self.base / "tree-modern"
        (tree / "project/monitoring/out").symlink_to("../../project/.env")
        with tarfile.open(archive, "w:gz") as tar:
            for entry in tree.iterdir():
                tar.add(entry, arcname=entry.name)
        self.assert_restore_rejected(archive)

    def test_nested_volume_link_chain_cannot_escape(self):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as tar:
            directory = tarfile.TarInfo("dir")
            directory.type = tarfile.DIRTYPE
            tar.addfile(directory)
            for name, target in (("dir/b", ".."), ("a", "dir/b/..")):
                link = tarfile.TarInfo(name)
                link.type = tarfile.SYMTYPE
                link.linkname = target
                tar.addfile(link)
        self.assert_restore_rejected(self.archive(volume=data.getvalue()))

    def test_authentication_volume_is_captured_and_restored(self):
        destination = self.base / "captured"
        destination.mkdir()
        # Fake Docker's external volume store; test the real backup/restore
        # iteration and assert that authentication state completes the trip.
        result = self.shell('''
ensure_helper_image() { :; }
docker() { return 0; }
helper_backup_volume() { printf 'authentication-state' > "$2/$3.tar.gz"; }
helper_restore_volume() { cat "$2/$3.tar.gz" > "$ROOT_DIR/$3.restored"; }
backup_volumes "$1/volumes"
restore_volumes "$1"
''', destination)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.install / "authelia_data.restored").exists())
        self.assertEqual((self.install / "authelia_data.restored").read_text(), "authentication-state")

    def test_every_compose_volume_has_backup_coverage(self):
        if not shutil.which("docker"):
            self.skipTest("Docker Compose CLI is not installed")
        config = subprocess.run([
            "docker", "compose", "--env-file", str(ROOT / ".env.example"),
            "--profile", "vlan", "-f", str(ROOT / "docker-compose.yml"),
            "-f", str(ROOT / "docker-compose.monitoring.yml"), "config", "--format", "json",
        ], capture_output=True, text=True, check=True)
        volumes = set(json.loads(config.stdout)["volumes"])
        destination = self.base / "inventory"
        result = self.shell('''
ensure_helper_image() { :; }
docker() { return 0; }
helper_backup_volume() { printf data > "$2/$3.tar.gz"; }
backup_volumes "$1"
''', destination)
        self.assertEqual(result.returncode, 0, result.stderr)
        captured = {p.name.removesuffix(".tar.gz") for p in destination.iterdir()}
        self.assertEqual(captured, volumes)


if __name__ == "__main__":
    unittest.main()
