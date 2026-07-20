/*
 * Smoke tests for the Configure screen.
 *
 * Configure is split into five tabs via SectionTabs: Identity (default),
 * Topology, Alert channels, Banner, and App parameters. Tab content is mounted but hidden
 * when inactive, so tests for non-default tabs must click the tab before
 * asserting visibility.
 */

import { test, expect } from "@playwright/test";

test.describe("Configure screen", () => {
  test("loads and shows five section tabs", async ({ page }) => {
    await page.goto("/#/configure");

    await expect(
      page.getByRole("heading", { name: "What can you tune?" }),
    ).toBeVisible();

    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(5);

    await expect(page.getByRole("tab", { name: /Identity & access/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Topology/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Alert channels/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Banner/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /App parameters/i })).toBeVisible();
  });

  test("default tab shows the admin user from .env", async ({ page }) => {
    await page.goto("/#/configure");

    const configResponse = await page.request.get("/api/config");
    expect(configResponse.ok()).toBeTruthy();
    const payload = (await configResponse.json()) as {
      config: Record<string, string>;
    };
    const expectedAdmin = payload.config.TORHOLE_ADMIN_USER;
    expect(expectedAdmin).toBeTruthy();

    // Identity tab is the default — no click needed.
    // Scope to the Identity tabpanel so we don't collide with the TORHOLE_ADMIN_USER
    // key that also appears in the Advanced tab's .env dump.
    const panel = page.getByRole("tabpanel", { name: /Identity & access/i });
    await expect(panel.getByText("Admin user")).toBeVisible();
    await expect(panel.getByText(expectedAdmin, { exact: true })).toBeVisible();
  });

  test("identity tab shows the admin password change form", async ({ page }) => {
    await page.goto("/#/configure");

    // The password change form now requires THREE inputs: current + new + confirm.
    // We only verify gating — we do NOT submit the form, because submitting
    // with the correct current password would rotate Authelia and log
    // Playwright out for the rest of the suite.
    const panel = page.getByRole("tabpanel", { name: /Identity & access/i });
    await expect(panel.getByText(/Change admin password/i)).toBeVisible();
    const currentPwd = panel.getByPlaceholder(/verify it's really you/i);
    const newPwd = panel.getByPlaceholder(/min 12 chars/i);
    const confirmPwd = panel.getByPlaceholder(/type it again/i);
    await expect(currentPwd).toBeVisible();
    await expect(newPwd).toBeVisible();
    await expect(confirmPwd).toBeVisible();

    // Update button is disabled initially (no input).
    const update = panel.getByRole("button", { name: /update password/i });
    await expect(update).toBeDisabled();

    // Short new password — still disabled + shows policy error.
    await newPwd.fill("short");
    await expect(update).toBeDisabled();
    await expect(panel.getByText(/at least 12 characters/i)).toBeVisible();

    // Valid new password but no current or confirm yet — still disabled.
    await newPwd.fill("ValidPass1234");
    await expect(update).toBeDisabled();

    // Confirm mismatch — still disabled.
    await confirmPwd.fill("ValidPass1235");
    await expect(update).toBeDisabled();
    await expect(panel.getByText(/do not match/i)).toBeVisible();

    // Matching confirm, but still no current password — still disabled.
    await confirmPwd.fill("ValidPass1234");
    await expect(update).toBeDisabled();

    // Fill a (fake) current password — button enables. Do NOT click.
    // The fake value will fail the backend verification if submitted;
    // the test deliberately stops at "enabled" so we never trigger a
    // real Authelia rotation.
    await currentPwd.fill("definitely-not-the-real-password");
    await expect(update).toBeEnabled();

    // Reuse detection: if current === new, button re-disables with a
    // dedicated reuse warning.
    await currentPwd.fill("ValidPass1234");
    await expect(update).toBeDisabled();
    await expect(panel.getByText(/must differ from the current/i)).toBeVisible();
  });

  test("topology tab matches the installed capability profile", async ({ page }) => {
    await page.goto("/#/configure");

    await page.getByRole("tab", { name: /Topology/i }).click();

    const singleLan = page.getByText("Single LAN", { exact: true });
    if (await singleLan.isVisible()) {
      await expect(page.getByText("Flat LAN", { exact: true })).toBeVisible();
      await expect(page.getByText("IoT", { exact: true })).toHaveCount(0);
      await expect(page.getByText("vlan id", { exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByText("Segmented VLANs", { exact: true })).toBeVisible();
      await expect(page.getByText("Trusted", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("IoT", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("vlan id").first()).toBeVisible();
    }

    await expect(page.getByText("parent").first()).toBeVisible();
    await expect(page.getByText("subnet").first()).toBeVisible();
    await expect(page.getByText("pihole ip").first()).toBeVisible();
  });

  test("alerts tab shows channels with at least one configured", async ({ page }) => {
    await page.goto("/#/configure");

    await page.getByRole("tab", { name: /Alert channels/i }).click();

    // Telegram is usually the one channel configured on the live stack.
    await expect(page.getByText("Telegram", { exact: true })).toBeVisible();
    await expect(page.getByText("Email", { exact: true })).toBeVisible();

    // Toggles are role=switch — filter to the visible tab panel to avoid
    // the collapsed-sidebar switch elsewhere on the page.
    const panel = page.getByRole("tabpanel", { name: /Alert channels/i });
    const toggles = panel.getByRole("switch");
    const n = await toggles.count();
    expect(n).toBeGreaterThanOrEqual(2);
  });

  test("advanced tab is expanded by default in its tab", async ({ page }) => {
    await page.goto("/#/configure");

    await page.getByRole("tab", { name: /App parameters/i }).click();

    // Advanced is now auto-expanded when opened (since it's in its own tab
    // and no longer competes for vertical space with other sections).
    // We should see at least one categorized group header.
    const panel = page.getByRole("tabpanel", { name: /App parameters/i });
    await expect(panel.getByText("Pi-hole", { exact: true })).toBeVisible();
  });
});
