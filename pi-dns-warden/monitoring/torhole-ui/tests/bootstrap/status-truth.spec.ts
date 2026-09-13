import { expect, test } from "@playwright/test";

const counts = { healthy: 1, degraded: 0, offline: 0, total: 1 };
const snapshot = {
  schema_version: 1, generated_at: "2026-09-13T10:00:00Z", banner: null,
  torhole: { overall_status: "healthy", privacy_intact: true, headline: "DNS is resolving through the isolated Tor path.", summary_sentence: "Privacy path verified." },
  tor: { overall_status: "healthy", summary: "Tor ready", bootstrap: { status: "healthy", percent: 100 }, isolation: { status: "healthy" }, network_path: { status: "healthy" }, plane_identities: { overall_status: "healthy" }, circuits: { available: true, items: [], by_plane: { trusted: [], iot: [] }, count: 0 }, last_rotation_at: null },
  dns: { planes: [{ id: "trusted", label: "Flat LAN", status: "healthy" }], counts, overall_status: "healthy", totals: { queries_today: 100, blocked_today: 10, block_pct: 10 } },
  leak_test: { available: true, last_result: null, last_run_at: null, history_count: 0, recent_pass_rate: null, history: [] },
  containers: [{ id: "tor", name: "tor", label: "Tor", status: "healthy", core: true }], container_counts: counts,
  backup: { snapshot_count: 0, last_snapshot_name: null, last_snapshot_at: null, last_snapshot_size_bytes: null },
  alerts: { total_channels: 0, configured_channels: 0, enabled_channels: 0 }, validation: { last_result: null }, recovery: { status: "idle", latest_archive: null, finished_at: null }, links: {},
};

for (const screen of ["", "privacy", "operate", "configure"]) {
  test(`${screen || "Glance"} stops presenting old snapshot data as live after an outage and recovers`, async ({ page }) => {
    await page.clock.install({ time: new Date("2026-09-13T10:00:00Z") });
    let offline = false;
    await page.route("**/api/**", route => route.fulfill({ json: { config: {}, channels: [], backups: [], planes: [], status: {} } }));
    await page.route("**/api/system/snapshot", route => route.fulfill(offline ? { status: 503, json: { error: "Unavailable" } } : { json: snapshot }));
    await page.route("**/api/system/validation", route => route.fulfill({ json: { checks: [], progress: [], running: false, last_result: null } }));
    await page.goto(`/?mode=advanced#/${screen}`);
    await expect(page.getByText(/^(?:live ·|Updated) just now$/)).toBeVisible();
    if (screen === "privacy") await page.getByRole("tab", { name: /Tor circuits/i }).click();
    offline = true;
    await page.clock.runFor(5000);
    await expect(page.getByText(/^Updates unavailable · last updated 5s ago$/)).toBeVisible();
    await expect(page.getByText(/^DNS routed through Tor$/)).not.toBeVisible();
    await expect(page.getByText(/^live ·/)).not.toBeVisible();
    if (screen === "privacy") {
      const circuits = page.getByRole("tabpanel", { name: /Tor circuits/i });
      await expect(circuits).toContainText("Circuit status unavailable");
      await expect(circuits.getByText("loading…", { exact: true })).not.toBeVisible();
    }
    await page.clock.runFor(10000);
    await expect(page.getByText(/^Updates unavailable · last updated 15s ago$/)).toBeVisible();
    offline = false;
    await page.clock.runFor(5000);
    await expect(page.getByText(/^Updated just now$/)).toBeVisible();
    if (screen === "privacy") {
      const circuits = page.getByRole("tabpanel", { name: /Tor circuits/i });
      await expect(circuits).toContainText("Tor's current circuit table");
      await expect(circuits).not.toContainText("Circuit status unavailable");
    }
  });
}

for (const scenario of [
  { name: "failed leak test", button: "Run leak test", endpoint: "leak-test/run", result: { pass: false, is_tor: false, error: null, verification_status: "confirmed_not_tor" }, message: "Leak test failed: exit is not Tor" },
  { name: "unavailable leak test", button: "Run leak test", endpoint: "leak-test/run", result: { pass: false, is_tor: false, error: "Exit service unavailable", verification_status: "unavailable" }, message: "Exit service unavailable" },
  { name: "failed validation", button: "Run validation", endpoint: "system/validate", result: { status: "error", summary: "Prometheus configuration failed", checks: [] }, message: "Prometheus configuration failed" },
]) {
  test(`Quick actions reports ${scenario.name} despite HTTP 200`, async ({ page }) => {
    await page.route("**/api/system/snapshot", route => route.fulfill({ json: snapshot }));
    await page.route(`**/api/${scenario.endpoint}`, route => route.fulfill({ json: scenario.result }));
    await page.goto("/?mode=advanced#/");
    const button = page.getByRole("button", { name: new RegExp(scenario.button) });
    await button.click();
    await expect(button).toContainText(scenario.message);
    await expect(button).toHaveAttribute("title", scenario.message);
  });
}
