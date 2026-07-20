/*
 * Installed-system guard for the Setup route.
 *
 * First-run option coverage belongs to tests/bootstrap/setup-options.spec.ts,
 * which runs against the unauthenticated bootstrap application. Once Torhole
 * is installed, commissioning must not reopen from a stale bookmark.
 */

import { expect, test } from "@playwright/test";

test("an installed setup bookmark redirects to Configure", async ({ page }) => {
  await page.goto("/v2/#/setup");

  await expect(page.getByRole("heading", { name: "What can you tune?" })).toBeVisible();
  await expect(page).toHaveURL(/#\/configure$/);
});
