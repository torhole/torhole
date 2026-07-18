import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path


SERVER_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("backup_manager_server", SERVER_PATH)
server_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server_module)


class BackendAuthenticationTests(unittest.TestCase):
    def test_health_remains_public(self):
        self.assertFalse(server_module.requires_backend_auth("/health"))
        self.assertFalse(server_module.requires_backend_auth("/api/metrics/tor"))

    def test_direct_api_request_is_rejected(self):
        protected_paths = (
            "/api/config",
            "/api/recovery",
            "/api/recovery/download?archive=test.tar.gz",
            "/api/recovery/backup",
            "/api/services/action",
            "/api/not-a-route",
        )
        self.assertTrue(all(server_module.requires_backend_auth(path) for path in protected_paths))
        self.assertFalse(
            server_module.is_backend_request_authorized({}, "test-proxy-token-32-characters-long")
        )

    def test_proxy_token_reaches_normal_routing(self):
        self.assertTrue(
            server_module.is_backend_request_authorized(
                {"Authorization": "Bearer test-proxy-token-32-characters-long"},
                "test-proxy-token-32-characters-long",
            )
        )

    def test_wrong_proxy_token_is_rejected(self):
        self.assertFalse(
            server_module.is_backend_request_authorized(
                {"Authorization": "Bearer wrong-token"},
                "test-proxy-token-32-characters-long",
            )
        )


class EnvFilePermissionTests(unittest.TestCase):
    """Audit S3: every file in the .env write lifecycle must end up 0600, and
    values may not smuggle extra lines via control characters."""

    def _use_temp_env(self):
        tmp = tempfile.mkdtemp()
        env = Path(tmp) / ".env"
        env.write_text("EXISTING=1\n", encoding="utf-8")
        os.chmod(env, 0o644)  # simulate a legacy world-readable .env
        self.addCleanup(lambda: __import__("shutil").rmtree(tmp, ignore_errors=True))
        # ENV_FILE moved to env_store (T-048); patch both seams so the
        # write path targets the tempdir regardless of which module reads it.
        server_module.ENV_FILE = env
        server_module.env_store.ENV_FILE = env
        return env

    def _mode(self, path):
        return stat.S_IMODE(os.stat(path).st_mode)

    def test_update_forces_env_and_backup_to_0600(self):
        env = self._use_temp_env()
        backup_path, _ = server_module.update_env_keys({"TZ": "Europe/London"})
        self.assertEqual(self._mode(env), 0o600)
        self.assertEqual(self._mode(backup_path), 0o600)

    def test_control_chars_in_value_rejected(self):
        self._use_temp_env()
        with self.assertRaises(ValueError):
            server_module.update_env_keys({"TZ": "Europe/London\nEVIL=1"})


if __name__ == "__main__":
    unittest.main()
