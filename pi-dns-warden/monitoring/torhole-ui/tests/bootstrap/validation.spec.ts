import { expect, test } from "@playwright/test";

const checks = [
  { id: "compose", label: "Compose render", description: "Resolve installed Compose definitions.", remediation: "Correct missing environment values." },
  { id: "prometheus_config", label: "Prometheus config", description: "Check installed scrape configuration.", remediation: "Review prometheus.runtime.yml." },
];
const previous = { status: "success", summary: "Previous configuration passed.", checks: checks.map(c => ({ ...c, status: "success" })), started_at: "2026-09-01T10:00:00Z", finished_at: "2026-09-01T10:00:01Z", detail: "legacy-secret-never-export" };
const preview = { scope: "Configuration checks only — not live DNS or leak protection.", impact: "No service restarts or image pulls.", checks, running: false, started_at: null, progress: [], last_result: previous };

test("validation previews checks, shows real progress separately and exports a safe report", async ({ page }) => {
  await page.route("**/api/config", route => route.fulfill({ json: { config: { TORHOLE_EDITION: "advanced", TORHOLE_TOPOLOGY: "vlan" } } }));
  await page.route("**/api/system/snapshot", route => route.fulfill({ status: 503, json: { error: "Snapshot unavailable" } }));
  let running = false;
  let release!: () => void;
  const completed = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/system/validation", route => route.fulfill({ json: {
    ...preview, running, progress: running ? [{ ...checks[0], status: "success" }, { ...checks[1], status: "running" }] : [],
  } }));
  await page.route("**/api/system/validate", async route => {
    running = true;
    await completed;
    running = false;
    await route.fulfill({ json: { ...previous, status: "error", summary: "Validation failed at Prometheus config.", checks: [{ ...checks[0], status: "success" }, { ...checks[1], status: "error" }] } });
  });
  await page.goto("/?mode=advanced#/operate?section=validation");
  await expect(page.getByRole("heading", { name: "Checks", exact: true })).toBeVisible();
  await expect(page.getByText(checks[0].label, { exact: true })).toHaveCount(1);
  await expect(page.getByText(checks[0].description)).not.toBeVisible();
  await page.getByRole("button", { name: /Compose render/ }).click();
  await expect(page.getByText(checks[0].description)).toBeVisible();
  await page.getByRole("button", { name: /Compose render/ }).click();
  await expect(page.getByText(checks[0].description)).not.toBeVisible();
  await expect(page.getByText("Configuration only — not a DNS/privacy test.")).toBeVisible();
  await expect(page.getByText(preview.impact)).not.toBeVisible();
  await page.getByText("Scope and technical details", { exact: true }).click();
  await expect(page.getByText(preview.impact)).toBeVisible();
  await page.getByText("Scope and technical details", { exact: true }).click();
  const tabs = await page.getByRole("tab").all();
  const positions = await Promise.all(tabs.map(tab => tab.boundingBox()));
  expect(positions.every(p => p && p.height <= 48 && Math.abs(p.y - positions[0]!.y) < 2)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("validation-preview.png"), fullPage: true });
  await page.getByRole("button", { name: "run validation", exact: true }).click();
  const current = page.getByRole("region", { name: "Current validation" });
  await expect(current.getByText("running", { exact: true })).toBeVisible();
  await expect(page.getByText("Previous result", { exact: true })).toBeVisible();
  await expect(page.getByText(previous.summary)).not.toBeVisible();
  await expect(current.getByText(checks[0].label, { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "running…", exact: true })).toBeDisabled();
  release();
  await expect(page.getByText("Validation failed at Prometheus config.")).toBeVisible();
  await expect(page.getByText("Review prometheus.runtime.yml.")).toBeVisible();
  await expect(page.getByText(checks[1].description)).toBeVisible();
  await expect(page.getByText(checks[0].description)).not.toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download report" }).click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  let report = "";
  for await (const chunk of stream!) report += chunk.toString();
  expect(report).not.toContain("legacy-secret-never-export");
  expect(JSON.parse(report).status).toBe("error");
});

test("preview failure disables execution and offers retry", async ({ page }) => {
  await page.route("**/api/config", route => route.fulfill({ json: { config: {} } }));
  await page.route("**/api/system/snapshot", route => route.fulfill({ status: 503, json: {} }));
  await page.route("**/api/system/validation", route => route.fulfill({ status: 503, json: { error: "Preview unavailable" } }));
  await page.goto("/?mode=advanced#/operate?section=validation");
  await expect(page.getByText(/Could not load validation preview/)).toBeVisible();
  await expect(page.getByRole("button", { name: "run validation", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Retry preview" })).toBeVisible();
});

test("ten checks stay compact and explanations are keyboard accessible", async ({ page }) => {
  const catalog = [...checks, ...[
    "Prometheus rules", "Alertmanager config", "Caddy config", "Authelia config",
    "Alloy config", "Dashboard JSON", "Pi-hole exporter Python", "Backup manager Python",
  ].map((label, i) => ({ id: `check-${i}`, label, description: `Details for ${label}.`, remediation: "Review the installed configuration." }))];
  await page.route("**/api/config", route => route.fulfill({ json: { config: {} } }));
  await page.route("**/api/system/snapshot", route => route.fulfill({ status: 503, json: {} }));
  await page.route("**/api/system/validation", route => route.fulfill({ json: {
    ...preview, checks: catalog, last_result: { ...previous, checks: catalog.map(c => ({ ...c, status: "success" })) },
  } }));
  await page.goto("/?mode=advanced#/operate?section=validation");
  const list = page.getByRole("region", { name: "Validation checks" });
  await expect(list.getByRole("button")).toHaveCount(10);
  const bounds = await list.boundingBox();
  expect(bounds!.height).toBeLessThan(450);
  const compose = list.getByRole("button", { name: /Compose render/ });
  await compose.focus();
  await page.keyboard.press("Enter");
  await expect(compose).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText(checks[0].description)).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(compose).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({ path: test.info().outputPath("validation-desktop.png"), fullPage: true });
  // The Advanced app shell deliberately supports a 1024px minimum width.
  // Changing its phone layout is separate from this validation-page cleanup.
  await page.setViewportSize({ width: 1024, height: 768 });
  for (const name of ["run validation", "Download report"]) {
    const button = page.getByRole("button", { name, exact: true });
    const box = await button.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1024);
    expect(box!.height).toBeLessThanOrEqual(40);
  }
  await page.screenshot({ path: test.info().outputPath("validation-tablet.png"), fullPage: true });
});
