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
  test("rotate identity on Trusted plane reaches success state", async ({ page }) => {
    await page.goto("/v2/#/privacy");

    // Wait for the per-plane panel to render.
    await expect(page.getByText("Per-plane circuit isolation")).toBeVisible();

    // The rotate buttons render in order: Trusted, IoT. Click the first.
    const rotateButtons = page.getByRole("button", { name: /rotate identity/i });
    await expect(rotateButtons).toHaveCount(3);
    await rotateButtons.first().click();

    // The button should show a "rotating…" state, then "rotated", then return
    // to "rotate identity". We assert the success state appears within ~5s.
    await expect(page.getByRole("button", { name: /^rotated$/i })).toBeVisible({
      timeout: 5_000,
    });
  });

  test("run leak test shows a PASS result", async ({ page }) => {
    await page.goto("/v2/#/privacy");

    await expect(page.getByText("DNS leak test", { exact: true })).toBeVisible();

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
