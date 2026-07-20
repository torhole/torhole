/*
 * Visual regression tests — capture one screenshot per screen and diff
 * against a stored baseline on every run. If any pixel drifts beyond the
 * tolerance, the test fails and Playwright attaches the diff PNG.
 *
 * First run: baselines don't exist, Playwright writes them to
 *   tests/visual.spec.ts-snapshots/<name>-chromium-darwin.png
 * and marks the test as failed. Commit the baselines to version control.
 *
 * Subsequent runs: each test takes a fresh screenshot and compares. Small
 * differences are tolerated via maxDiffPixelRatio.
 *
 * Dynamic content (timestamps, query counts, live feed) is masked out with
 * mask selectors so the diffs stay stable across runs.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";

// Capture a fixed viewport-sized clip instead of the full page. fullPage
// screenshots of a dynamic page are fragile — if Tor builds a new circuit
// between runs, the page height changes and Playwright fails with a
// structural "expected 1280x1761, got 1280x1905" mismatch, which no
// maxDiffPixelRatio can tolerate. A fixed clip rect gives us a stable
// rectangle to compare and still covers everything above the fold.
const VIEWPORT_CLIP = { x: 0, y: 0, width: 1280, height: 900 } as const;

// Elements that change between runs. Mask them out so screenshots don't
// fail on cosmetic drift.
function volatileMasks(page: Page): Locator[] {
  return [
    // Live indicator ("live · just now", pulsing dot)
    page.getByText(/LIVE\s*·/i),
    // Snapshot metadata in headers that shows fetch time
    page.locator('[class*="tabular-nums"]'),
    // Any mono time value like "5m ago", "17h ago"
    page.getByText(/\d+[smhd]\s+ago/i),
    // Backup timestamps in Operate
    page.getByText(/\d{4}-\d{2}-\d{2}T/),
    // Live query feed (contents change constantly)
    page.locator('[class*="h-80"][class*="overflow-y-auto"]'),
    // Total queries on tiles (ticks up continuously)
    page.locator("text=/\\d{1,3}(,\\d{3})+\\s*queries/i"),
  ];
}

async function gotoAndSettle(page: Page, path: string) {
  // Visual baselines must not inherit the workstation or a prior test's
  // appearance preference. Light mode has its own functional persistence
  // coverage; keep screenshot diffs deterministic in the dark brand theme.
  await page.addInitScript(() => {
    localStorage.setItem("torhole.v2.theme", "dark");
  });
  await page.goto(path);
  // Wait for the snapshot poll to populate the page. 1s is enough for
  // the initial fetch + render on the Pi.
  await page.waitForTimeout(1200);
}

test.describe("visual regression", () => {
  test("Glance", async ({ page }) => {
    await gotoAndSettle(page, "/v2/");
    await expect(page).toHaveScreenshot("glance.png", {
      clip: VIEWPORT_CLIP,
      mask: volatileMasks(page),
      maxDiffPixelRatio: 0.03,
    });
  });

  test("Privacy", async ({ page }) => {
    await gotoAndSettle(page, "/v2/#/privacy");
    await expect(page).toHaveScreenshot("privacy.png", {
      clip: VIEWPORT_CLIP,
      mask: volatileMasks(page),
      maxDiffPixelRatio: 0.03,
    });
  });

  test("Operate", async ({ page }) => {
    await gotoAndSettle(page, "/v2/#/operate");
    await expect(page).toHaveScreenshot("operate.png", {
      clip: VIEWPORT_CLIP,
      mask: volatileMasks(page),
      maxDiffPixelRatio: 0.03,
    });
  });

  test("Configure", async ({ page }) => {
    await gotoAndSettle(page, "/v2/#/configure");
    await expect(page).toHaveScreenshot("configure.png", {
      clip: VIEWPORT_CLIP,
      mask: volatileMasks(page),
      maxDiffPixelRatio: 0.03,
    });
  });

});
