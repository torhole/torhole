import { expect, test } from "@playwright/test";
import { snapshot } from "./fixtures/snapshot";

test("a response arriving after its deadline cannot replace recovered measurements", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const fetch = window.fetch;
    const transport = { hold: false, pending: [] as ((response: Response) => void)[] };
    Object.assign(window, { snapshotTransport: transport });
    window.fetch = (...args) => {
      if (String(args[0]) === "/api/system/snapshot" && transport.hold) {
        // Model a response/body reader that completes despite cancellation.
        return new Promise<Response>(resolve => transport.pending.push(resolve));
      }
      return fetch(...args);
    };
  });
  await page.route("**/api/**", route => route.fulfill({ json: { config: {} } }));
  await page.route("**/api/system/snapshot", route => route.fulfill({ json: snapshot }));
  await page.goto("/?mode=advanced#/privacy/internal");
  await expect(page.getByText("Updated just now", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).snapshotTransport.hold = true);
  await page.clock.runFor(16000);
  await expect(page.getByText("Circuit status unavailable", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).snapshotTransport.hold = false);
  await page.clock.runFor(5000);
  await expect(page.getByText("Tor's current circuit table", { exact: false })).toBeVisible();
  const stale = structuredClone(snapshot);
  Object.assign(stale.tor.circuits, { available: false, reason: "Old delayed measurement" });
  await page.evaluate(data => {
    for (const resolve of (window as any).snapshotTransport.pending) {
      resolve(new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } }));
    }
  }, stale);
  await page.clock.runFor(1000);
  await expect(page.getByText("Old delayed measurement", { exact: false })).not.toBeVisible();
  await expect(page.getByText("Tor's current circuit table", { exact: false })).toBeVisible();
});

test("hung snapshot requests age, become unavailable, and recover", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-13T10:00:00Z") });
  let hanging = false;
  await page.route("**/api/**", route => route.fulfill({ json: { config: {} } }));
  await page.route("**/api/system/snapshot", route => {
    if (!hanging) return route.fulfill({ json: snapshot });
  });
  await page.goto("/?mode=advanced#/privacy/internal");
  await expect(page.getByText("Updated just now", { exact: true })).toBeVisible();
  hanging = true;
  await page.clock.runFor(7000);
  await expect(page.getByText("Updated 7s ago", { exact: true })).toBeVisible();
  await page.clock.runFor(9000);
  await expect(page.getByText("Updates unavailable · last updated 16s ago", { exact: true })).toBeVisible();
  await expect(page.getByText("Circuit status unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("Tor's current circuit table", { exact: false })).not.toBeVisible();
  hanging = false;
  await page.clock.runFor(5000);
  await expect(page.locator(".th-dashboard-updated")).toHaveText(/^Updated (just now|\ds ago)$/);
  await expect(page.getByText("Circuit status unavailable", { exact: true })).not.toBeVisible();
});

test("a slow snapshot never overlaps the next poll for the same consumer", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const fetch = window.fetch;
    let count = 0;
    Object.assign(window, { snapshotRequestCount: () => count });
    window.fetch = (...args) => {
      if (String(args[0]) === "/api/system/snapshot") count++;
      return fetch(...args);
    };
  });
  let hanging = false;
  let pendingCount = 0;
  await page.route("**/api/**", route => route.fulfill({ json: { config: {} } }));
  await page.route("**/api/system/snapshot", route => {
    if (hanging) { pendingCount++; return; }
    return route.fulfill({ json: snapshot });
  });
  await page.goto("/?mode=advanced#/privacy/internal");
  await expect(page.getByText("Updated just now", { exact: true })).toBeVisible();
  hanging = true;
  await page.clock.runFor(5000);
  await expect.poll(() => pendingCount).toBeGreaterThan(0);
  const count = () => page.evaluate(() =>
    (window as unknown as { snapshotRequestCount: () => number }).snapshotRequestCount());
  const firstBatch = await count();
  await page.clock.runFor(5000);
  // The banner and page each have a poller; neither may start a second
  // request while its previous measurement is still pending.
  expect(await count()).toBe(firstBatch);
});
