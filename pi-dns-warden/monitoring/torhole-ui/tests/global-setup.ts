/*
 * Global Playwright setup — log into Authelia once and save the session
 * state so every test reuses the same cookie. Runs once before the suite.
 *
 * Credentials come from tests/.env.test (TORHOLE_TEST_USER,
 * TORHOLE_TEST_PASSWORD). The file is gitignored. If it's missing or
 * credentials are wrong, the setup prints a helpful error and exits.
 *
 * The login flow:
 *   1. Visit the base URL (auth-gated)
 *   2. Get redirected to https://auth.<domain>/?rd=...
 *   3. Fill the Authelia form and submit
 *   4. Wait for redirect back to the baseURL
 *   5. Save storage state (cookies) to tests/.auth/state.json
 */

import { chromium, type FullConfig } from "@playwright/test";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, ".env.test") });

const BASE_URL = process.env.TORHOLE_BASE_URL || "https://torhole.lab.torhole.com";
const USER = process.env.TORHOLE_TEST_USER;
const PASS = process.env.TORHOLE_TEST_PASSWORD;
const AUTH_STATE_FILE = path.join(__dirname, ".auth", "state.json");

export default async function globalSetup(_config: FullConfig) {
  if (!USER || !PASS) {
    console.error(
      "\n[playwright global-setup] ERROR: TORHOLE_TEST_USER / TORHOLE_TEST_PASSWORD not set.\n" +
        "Create tests/.env.test with:\n" +
        "  TORHOLE_TEST_USER=<admin username>\n" +
        "  TORHOLE_TEST_PASSWORD=<admin password>\n" +
        "  TORHOLE_BASE_URL=https://torhole.lab.torhole.com  # optional\n",
    );
    throw new Error("missing test credentials");
  }

  // Reuse a cached auth state only if it's fresh AND the cookie still works.
  // A stale cached state is worse than no state because it causes every test
  // to fail with confusing "element not found" errors (the app never loads
  // because Caddy redirects the request to Authelia first).
  try {
    const stat = fs.statSync(AUTH_STATE_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 12 * 60 * 60 * 1000) {
      // Verify the cookie by hitting an authenticated endpoint and checking
      // we DON'T get redirected to the Authelia portal.
      const probe = await chromium.launch();
      try {
        const probeCtx = await probe.newContext({
          ignoreHTTPSErrors: true,
          storageState: AUTH_STATE_FILE,
        });
        const probePage = await probeCtx.newPage();
        const resp = await probePage.goto(`${BASE_URL}/api/system/snapshot`, {
          waitUntil: "domcontentloaded",
          timeout: 10_000,
        });
        if (resp && resp.status() === 200 && resp.url().includes(BASE_URL)) {
          console.log(
            `[playwright global-setup] reusing cached auth state (${Math.round(ageMs / 60_000)}m old, validated)`,
          );
          await probe.close();
          return;
        }
        console.log(
          "[playwright global-setup] cached auth state is stale, re-logging in…",
        );
      } catch {
        console.log(
          "[playwright global-setup] cached auth state validation failed, re-logging in…",
        );
      } finally {
        await probe.close();
      }
    }
  } catch {
    // File missing — proceed to login.
  }

  fs.mkdirSync(path.dirname(AUTH_STATE_FILE), { recursive: true });

  console.log("[playwright global-setup] logging into Authelia…");
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    // Kick off the protected request; Authelia redirects us to the portal.
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });

    // Authelia uses Material-UI; inputs have IDs like "username-textfield"
    // and "password-textfield" but no `name` attribute. Use the IDs.
    const usernameInput = page.locator("#username-textfield");
    const passwordInput = page.locator("#password-textfield");

    await usernameInput.waitFor({ state: "visible", timeout: 20_000 });
    await usernameInput.fill(USER!);
    await passwordInput.fill(PASS!);

    // The submit button is labelled "Sign in" in our rendered portal.json.
    await Promise.all([
      page.waitForURL((url) => !url.hostname.startsWith("auth."), {
        timeout: 30_000,
      }),
      page.getByRole("button", { name: /sign in/i }).click(),
    ]);

    await context.storageState({ path: AUTH_STATE_FILE });
    console.log(`[playwright global-setup] saved auth state to ${AUTH_STATE_FILE}`);
  } finally {
    await browser.close();
  }
}
