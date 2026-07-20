/*
 * Regression tests for the legacy URL redirects.
 *
 * The canonical admin URL is the host root. Development-era /v2 bookmarks
 * and older static-page routes remain explicit compatibility redirects.
 * These tests prevent a cleanup from either reintroducing a versioned public
 * URL or silently breaking existing bookmarks.
 */

import { test, expect } from "@playwright/test";

test.describe("Canonical and compatibility URLs", () => {
  test("root / is the canonical Glance URL", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/?(#\/?)?$/);
    await expect(
      page.getByRole("heading", { name: "Is the privacy guarantee intact?" }),
    ).toBeVisible();
  });

  test("old /v2 bookmark redirects to the canonical root", async ({ page }) => {
    await page.goto("/v2/");
    await expect(page).toHaveURL(/\/?$/);
    await expect(
      page.getByRole("heading", { name: "Is the privacy guarantee intact?" }),
    ).toBeVisible();
  });

  test("old /v2 hash bookmark keeps its application route", async ({ page }) => {
    await page.goto("/v2/#/privacy");
    await expect(page).toHaveURL(/\/#\/privacy$/);
    await expect(
      page.getByRole("heading", { name: "What does Torhole prove?" }),
    ).toBeVisible();
  });

  test("/operate.html redirects into Operate", async ({ page }) => {
    await page.goto("/operate.html");
    await expect(page).toHaveURL(/\/#\/operate$/);
    await expect(
      page.getByRole("heading", { name: "What do you need to change?" }),
    ).toBeVisible();
  });

  test("/resolver.html redirects into Privacy", async ({ page }) => {
    await page.goto("/resolver.html");
    await expect(page).toHaveURL(/\/#\/privacy$/);
    await expect(
      page.getByRole("heading", { name: "What does Torhole prove?" }),
    ).toBeVisible();
  });

  test("/access.html redirects into Configure", async ({ page }) => {
    await page.goto("/access.html");
    await expect(page).toHaveURL(/\/#\/configure$/);
    await expect(
      page.getByRole("heading", { name: "What can you tune?" }),
    ).toBeVisible();
  });

  test("legacy hash-route stub /dns-planes redirects into Operate", async ({ page }) => {
    await page.goto("/dns-planes");
    await expect(page).toHaveURL(/\/#\/operate$/);
  });
});
