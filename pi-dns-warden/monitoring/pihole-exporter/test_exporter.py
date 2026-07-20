#!/usr/bin/env python3
import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("exporter.py")
SPEC = importlib.util.spec_from_file_location("torhole_pihole_exporter", MODULE_PATH)
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


class ClientMetricPrivacyTests(unittest.TestCase):
    def setUp(self):
        self.original_fetch_json = exporter.fetch_json
        self.original_export_client_metrics = exporter.EXPORT_CLIENT_METRICS
        self.paths = []

        def fake_fetch_json(_target, path):
            self.paths.append(path)
            if path == "/stats/top_clients":
                return {
                    "clients": [
                        {"ip": "192.0.2.10", "name": "example-client", "count": 7}
                    ]
                }
            return {}

        exporter.fetch_json = fake_fetch_json

    def tearDown(self):
        exporter.fetch_json = self.original_fetch_json
        exporter.EXPORT_CLIENT_METRICS = self.original_export_client_metrics

    def test_client_endpoint_and_labels_are_disabled_by_default(self):
        exporter.EXPORT_CLIENT_METRICS = False

        lines, errors = exporter.scrape_target({"role": "trusted"})

        self.assertEqual(errors, [])
        self.assertNotIn("/stats/top_clients", self.paths)
        self.assertFalse(any("pihole_top_client_queries_total" in line for line in lines))

    def test_client_metrics_require_explicit_opt_in(self):
        exporter.EXPORT_CLIENT_METRICS = True

        lines, errors = exporter.scrape_target({"role": "trusted"})

        self.assertEqual(errors, [])
        self.assertIn("/stats/top_clients", self.paths)
        top_client_lines = [
            line for line in lines if line.startswith("pihole_top_client_queries_total")
        ]
        self.assertEqual(len(top_client_lines), 1)
        self.assertIn('client_name="example-client"', top_client_lines[0])


if __name__ == "__main__":
    unittest.main()
