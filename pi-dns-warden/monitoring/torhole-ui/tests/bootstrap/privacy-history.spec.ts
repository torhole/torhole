import { expect, test } from "@playwright/test";
import { snapshot } from "./fixtures/snapshot";

test("history reports passes among conclusive checks within the recent window", async ({ page }) => {
  const data = {
    ...snapshot,
    leak_test: { ...snapshot.leak_test, history_count: 100, conclusive_count: 10, recent_pass_rate: 0.5 },
  };
  await page.route("**/api/system/snapshot", route => route.fulfill({ json: data }));
  await page.goto("/?mode=advanced#/privacy/leak-test");
  const panel = page.getByRole("region", { name: "DNS leak test", exact: true });
  await expect(panel).toContainText("50% passed among conclusive checks");
  await expect(panel).toContainText("10 conclusive · last 20 runs");
  await expect(panel).not.toContainText("10/100");
});

test("an entirely inconclusive history remains visible without a success rate", async ({ page }) => {
  const data = {
    ...snapshot,
    leak_test: { ...snapshot.leak_test, history_count: 3, conclusive_count: 0, recent_pass_rate: null },
  };
  await page.route("**/api/system/snapshot", route => route.fulfill({ json: data }));
  await page.goto("/?mode=advanced#/privacy/leak-test");
  const panel = page.getByRole("region", { name: "DNS leak test", exact: true });
  await expect(panel).toContainText("No conclusive checks");
  await expect(panel).toContainText("0 conclusive · last 3 runs");
  await expect(panel).not.toContainText("% passed");
});
