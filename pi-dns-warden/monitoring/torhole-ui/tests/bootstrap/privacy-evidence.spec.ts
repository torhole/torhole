import { expect, test } from "@playwright/test";
import { snapshot } from "./fixtures/snapshot";

for (const intact of [true, false]) {
  test(`Privacy summary scopes its evidence when privacy_intact is ${intact}`, async ({ page }) => {
    const data = structuredClone(snapshot);
    data.torhole.privacy_intact = intact;
    await page.route("**/api/system/snapshot", route => route.fulfill({ json: data }));
    await page.goto("/?mode=advanced#/privacy/leak-test");
    const summary = page.locator(".th-privacy-summary");
    await expect(summary).toContainText(intact ? "DNS path checks passed" : "DNS path not verified");
    await expect(summary).not.toContainText("Every DNS query exits via Tor");
  });
}

for (const isTor of [true, false]) {
  test(`Tor probe ${isTor ? "success" : "failure"} does not claim a DNS path result`, async ({ page }) => {
    const data = {
      ...snapshot,
      leak_test: {
        ...snapshot.leak_test,
        last_result: {
          pass: isTor, is_tor: isTor, ip: "192.0.2.1", target: "check.torproject.org",
          ran_at: new Date().toISOString(), duration_ms: 120, error: null,
          verification_status: isTor ? "confirmed_tor" : "confirmed_not_tor",
        },
      },
    };
    await page.route("**/api/system/snapshot", route => route.fulfill({ json: data }));
    await page.goto("/?mode=advanced#/privacy/leak-test");
    const panel = page.getByRole("region", { name: "DNS leak test", exact: true });
    await expect(panel).toContainText(isTor ? "PASS · Tor exit verified" : "FAIL · probe exit is not Tor");
    await expect(panel).not.toContainText("DNS exits via Tor");
    await expect(panel).not.toContainText("privacy not intact");
  });
}
