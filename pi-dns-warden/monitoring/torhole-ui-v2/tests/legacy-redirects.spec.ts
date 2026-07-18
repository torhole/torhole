/*
 * Regression tests for the legacy URL redirects.
 *
 * After Phase C removed the v1 UI, the Caddyfile redirects any stragglers
 * (bookmarks, saved links, monitoring checks) to the closest v2 route. This
 * spec locks that contract so a future Caddyfile edit can't silently break
 * redirect chains users depend on.
 *
 * We use page.goto() and then inspect the final URL via page.url() rather
 * than intercepting the network response, because the root "/" → "/v2/"
 * redirect lands the browser on a hash route (`/v2/#/`) which Playwright
 * resolves through the full browser navigation.
 */

import { test, expect } from "@playwright/test";

test.describe("Legacy URL redirects", () => {
  test("root / redirects into /v2/", async ({ page }) => {
    await page.goto("/");
    // After the 308, the SPA loads and defaults to the Glance screen.
    // HashRouter means the URL ends in /v2/ or /v2/#/ depending on the build.
    await expect(page).toHaveURL(/\/v2\/?(#\/?)?$/);
    // Confirm the Glance hero renders so we know the SPA actually loaded.
    await expect(
      page.getByRole("heading", { name: "Is the privacy guarantee intact?" }),
    ).toBeVisible();
  });

  test("/operate.html redirects into Operate", async ({ page }) => {
    await page.goto("/operate.html");
    await expect(page).toHaveURL(/\/v2\/#\/operate$/);
    await expect(
      page.getByRole("heading", { name: "What do you need to change?" }),
    ).toBeVisible();
  });

  test("/resolver.html redirects into Privacy", async ({ page }) => {
    await page.goto("/resolver.html");
    await expect(page).toHaveURL(/\/v2\/#\/privacy$/);
    await expect(
      page.getByRole("heading", { name: "What does Torhole prove?" }),
    ).toBeVisible();
  });

  test("/access.html redirects into Configure", async ({ page }) => {
    await page.goto("/access.html");
    await expect(page).toHaveURL(/\/v2\/#\/configure$/);
    await expect(
      page.getByRole("heading", { name: "What can you tune?" }),
    ).toBeVisible();
  });

  test("legacy hash-route stub /dns-planes redirects into Operate", async ({ page }) => {
    await page.goto("/dns-planes");
    await expect(page).toHaveURL(/\/v2\/#\/operate$/);
  });
});
