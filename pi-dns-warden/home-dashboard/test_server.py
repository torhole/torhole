import importlib.util
import tempfile
import unittest
from pathlib import Path


SERVER_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("torhole_home_server", SERVER_PATH)
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class ResolveUiPathTests(unittest.TestCase):
    def test_resolves_index_and_asset_inside_ui_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            (root / "index.html").write_text("home", encoding="utf-8")
            assets = root / "assets"
            assets.mkdir()
            (assets / "app.js").write_text("js", encoding="utf-8")

            self.assertEqual(server.resolve_ui_path("/", root), root / "index.html")
            self.assertEqual(
                server.resolve_ui_path("/assets/app.js?hash=1", root),
                assets / "app.js",
            )

    def test_rejects_missing_and_traversal_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "ui"
            root.mkdir()
            outside = root.parent / "secret"
            outside.write_text("no", encoding="utf-8")

            self.assertIsNone(server.resolve_ui_path("/missing.js", root))
            self.assertIsNone(server.resolve_ui_path("/../secret", root))
            self.assertIsNone(server.resolve_ui_path("/%2e%2e/secret", root))


if __name__ == "__main__":
    unittest.main()
