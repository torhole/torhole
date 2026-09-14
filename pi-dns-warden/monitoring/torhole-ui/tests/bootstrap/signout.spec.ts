import { expect, test } from "@playwright/test";
import { snapshot } from "./fixtures/snapshot";

for (const instance of ["01", "02"]) {
  test(`HTTPS instance ${instance} signs out through its configured route and stays at login`, async ({ page }) => {
    const origin = `https://torh${instance}.example.test`;
    const authOrigin = `https://auth${instance}.example.test`;
    const logoutRequests: string[] = [];
    // Serve the real app under an HTTPS instance origin while keeping all
    // resources and API fixtures local to this test.
    await page.route(`${origin}/**`, async route => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: `http://127.0.0.1:4174${url.pathname}${url.search}` });
      await route.fulfill({ response });
    });
    await page.route("**/api/**", route => route.fulfill({ json: { config: {} } }));
    await page.route("**/api/system/snapshot", route => route.fulfill({ json: snapshot }));
    await page.route("**/logout*", async route => {
      const url = route.request().url();
      logoutRequests.push(url);
      if (url === `${origin}/logout`) {
        // The proxy owns the configured auth hostname. The SPA must not
        // derive it from the numbered application hostname or supply rd.
        // Start a document navigation so Playwright can intercept the auth
        // fixture too; redirected network requests are not routed again.
        await route.fulfill({
          contentType: "text/html",
          body: `<script>location.replace(${JSON.stringify(`${authOrigin}/logout`)})</script>`,
        });
      } else {
        await route.fulfill({ contentType: "text/html", body: "<h1>Sign in</h1>" });
      }
    });
    await page.goto(`${origin}/#/`);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${authOrigin}/logout`);
    expect(logoutRequests).toEqual([`${origin}/logout`, `${authOrigin}/logout`]);
  });
}
