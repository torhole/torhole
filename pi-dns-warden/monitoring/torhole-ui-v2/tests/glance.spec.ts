/*
 * Smoke tests for the Glance screen.
 *
 * Talks to the live Pi behind Authelia. The global-setup already ran a
 * login and saved the cookie, so these tests hit /v2/ directly and expect
 * a logged-in session.
 */

import { test, expect } from "@playwright/test";

test.describe("Glance screen", () => {
  test("loads and shows the privacy hero", async ({ page }) => {
    await page.goto("/v2/");

    // Main content area header (eyebrow + title). Scoped to <main> because
    // "Glance" also appears in the sidebar nav link.
    const main = page.getByRole("main");
    await expect(main.getByText("Glance", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Is the privacy guarantee intact?" }),
    ).toBeVisible();

    // Hero statement
    await expect(page.getByText("DNS exits via Tor", { exact: true })).toBeVisible();

    // Live indicator
    await expect(page.getByText(/LIVE\s*·/i)).toBeVisible();
  });

  test("shows all containers healthy", async ({ page }) => {
    await page.goto("/v2/");

    // Containers section header with 14/14 healthy meta
    await expect(page.getByText(/14\/14\s*healthy/i)).toBeVisible();

    // Core containers should be visible (chips)
    for (const name of ["tor", "dnscrypt-trusted", "pihole_trusted", "authelia"]) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    }
  });

  test("shows all 3 DNS planes serving", async ({ page }) => {
    await page.goto("/v2/");

    // DNS planes section header with 2/2 serving meta
    await expect(page.getByText(/2\/2\s*serving/i)).toBeVisible();

    // Plane labels
    await expect(page.getByText("Trusted", { exact: true })).toBeVisible();
    await expect(page.getByText("IoT", { exact: true })).toBeVisible();
  });

  test("sidebar has a sign-out control", async ({ page }) => {
    await page.goto("/v2/");
    // Button only (no click — clicking would destroy the shared test session).
    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
  });

  test("plane cards degrade when tor egress is down", async ({ page }) => {
    // Intercept the live snapshot and force tor down — the plane cards must
    // stop claiming "via tor" and the serving count must drop to zero, even
    // though Pi-hole keeps counting forwarded (unanswered) queries.
    await page.route("**/api/system/snapshot", async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      json.tor.overall_status = "offline";
      await route.fulfill({ response: res, json });
    });
    await page.goto("/v2/");

    await expect(page.getByText(/0\/2\s*serving/i)).toBeVisible();
    await expect(page.getByText("tor down").first()).toBeVisible();
    await expect(
      page.getByText(/egress down — forwarded queries are not resolving/i).first(),
    ).toBeVisible();
  });

  test("shows 4 proof tiles with data", async ({ page }) => {
    await page.goto("/v2/");

    // Each of the 4 tiles should be visible by its label
    await expect(page.getByText("DNS", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("TOR", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("ALERTS", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("BACKUP", { exact: true }).first()).toBeVisible();

    // TOR tile says BOOTSTRAPPED (the bold mono badge)
    await expect(page.getByText("BOOTSTRAPPED", { exact: true })).toBeVisible();
  });

  test("shows live Quick Actions strip with four enabled buttons", async ({ page }) => {
    await page.goto("/v2/");

    // The Quick Actions section lives at the bottom of Glance. The four
    // buttons are live as of the post-Phase-A finishing pass — each one
    // wired to a real backend endpoint. The title is rendered in a div
    // that also contains the meta text, so we use a non-exact match.
    await expect(page.getByText(/Quick actions/i)).toBeVisible();

    // Use getByRole("button", { name: ... }) so we match the clickable
    // element, not the literal text elsewhere in the DOM. Labels match
    // the rendered titles in QuickActions.
    const rotate = page.getByRole("button", { name: /Rotate Tor identity/i });
    const leak = page.getByRole("button", { name: /Run leak test/i });
    const validate = page.getByRole("button", { name: /Run validation/i });
    const snapshot = page.getByRole("button", { name: /Take snapshot/i });

    for (const btn of [rotate, leak, validate, snapshot]) {
      await expect(btn).toBeVisible();
      await expect(btn).toBeEnabled();
    }
    // Do NOT click any of them here — the four actions (rotate, leak test,
    // validation, backup) all have real side effects. The actions.spec.ts
    // suite already exercises rotate + leak test end-to-end; the other two
    // are covered indirectly by operate.spec.ts.
  });
});
