/*
 * Smoke tests for the Operate screen.
 *
 * Operate is split into four tabs via SectionTabs: Containers (default),
 * Backups, Validation, Insights. Tab content is mounted but hidden when
 * inactive (so SSE connections persist), which means tests for non-default
 * tabs must click the tab before asserting visibility.
 *
 * NOTE: The "run validation" test is skipped by default because it runs
 * the real validation script (which takes 10-30s, calls docker multiple
 * times, and creates side effects). Enable it explicitly with
 *   npx playwright test operate.spec.ts --grep @slow
 * when you want a deeper check.
 */

import { test, expect } from "@playwright/test";

test.describe("Operate screen", () => {
  test("loads and shows four section tabs", async ({ page }) => {
    await page.goto("/v2/#/operate");

    await expect(
      page.getByRole("heading", { name: "What do you need to change?" }),
    ).toBeVisible();

    // Four tab buttons rendered with role=tab
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(4);

    // Their labels (substring match — the tab button also contains the meta)
    await expect(page.getByRole("tab", { name: /Containers/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Backups/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Stack validation/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Insights/i })).toBeVisible();
  });

  test("default tab shows the containers table", async ({ page }) => {
    await page.goto("/v2/#/operate");

    // Containers is the default tab — no click needed.
    // Core services should be in the table.
    for (const name of ["tor", "dnscrypt-trusted", "pihole_trusted", "authelia"]) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    }

    // Table has a restart button per row (14 containers in catalog)
    const restartButtons = page.getByRole("button", { name: "restart" });
    const n = await restartButtons.count();
    expect(n).toBeGreaterThanOrEqual(10);
  });

  test("shows the backups section", async ({ page }) => {
    await page.goto("/v2/#/operate");

    // Click the Backups tab first — content is hidden until the tab is active.
    await page.getByRole("tab", { name: /Backups/i }).click();

    await expect(
      page.getByRole("button", { name: /create snapshot/i }),
    ).toBeVisible();
  });

  test("shows the validation section", async ({ page }) => {
    await page.goto("/v2/#/operate");

    await page.getByRole("tab", { name: /Stack validation/i }).click();

    await expect(
      page.getByRole("button", { name: /run validation/i }),
    ).toBeVisible();
  });

  test("shows previous validation result from snapshot", async ({ page }) => {
    // The snapshot includes the last validation result from the in-memory
    // state written by any previous run. If someone ran validation in the
    // last session, we should see its result block. If not, the "no
    // validation run yet" placeholder.
    await page.goto("/v2/#/operate");

    await page.getByRole("tab", { name: /Stack validation/i }).click();

    // Either the placeholder OR a result block is visible.
    const placeholder = page.getByText(/no validation run yet/i);
    const successBlock = page.getByText(/Stack configuration validated successfully/i);
    const failBlock = page.getByText(/Validation failed/i);

    const anyOne =
      (await placeholder.isVisible().catch(() => false)) ||
      (await successBlock.isVisible().catch(() => false)) ||
      (await failBlock.isVisible().catch(() => false));
    expect(anyOne).toBe(true);
  });

  test("insights tab shows Grafana dashboard tiles", async ({ page }) => {
    await page.goto("/v2/#/operate");

    await page.getByRole("tab", { name: /Insights/i }).click();

    // Group headers
    await expect(page.getByText(/Metrics · Grafana dashboards/i)).toBeVisible();

    // A few representative tiles
    await expect(page.getByText("Control Room", { exact: true })).toBeVisible();
    await expect(page.getByText("DNS Path", { exact: true })).toBeVisible();
    await expect(page.getByText("Prometheus", { exact: true })).toBeVisible();
    await expect(page.getByText("Alertmanager", { exact: true })).toBeVisible();

    // Tiles link out — check that the Control Room tile is a link with a
    // grafana host in the href (once the config loads).
    const grafanaLink = page
      .locator("a")
      .filter({ hasText: "Control Room" })
      .first();
    await expect(grafanaLink).toBeVisible();
    const href = await grafanaLink.getAttribute("href");
    expect(href).toMatch(/^https:\/\/grafana\./);
    expect(href).toContain("/d/pidns-control/");
  });
});
