import importlib.util
import unittest
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("control_helper_tests", Path(__file__).with_name("server.py"))
server = importlib.util.module_from_spec(SPEC)
with mock.patch.dict("os.environ", {"CONTROL_HELPER_TOKEN": "fixture"}), mock.patch("http.server.ThreadingHTTPServer"):
    SPEC.loader.exec_module(server)


class TorReplyTests(unittest.TestCase):
    def command(self, transcript, command="SIGNAL NEWNYM"):
        sock = mock.MagicMock()
        sock.__enter__.return_value = sock
        sock.recv.side_effect = [transcript[:7], transcript[7:], b""]
        with mock.patch("builtins.open", mock.mock_open(read_data=b"fixture")), mock.patch.object(server.socket, "socket", return_value=sock):
            return server.tor_command(command)

    def test_command_error_after_successful_authentication_is_rejected(self):
        with self.assertRaises(RuntimeError):
            self.command(b"250 OK\r\n551 Internal error\r\n250 closing connection\r\n")

    def test_incomplete_response_is_rejected(self):
        with self.assertRaises(RuntimeError):
            self.command(b"250 OK\r\n")

    def test_successful_command_is_accepted(self):
        transcript = b"250 OK\r\n250 OK\r\n250 closing connection\r\n"
        self.assertEqual(self.command(transcript), transcript.decode())

    def test_data_lines_are_not_mistaken_for_status_codes(self):
        transcript = b"250 OK\r\n250+circuit-status=\r\n551 BUILT $ABC PURPOSE=GENERAL\r\n.\r\n250 OK\r\n250 closing connection\r\n"
        self.assertEqual(self.command(transcript, "GETINFO circuit-status"), transcript.decode())


if __name__ == "__main__":
    unittest.main()
