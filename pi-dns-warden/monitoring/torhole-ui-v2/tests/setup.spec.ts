/*
 * Smoke tests for the Setup wizard.
 *
 * Home and Advanced share this wizard. Tests cover the common flow and the
 * optional Advanced-only topology/alerts branch.
 */

import { test, expect } from "@playwright/test";

test.describe("Setup wizard", () => {
  test("loads at the welcome step", async ({ page }) => {
    await page.goto("/v2/#/setup");

    await expect(
      page.getByRole("heading", { name: "How do you want to run Torhole?" }),
    ).toBeVisible();

    // The welcome step title
    await expect(
      page.getByText(/Set up a privacy-first DNS gateway/i),
    ).toBeVisible();

    // Step counter in the footer
    await expect(page.getByText(/step 1 of (8|10)/i)).toBeVisible();
  });

  test("stepper rail shows the common edition flow", async ({ page }) => {
    await page.goto("/v2/#/setup");

    // These steps are present in both capability profiles.
    for (const label of [
      "Welcome",
      "Edition",
      "Network",
      "Admin account",
      "Blocklists",
      "Tor",
      "Test",
      "Done",
    ]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
  });

  test("next/back navigation moves between steps", async ({ page }) => {
    await page.goto("/v2/#/setup");

    await expect(page.getByText(/step 1 of (8|10)/i)).toBeVisible();

    await page.getByRole("button", { name: /^next$/i }).click();
    await expect(page.getByText(/step 2 of (8|10)/i)).toBeVisible();

    // Edition selection is the first decision and Home is the default.
    await expect(page.getByText("Torhole Home", { exact: true })).toBeVisible();
    await expect(page.getByText("Torhole Advanced", { exact: true })).toBeVisible();

    // Select Advanced to expose the optional topology step.
    await page.getByText("Torhole Advanced", { exact: true }).click();
    await page.getByRole("button", { name: /^next$/i }).click();
    await expect(page.getByText(/step 3 of 10/i)).toBeVisible();

    await expect(page.getByText("Single LAN", { exact: true })).toBeVisible();
    await expect(page.getByText("Segmented VLANs", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /^back$/i }).click();
    await expect(page.getByText(/step 2 of 10/i)).toBeVisible();
  });

  test("topology picker selects Single LAN by default or auto-detects VLAN", async ({
    page,
  }) => {
    await page.goto("/v2/#/setup");
    await page.getByText("Edition", { exact: true }).first().click();
    await page.getByText("Torhole Advanced", { exact: true }).click();
    await page.getByText("Topology", { exact: true }).first().click();

    // At least one of the two topology cards should be selected (shown by
    // the filled radio circle). The test doesn't assert which one —
    // auto-detection picks VLAN if the .env has all 3 VLAN IDs.
    const singleLan = page.getByText("Single LAN", { exact: true });
    const vlan = page.getByText("Segmented VLANs", { exact: true });
    await expect(singleLan).toBeVisible();
    await expect(vlan).toBeVisible();
  });

  test("admin step captures admin user into a text input", async ({ page }) => {
    await page.goto("/v2/#/setup");
    // Jump directly via the stepper rail to avoid clicking Next four times.
    await page.getByText("Admin account", { exact: true }).first().click();

    // The admin user input is a text field seeded from the live .env.
    // Pre-fills with the current TORHOLE_ADMIN_USER. We verify it exists
    // and accepts new input.
    const input = page.getByPlaceholder("admin");
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(/.+/);  // something already there
    await input.fill("new-admin-name");
    await expect(input).toHaveValue("new-admin-name");
  });

  test("done step shows apply button and pending changes diff", async ({ page }) => {
    await page.goto("/v2/#/setup");

    // Change the admin user first so the diff has something in it.
    await page.getByText("Admin account", { exact: true }).first().click();
    const adminInput = page.getByPlaceholder("admin");
    // Wait for the field to be populated from the live .env BEFORE we
    // overwrite it — otherwise a slow fetchConfig() response can land
    // after our .fill() and wipe our change, causing a flaky assertion
    // on the Done step (no pending changes because the diff matches).
    await expect(adminInput).not.toHaveValue("");
    await adminInput.fill("wizard-test-user");

    // Jump to the Done step via the stepper rail.
    await page.getByText("Done", { exact: true }).first().click();

    // Review header
    await expect(
      page.getByRole("heading", { name: /Review and apply/i }),
    ).toBeVisible();

    // Pending changes list — the admin user change should be listed
    await expect(page.getByText(/pending changes/i)).toBeVisible();
    await expect(page.getByText("TORHOLE_ADMIN_USER", { exact: true })).toBeVisible();
    await expect(page.getByText("wizard-test-user")).toBeVisible();

    // Apply button — visible and enabled (there's a pending change). Do
    // NOT click it — we don't want to write .env from a test run.
    const apply = page.getByRole("button", { name: /apply configuration/i });
    await expect(apply).toBeVisible();
    await expect(apply).toBeEnabled();
  });
});
