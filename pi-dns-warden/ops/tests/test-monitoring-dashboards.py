#!/usr/bin/env python3
import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
DASHBOARD_DIR = ROOT / "monitoring" / "grafana" / "dashboards"
DASHBOARD_FILES = sorted(DASHBOARD_DIR.glob("pi-dns-warden-*.json"))
ALERT_RULES_FILE = ROOT / "monitoring" / "prometheus" / "alert.rules.yml"


class MonitoringDashboardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dashboards = [json.loads(path.read_text()) for path in DASHBOARD_FILES]

    def test_expected_dashboards_and_unique_uids(self):
        self.assertEqual(len(self.dashboards), 6)
        uids = [dashboard["uid"] for dashboard in self.dashboards]
        self.assertEqual(len(uids), len(set(uids)))

    def test_panel_ids_refids_and_grid_positions_are_unique(self):
        for dashboard in self.dashboards:
            panels = dashboard["panels"]
            panel_ids = [panel["id"] for panel in panels]
            self.assertEqual(len(panel_ids), len(set(panel_ids)), dashboard["uid"])

            occupied = set()
            for panel in panels:
                refids = [target.get("refId") for target in panel.get("targets", [])]
                self.assertEqual(len(refids), len(set(refids)), panel["title"])

                pos = panel["gridPos"]
                cells = {
                    (x, y)
                    for x in range(pos["x"], pos["x"] + pos["w"])
                    for y in range(pos["y"], pos["y"] + pos["h"])
                }
                self.assertFalse(occupied & cells, f"grid overlap at {panel['title']}")
                occupied |= cells

    def test_current_state_cards_are_instant_and_actionable(self):
        for dashboard in self.dashboards:
            linked_panels = 0
            for panel in dashboard["panels"]:
                if panel.get("links"):
                    linked_panels += 1
                if panel.get("type") not in {"stat", "gauge", "bargauge"}:
                    continue
                for target in panel.get("targets", []):
                    datasource = target.get("datasource", panel.get("datasource", {}))
                    if datasource.get("type") == "prometheus":
                        self.assertTrue(target.get("instant"), panel["title"])
            self.assertGreater(linked_panels, 0, dashboard["uid"])

    def test_privacy_evidence_is_explicit_and_not_overclaimed(self):
        content = "\n".join(path.read_text() for path in DASHBOARD_FILES)
        for metric in (
            "torhole_leak_test_pass",
            "torhole_leak_test_age_seconds",
            "tor_control_port_up",
            "tor_enough_dir_info",
            "tor_bootstrap_percent",
            "tor_circuit_established",
        ):
            self.assertIn(metric, content)

        for forbidden_copy in (
            "Current privacy proof",
            "Privacy proof age",
            "confirmed that DNS egress is a Tor exit",
            "leak proof",
            "three planes",
            "three Pi-hole",
        ):
            self.assertNotIn(forbidden_copy, content)

    def test_removed_or_unavailable_telemetry_stays_removed(self):
        expressions = [
            target.get("expr", "")
            for dashboard in self.dashboards
            for panel in dashboard["panels"]
            for target in panel.get("targets", [])
        ]
        combined = "\n".join(expressions)
        self.assertNotIn("container_restart_count_total", combined)
        self.assertNotIn("pihole_top_client_queries_total", combined)
        self.assertNotIn('instance="reverse-proxy:443"', combined)
        self.assertFalse(
            any(
                "container=~" in expression
                and any(name in expression for name in ("pihole_", "dnscrypt-"))
                for expression in expressions
            )
        )

    def test_labeled_missing_value_fallbacks_use_empty_label_matching(self):
        expressions = [
            target.get("expr", "")
            for dashboard in self.dashboards
            for panel in dashboard["panels"]
            for target in panel.get("targets", [])
        ]
        raw_metrics = (
            "torhole_leak_test_pass",
            "torhole_leak_test_age_seconds",
            "tor_control_port_up",
            "tor_enough_dir_info",
            "tor_bootstrap_percent",
            "tor_network_liveness",
            "tor_circuit_established",
            "tor_entry_guards",
        )
        for metric in raw_metrics:
            fallbacks = [expr for expr in expressions if expr.startswith(metric + " or")]
            for expression in fallbacks:
                self.assertIn(" or on() vector(", expression)

    def test_log_panels_are_bounded_and_exclude_resolver_logs(self):
        log_panels = [
            panel
            for dashboard in self.dashboards
            for panel in dashboard["panels"]
            if panel.get("type") == "logs"
        ]
        self.assertLessEqual(len(log_panels), 1)
        for panel in log_panels:
            self.assertEqual(panel.get("timeFrom"), "30m")
            expression = " ".join(
                target.get("expr", "") for target in panel.get("targets", [])
            )
            self.assertNotIn("pihole_", expression)
            self.assertNotIn("dnscrypt-", expression)

    def test_alert_links_resolve_to_existing_dashboard_panels(self):
        dashboard_panels = {
            dashboard["uid"]: {panel["id"] for panel in dashboard["panels"]}
            for dashboard in self.dashboards
        }
        alert_blocks = re.split(
            r"(?=      - alert: )", ALERT_RULES_FILE.read_text()
        )[1:]
        self.assertGreater(len(alert_blocks), 0)

        for block in alert_blocks:
            name = re.search(r"- alert: (\S+)", block).group(1)
            runbook = re.search(r'runbook_url: "([^"]+)"', block)
            dashboard_uid = re.search(r'dashboard_uid: "([^"]+)"', block)
            panel_id = re.search(r'panel_id: "(\d+)"', block)
            self.assertIsNotNone(runbook, name)
            self.assertTrue(
                runbook.group(1).startswith(
                    "https://github.com/torhole/torhole/blob/main/"
                ),
                name,
            )
            self.assertIsNotNone(dashboard_uid, name)
            self.assertIsNotNone(panel_id, name)
            self.assertIn(dashboard_uid.group(1), dashboard_panels, name)
            self.assertIn(
                int(panel_id.group(1)),
                dashboard_panels[dashboard_uid.group(1)],
                name,
            )


if __name__ == "__main__":
    unittest.main()
