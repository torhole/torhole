import { expect, test } from "@playwright/test";
import { snapshot } from "./fixtures/snapshot";

for (const theme of ["dark", "light"]) {
  for (const width of [1024, 1440]) {
    test(`Dashboard pages share Glance typography and fit ${width}px (${theme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 768 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript(value => localStorage.setItem("torhole.theme", value), theme);
      await page.route("**/api/**", route => route.fulfill({ json: { config: {}, channels: [], backups: [], planes: [], status: {} } }));
      await page.route("**/api/system/snapshot", route => route.fulfill({ json: snapshot }));
      await page.route("**/api/system/validation", route => route.fulfill({ json: { checks: [], progress: [], running: false, last_result: null } }));
      await page.route("**/api/version", route => route.fulfill({ json: { product: "Torhole", version: "0.2.3", revision: "test-fixture", edition: "advanced", topology: "vlan" } }));
      let reference: string[] | undefined;
      for (const screen of ["", "privacy", "operate", "configure", "setup", "about"]) {
        await page.goto(`/?mode=advanced#/${screen}`);
        const heading = page.getByRole("heading", { level: 1 });
        await expect(heading).toBeVisible();
        const typography = await heading.evaluate(element => {
          const style = getComputedStyle(element);
          return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.letterSpacing];
        });
        if (!reference) reference = typography;
        else expect(typography).toEqual(reference);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.screenshot({ path: test.info().outputPath(`${screen || "glance"}-${theme}-${width}.png`), fullPage: false });
      }
    });
  }
}


test("Glance retains the warning border for services needing attention", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("torhole.theme", "dark"));
  await page.route("**/api/system/snapshot", route => route.fulfill({ json: {
    ...snapshot, containers: [{ id: "tor", name: "tor", label: "Tor", status: "degraded", core: true }],
  } }));
  await page.goto("/?mode=advanced#/");
  await expect(page.getByRole("region", { name: "Services needing attention" })).toHaveCSS("border-top-color", "rgb(245, 158, 11)");
});
