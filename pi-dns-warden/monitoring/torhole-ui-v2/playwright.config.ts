/*
 * Playwright config for torhole-ui-v2.
 *
 * Targets the live Pi at https://torhole.lab.torhole.com (configurable via
 * TORHOLE_BASE_URL in tests/.env.test). Uses a global setup that
 * authenticates against Authelia once and stores the session cookie so
 * every test reuses it — much faster than logging in per test, and keeps
 * Authelia's session count under control.
 *
 * Self-signed cert from Caddy's "tls internal" CA is trusted via
 * ignoreHTTPSErrors. In production CI we'd install the actual root cert
 * instead.
 */

import { defineConfig, devices } from "@playwright/test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, "tests", ".env.test") });

const BASE_URL = process.env.TORHOLE_BASE_URL || "https://torhole.lab.torhole.com";
const AUTH_STATE_FILE = path.join(__dirname, "tests", ".auth", "state.json");

export default defineConfig({
  testDir: "./tests",
  // Skip the global setup from being picked up as a test.
  testIgnore: ["**/global-setup.ts", "**/.auth/**"],
  fullyParallel: false, // actions mutate shared state (Tor circuits), serialize
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 1,
  reporter: [["list"]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  globalSetup: path.join(__dirname, "tests", "global-setup.ts"),
  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: true,
    storageState: AUTH_STATE_FILE,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
