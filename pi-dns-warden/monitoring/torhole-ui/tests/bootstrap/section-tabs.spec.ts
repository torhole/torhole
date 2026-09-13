import { expect, test } from "@playwright/test";

for (const view of [
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
