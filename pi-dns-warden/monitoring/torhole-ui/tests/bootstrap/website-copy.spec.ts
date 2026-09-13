import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

for (const clipboard of ["rejected", "fallback-failed", "success"]) {
  test(`website copy command reports ${clipboard} honestly`, async ({ page }) => {
    const html = readFileSync(new URL("../../../../../website/index.html", import.meta.url), "utf8");
    await page.route("**/*", route => route.request().url() === "http://127.0.0.1:4174/website-test" ? route.fulfill({ contentType: "text/html", body: html }) : route.abort());
    await page.addInitScript(mode => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: mode === "fallback-failed" ? undefined : { writeText: () => mode === "success" ? Promise.resolve() : Promise.reject(new Error("Permission denied")) } });
      document.execCommand = () => false;
    }, clipboard);
    await page.goto("/website-test");
    await page.locator("#copyBtn").click();
    await expect(page.locator("#copyBtn")).toHaveText(clipboard === "success" ? "Copied" : "Copy failed — select command");
  });
}
