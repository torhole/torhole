import { expect, test } from "@playwright/test";

for (const view of [
  { page: "privacy", section: "internal", title: "Tor circuits", next: "DNS leak test", nextId: "leak-test", count: 3 },
  { page: "configure", section: "topology", title: "Topology", next: "Identity & access", nextId: "identity", count: 5 },
  { page: "operate", section: "validation", title: "Stack validation", next: "Containers", nextId: "containers", count: 4 },
]) {
  test(`${view.page} uses compact section navigation and preserves deep links`, async ({ page }) => {
    await page.route("**/api/config", route => route.fulfill({ json: { config: { TORHOLE_EDITION: "advanced", TORHOLE_TOPOLOGY: "vlan" } } }));
    await page.route("**/api/system/snapshot", route => route.fulfill({ status: 503, json: {} }));
    await page.goto(`/?mode=advanced#/${view.page}?section=${view.section}`);
    const tabs = page.getByRole("tablist").getByRole("tab");
    await expect(tabs).toHaveCount(view.count);
    await expect(page.getByRole("tab", { name: view.title, exact: true })).toHaveAttribute("aria-selected", "true");
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      const boxes = await Promise.all((await tabs.all()).map(tab => tab.boundingBox()));
      expect(boxes.every(box => box && box.height <= 48 && Math.abs(box.y - boxes[0]!.y) < 2)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`${view.page}-${width}.png`), fullPage: true });
    }
    await page.getByRole("tab", { name: view.next, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`section=${view.nextId}$`));
    await expect(page.getByRole("tabpanel")).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole("tab", { name: view.next, exact: true })).toHaveAttribute("aria-selected", "true");
  });
}

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`Privacy selection reveals its content on a short screen (${reducedMotion})`, async ({ page }) => {
    const { snapshot } = await import("./fixtures/snapshot");
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.emulateMedia({ reducedMotion });
    await page.route("**/api/**", route => route.fulfill({ json: { config: {}, channels: [], backups: [], planes: [], status: {} } }));
    await page.route("**/api/system/snapshot", route => route.fulfill({ json: snapshot }));
    await page.goto("/?mode=advanced#/privacy");
    await expect(page.getByRole("tab", { name: "DNS leak test", exact: true })).toBeVisible();
    for (const title of ["Live query feed", "Tor circuits", "DNS leak test"]) {
      const tab = page.getByRole("tab", { name: title, exact: true });
      // Reproduce selecting navigation near the bottom edge of a short display.
      await tab.evaluate(element => element.scrollIntoView({ block: "end" }));
      await tab.click();
      const panel = page.getByRole("tabpanel", { name: title, exact: true });
      await expect(panel).toBeVisible();
      await expect.poll(async () => (await panel.boundingBox())!.y).toBeLessThan(400);
      await expect(tab).toHaveAttribute("aria-controls", await panel.getAttribute("id") ?? "missing");
    }
    await page.screenshot({ path: test.info().outputPath(`privacy-short-${reducedMotion}.png`), fullPage: false });
  });
}


test("Privacy sidebar deep links reveal loaded content without jumping on refresh", async ({ page }) => {
  const { snapshot } = await import("./fixtures/snapshot");
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.route("**/api/**", route => route.fulfill({ json: { config: {} } }));
  await page.route("**/api/system/snapshot", async route => {
    await new Promise(resolve => setTimeout(resolve, 150));
    await route.fulfill({ json: snapshot });
  });
  await page.goto("/?mode=advanced#/privacy?section=internal");
  await expect(page.getByRole("tabpanel")).toContainText("Tor's current circuit table");
  await expect.poll(async () => (await page.getByRole("tabpanel").boundingBox())!.y).toBeLessThan(400);
  for (const label of ["DNS leak test", "Live queries", "Tor circuits", "Tor circuits"]) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole("link", { name: label, exact: true }).click();
    await expect.poll(async () => (await page.getByRole("tabpanel").boundingBox())!.y).toBeLessThan(400);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  const refresh = page.waitForResponse("**/api/system/snapshot");
  await page.clock.runFor(5000);
  await refresh;
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});


for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`Privacy returns to the top without changing the selected section (${reducedMotion})`, async ({ page }) => {
    const { snapshot } = await import("./fixtures/snapshot");
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.emulateMedia({ reducedMotion });
    await page.route("**/api/**", route => route.fulfill({ json: { config: {} } }));
    await page.route("**/api/system/snapshot", route => route.fulfill({ json: snapshot }));
    await page.goto("/?mode=advanced#/privacy");
    const top = page.getByRole("button", { name: "Back to top", exact: true });
    await expect(top).not.toBeVisible();
    await page.getByRole("link", { name: "Live queries", exact: true }).click();
    await expect(top).toBeVisible();
    await expect(top).toBeInViewport();
    await top.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(top).not.toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(page.getByRole("tab", { name: "Live query feed", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/section=query-feed$/);
  });
}


test("Privacy navigation is directly below the page header", async ({ page }) => {
  const { snapshot } = await import("./fixtures/snapshot");
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.route("**/api/**", route => route.fulfill({ json: { config: {} } }));
  await page.route("**/api/system/snapshot", route => route.fulfill({ json: snapshot }));
  await page.goto("/?mode=advanced#/privacy");
  const tabs = page.getByRole("tablist");
  await expect(tabs).toBeInViewport();
  const nav = (await tabs.boundingBox())!;
  const header = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
  const hero = (await page.getByText("Every DNS query exits via Tor", { exact: true }).boundingBox())!;
  expect(nav.y).toBeGreaterThan(header.y + header.height);
  expect(nav.y + nav.height).toBeLessThan(hero.y);
  expect(nav.y + nav.height).toBeLessThan(240);
});
