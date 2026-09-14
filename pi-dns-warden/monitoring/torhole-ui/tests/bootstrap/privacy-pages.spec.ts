import { expect, test } from "@playwright/test";
import { snapshot } from "./fixtures/snapshot";

const views = [
  { id: "leak-test", title: "DNS leak test" },
  { id: "query-feed", title: "Live query feed" },
  { id: "internal", title: "Tor circuits" },
];

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.route("**/api/**", route => route.fulfill({ json: { config: {} } }));
  await page.route("**/api/system/snapshot", route => route.fulfill({ json: snapshot }));
});

for (const view of views) {
  test(`${view.title} is a separate page with its tool immediately below the menu`, async ({ page }) => {
    await page.goto(`/?mode=advanced#/privacy/${view.id}`);
    const menu = page.getByRole("navigation", { name: "Privacy pages" });
    await expect(menu).toBeInViewport();
    await expect(page.getByRole("button", { name: "Collapse Privacy menu", exact: true })).toBeVisible();
    await expect(menu.getByRole("link", { name: view.title, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 2, name: view.title, exact: true })).toBeInViewport();
    for (const other of views.filter(item => item.id !== view.id)) {
      await expect(page.getByRole("region", { name: other.title, exact: true })).toHaveCount(0);
    }
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: test.info().outputPath(`${view.id}.png`) });
    await page.reload();
    await expect(menu.getByRole("link", { name: view.title, exact: true })).toHaveAttribute("aria-current", "page");
  });
}

test("Privacy menu and sidebar navigate pages with browser history and no scroll jump", async ({ page }) => {
  await page.goto("/?mode=advanced#/privacy?section=internal");
  await expect(page).toHaveURL(/#\/privacy\/internal$/);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.getByRole("link", { name: "Live queries", exact: true }).click();
  await expect(page).toHaveURL(/#\/privacy\/query-feed$/);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const menu = page.getByRole("navigation", { name: "Privacy pages" });
  await menu.getByRole("link", { name: "DNS leak test", exact: true }).click();
  await expect(page).toHaveURL(/#\/privacy\/leak-test$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/privacy\/query-feed$/);
  await expect(menu).toBeInViewport();
  await page.goForward();
  await expect(page).toHaveURL(/#\/privacy\/leak-test$/);
});

test("Snapshot refreshes do not reset the Privacy reading position", async ({ page }) => {
  await page.clock.install();
  await page.goto("/?mode=advanced#/privacy/internal");
  await expect(page.getByText("DNS plane isolation")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 100));
  const y = await page.evaluate(() => window.scrollY);
  const response = page.waitForResponse("**/api/system/snapshot");
  await page.clock.runFor(5000);
  await response;
  expect(await page.evaluate(() => window.scrollY)).toBe(y);
});


test("Leaving Live query feed closes its connection and returning opens a new one", async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.EventSource;
    const connections: { closed: boolean }[] = [];
    Object.assign(window, { privacyConnections: connections });
    window.EventSource = class extends Original {
      record = { closed: false };
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        connections.push(this.record);
      }
      close() {
        this.record.closed = true;
        super.close();
      }
    };
  });
  await page.goto("/?mode=advanced#/privacy/query-feed");
  const count = () => page.evaluate(() =>
    (window as unknown as { privacyConnections: { closed: boolean }[] }).privacyConnections.length);
  await expect.poll(count).toBeGreaterThan(0);
  const initialCount = await count();
  const menu = page.getByRole("navigation", { name: "Privacy pages" });
  await menu.getByRole("link", { name: "DNS leak test", exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { privacyConnections: { closed: boolean }[] }).privacyConnections
      .every(connection => connection.closed))).toBe(true);
  await menu.getByRole("link", { name: "Live query feed", exact: true }).click();
  await expect.poll(count).toBeGreaterThan(initialCount);
});
