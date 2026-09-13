import unittest
from unittest import mock
from urllib.error import URLError

import pihole_client
import server


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


class PiholeStatsTests(unittest.TestCase):
    def stats(self, summary):
        target = server.PIHOLE_API_TARGETS[0]
        with mock.patch.object(server, "PIHOLE_API_TARGETS", [target]), \
             mock.patch.object(server, "read_env_values_safe", return_value={target["password_key"]: "fixture"}), \
             mock.patch.object(server, "pihole_api_call", side_effect=[{"session": {"sid": "fixture"}}, summary]), \
             mock.patch.object(server, "pihole_logout"):
            return server.get_dns_stats()["planes"][0]

    def valid_summary(self):
        return {"queries": {"total": 20, "blocked": 5, "percent_blocked": 25.0},
                "gravity": {"domains_being_blocked": 100}}

    def test_missing_or_malformed_stats_are_unavailable_not_zero(self):
        malformed = [{}, [], None, {"queries": {}}, {"error": "fixture"}]
        for section, key in (("queries", "total"), ("queries", "blocked"),
                             ("queries", "percent_blocked"), ("gravity", "domains_being_blocked")):
            missing = self.valid_summary()
            del missing[section][key]
            malformed.append(missing)
            for value in (None, "0", True, -1, float("nan"), float("inf")):
                bad = self.valid_summary()
                bad[section][key] = value
                malformed.append(bad)
        for summary in malformed:
            with self.subTest(summary=summary):
                result = self.stats(summary)
                self.assertEqual(result["status"], "degraded")
                self.assertNotIn("queries_today", result)
                self.assertNotIn("domains_on_blocklist", result)

    def test_valid_measurements_preserve_real_values_and_zero(self):
        result = self.stats(self.valid_summary())
        self.assertEqual(result["status"], "healthy")
        self.assertEqual(result["queries_today"], 20)
        self.assertEqual(result["blocked_today"], 5)
        self.assertEqual(result["percent_blocked"], 25.0)
        self.assertEqual(result["domains_on_blocklist"], 100)
        result = self.stats({"queries": {"total": 0, "blocked": 0, "percent_blocked": 0},
                             "gravity": {"domains_being_blocked": 0}})
        self.assertEqual(result["status"], "healthy")
        self.assertEqual(result["queries_today"], 0)


if __name__ == "__main__":
    unittest.main()
