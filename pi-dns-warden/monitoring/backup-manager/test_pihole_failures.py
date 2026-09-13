import unittest
from unittest import mock
from urllib.error import URLError

import pihole_client


class PiholeFailureTests(unittest.TestCase):
    def test_connection_failure_reports_offline(self):
        target = pihole_client.PIHOLE_API_TARGETS[0]
        with mock.patch.object(pihole_client, "pihole_api_call", side_effect=URLError("connection refused")):
            result = pihole_client.probe_pihole_api(target, {target["password_key"]: "fixture"})
        self.assertEqual(result["status"], "offline")
        self.assertIn("connection refused", result["detail"])

    def test_malformed_response_reports_degraded(self):
        target = pihole_client.PIHOLE_API_TARGETS[0]
        with mock.patch.object(pihole_client, "pihole_api_call", return_value={}):
            result = pihole_client.probe_pihole_api(target, {target["password_key"]: "fixture"})
        self.assertEqual(result["status"], "degraded")


if __name__ == "__main__":
    unittest.main()
