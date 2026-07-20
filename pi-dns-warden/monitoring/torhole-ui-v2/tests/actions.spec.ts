/*
 * Action tests — exercise the interactive buttons and verify success states.
 *
 * These hit the real backend and cause real side effects (Tor circuits get
 * closed, a real HTTPS request goes out through Tor to check.torproject.org).
 * They run serially (workers: 1, fullyParallel: false) to avoid interfering
 * with each other's state.
 */

import { test, expect } from "@playwright/test";

test.describe("Privacy actions", () => {
  test("renew global Tor identity reaches success state", async ({ page }) => {
    await page.goto("/v2/#/privacy");

    await expect(page.getByText("DNS plane isolation")).toBeVisible();

    const renewButton = page.getByRole("button", { name: /renew Tor identity/i });
    await expect(renewButton).toHaveCount(1);
    await renewButton.click();

    await expect(page.getByRole("button", { name: /identity renewed/i })).toBeVisible({
      timeout: 5_000,
    });
  });

  test("run leak test shows a PASS result", async ({ page }) => {
    await page.goto("/v2/#/privacy");

    await expect(page.getByRole("tab", { name: /DNS leak test/i })).toBeVisible();

    // Click the run button. The backend does a real SOCKS5 → TLS → GET
    // through Tor to check.torproject.org and can take 5-15 seconds.
    await page.getByRole("button", { name: /run leak test now/i }).click();

    // First, the button reaches the "running…" state.
    await expect(page.getByRole("button", { name: /^running…$/i })).toBeVisible({
      timeout: 3_000,
    });

    // Then the result block should render within 20 seconds. Check the PASS
    // heading and the exit_ip mono row. "exit ip" now appears twice on the
    // page (the hero tile added in Phase D, and the leak test result block),
    // so we use .last() to match the one inside the just-rendered result.
    await expect(page.getByText(/PASS\s*·\s*DNS exits via Tor/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("exit ip", { exact: true }).last()).toBeVisible();
  });
});
