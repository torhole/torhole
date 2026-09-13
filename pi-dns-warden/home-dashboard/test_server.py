import importlib.util
import tempfile
import struct
import unittest
from pathlib import Path
from unittest import mock


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


class BuildInfoTests(unittest.TestCase):
    def test_reports_home_build_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            version_file = Path(tmp) / "VERSION"
            version_file.write_text("0.2.1-dev\n", encoding="utf-8")
            self.assertEqual(
                server.build_info(version_file, {"TORHOLE_REVISION": "abc123def456"}),
                {
                    "product": "Torhole",
                    "version": "0.2.1-dev",
                    "revision": "abc123def456",
                    "edition": "home",
                    "topology": "single-lan",
                },
            )

    def test_rejects_untrusted_build_tokens(self):
        with tempfile.TemporaryDirectory() as tmp:
            version_file = Path(tmp) / "VERSION"
            version_file.write_text("<script>\n", encoding="utf-8")
            info = server.build_info(version_file, {"TORHOLE_REVISION": "bad revision"})
            self.assertEqual(info["version"], "unknown")
            self.assertEqual(info["revision"], "unknown")


class DnsQueryTests(unittest.TestCase):
    def query(self, answers, flags=0x8180, query_id=1000):
        question = b"\x07example\x03com\0" + struct.pack("!HH", 1, 1)
        records = b"".join(
            b"\xc0\x0c" + struct.pack("!HHIH", kind, 1, 60, len(data)) + data
            for kind, data in answers
        )
        packet = struct.pack("!HHHHHH", query_id, flags, 1, len(answers), 0, 0) + question + records
        sock = mock.MagicMock()
        sock.__enter__.return_value = sock
        sock.recvfrom.return_value = (packet, ("pihole", 53))
        with mock.patch.object(server.socket, "socket", return_value=sock), mock.patch.object(server.time, "time", return_value=1):
            return server.dns_query("example.com")

    def test_reads_all_answer_records(self):
        result = self.query([(1, b"\x01\x02\x03\x04"), (1, b"\x05\x06\x07\x08")])
        self.assertEqual(result, {"ok": True, "answers": 2, "ips": ["1.2.3.4", "5.6.7.8"]})

    def test_follows_cname_record_to_address(self):
        result = self.query([(5, b"\xc0\x0c"), (1, b"\x05\x06\x07\x08")])
        self.assertEqual(result["ips"], ["5.6.7.8"])
        self.assertTrue(result["ok"])

    def test_cname_without_address_is_not_dns_success(self):
        self.assertFalse(self.query([(5, b"\xc0\x0c")])["ok"])

    def test_error_truncation_and_wrong_transaction_are_not_success(self):
        for options in ({"flags": 0x8182}, {"flags": 0x8380}, {"query_id": 1001}):
            with self.subTest(options=options):
                self.assertFalse(self.query([(1, b"\x01\x02\x03\x04")], **options)["ok"])


if __name__ == "__main__":
    unittest.main()
