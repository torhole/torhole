/*
 * Smoke tests for the Privacy screen.
 *
 * Verifies the three panels are rendering with live data from the backend:
 *   1. Privacy hero + proof tiles
 *   2. DNS-plane isolation cards and the global identity control
 *   3. Leak test panel
 *   4. Live query feed (SSE connected + events arriving)
 */

import { test, expect } from "@playwright/test";

test.describe("Privacy screen", () => {
  test("loads and shows the privacy hero", async ({ page }) => {
    await page.goto("/#/privacy");

    await expect(
      page.getByRole("heading", { name: "What does Torhole prove?" }),
    ).toBeVisible();
    await expect(
      page.getByText("Every DNS query exits via Tor", { exact: true }),
    ).toBeVisible();

    // Three inline proof tiles in the hero: tor uptime, exit ip, isolation.
    // Each label also appears elsewhere on the page (the runtime strip has
    // its own rows, the leak test panel has its own "exit ip" row, etc.),
    // so we match the first occurrence — the hero is above the fold and
    // always renders first in the DOM.
    for (const label of ["tor uptime", "exit ip", "isolation"]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
  });

  test("shows DNS-plane isolation and one truthful global renewal control", async ({ page }) => {
    const snapshotResponse = await page.request.get("/api/system/snapshot");
    expect(snapshotResponse.ok()).toBeTruthy();
    const snapshot = await snapshotResponse.json();
    await page.goto("/#/privacy");

    // Wait for the page to hydrate by asserting the section title exists.
    // Section titles are <div>s, not <h*> elements, and contain the meta
    // text concatenated after the title — so no exact match.
    await expect(page.getByText("DNS plane isolation")).toBeVisible();

    // Every configured plane appears; Single-LAN and VLAN installations
    // deliberately expose different plane sets.
    for (const plane of snapshot.dns.planes as Array<{ label: string }>) {
      await expect(page.getByText(plane.label, { exact: true }).first()).toBeVisible();
    }

    await expect(page.getByRole("button", { name: /renew Tor identity/i })).toHaveCount(1);
  });

  test("shows the leak test panel with a run button", async ({ page }) => {
    await page.goto("/#/privacy");

    await expect(page.getByRole("tab", { name: /DNS leak test/i })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /run leak test now/i }),
    ).toBeVisible();
  });

  test("shows the live query feed streaming events", async ({ page }) => {
    await page.goto("/#/privacy");

    // Live query feed is now behind a tab — click the tab button first.
    // The tab is a role=tab button with "Live query feed" in its label.
    await page.getByRole("tab", { name: /live query feed/i }).click();

    // Pause and clear buttons are inside the feed panel's status bar now.
    await expect(page.getByRole("button", { name: /pause|resume/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /clear/i })).toBeVisible();

    // SSE status should become "live" within ~5s.
    await expect(page.getByText(/^\s*live\s*$/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("has three section tabs for the lower panels", async ({ page }) => {
    await page.goto("/#/privacy");

    // Three tab buttons with role=tab
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(3);

    // Their labels (substring match — the tab button also contains the meta)
    await expect(page.getByRole("tab", { name: /DNS leak test/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /live query feed/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Tor circuits/i })).toBeVisible();
  });

  test("shows live Tor runtime strip above the fold", async ({ page }) => {
    await page.goto("/#/privacy");

    // The Tor runtime strip now lives directly under the Privacy hero — no
    // tab click, no scroll — because it's the privacy guarantee made live
    // and needs to be the first thing an operator sees. Fields are sourced
    // from /api/system/snapshot tor.runtime_info (populated when the
    // backup-manager can reach tor:9051). Scope to the data-testid so labels
    // like "bootstrap" don't collide with the hero's static proof tile above.
    const strip = page.getByTestId("tor-runtime-strip");
    await expect(strip).toBeVisible();
    await expect(strip.getByText(/Tor control port · live/i)).toBeVisible();
    await expect(strip.getByText("bootstrap", { exact: true })).toBeVisible();
    await expect(strip.getByText("liveness", { exact: true })).toBeVisible();
    await expect(strip.getByText("circuits", { exact: true })).toBeVisible();
    await expect(strip.getByText("entry guards", { exact: true })).toBeVisible();
  });

  test("live query feed closes its SSE connection when the tab is hidden", async ({ page }) => {
    // Patch EventSource before navigation so every instance gets tracked.
    await page.addInitScript(() => {
      // @ts-ignore test-only global
      window.__esLog = { opened: 0, closed: 0, active: 0 };
      const Real = window.EventSource;
      // @ts-ignore
      window.EventSource = function (...args: unknown[]) {
        // @ts-ignore
        const es = new Real(...args);
        // @ts-ignore
        window.__esLog.opened += 1;
        // @ts-ignore
        window.__esLog.active += 1;
        const origClose = es.close.bind(es);
        es.close = () => {
          // @ts-ignore
          window.__esLog.closed += 1;
          // @ts-ignore
          window.__esLog.active -= 1;
          return origClose();
        };
        return es;
      };
      // @ts-ignore
      Object.setPrototypeOf(window.EventSource, Real);
      // @ts-ignore
      window.EventSource.prototype = Real.prototype;
    });

    await page.goto("/#/privacy");
    // Click the "Live query feed" tab so the panel activates.
    await page.getByRole("tab", { name: /live query feed/i }).click();
    await page.waitForFunction(
      // @ts-ignore
      () => window.__esLog && window.__esLog.active >= 1,
      { timeout: 5000 },
    );
    // Switch to another tab — the SSE connection should close.
    await page.getByRole("tab", { name: /dns leak test/i }).click();
    await page.waitForFunction(
      // @ts-ignore
      () => window.__esLog && window.__esLog.active === 0,
      { timeout: 5000 },
    );
    const log = await page.evaluate(() => (window as any).__esLog);
    expect(log.closed).toBeGreaterThanOrEqual(1);

    // Reactivate the feed tab and assert no duplicate feed rows accumulate.
    // Regression guard for the f41b83a follow-up: when the tab becomes
    // active again, the server re-sends its initial dump on the new SSE
    // connection. The preserved client-side ring buffer must dedup it,
    // otherwise we'd see visible duplicate rows and React would log a
    // duplicate-key warning on QueryRow.
    await page.getByRole("tab", { name: /live query feed/i }).click();
    await page.waitForFunction(
      // @ts-ignore
      () => window.__esLog && window.__esLog.active >= 1,
      { timeout: 5000 },
    );
    // Give the server a moment to send its re-dump.
    await page.waitForTimeout(1500);
    // Count visible feed rows via data-event-key and confirm no duplicates.
    const dupes = await page.evaluate(() => {
      const nodes = document.querySelectorAll('[data-event-key]');
      const seen = new Set<string>();
      const duplicates: string[] = [];
      nodes.forEach((node) => {
        const key = node.getAttribute('data-event-key');
        if (!key) return;
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
      });
      return duplicates;
    });
    expect(dupes).toEqual([]);
  });

  test("/api/metrics/tor returns Prometheus text format", async ({ request }) => {
    const res = await request.get("/api/metrics/tor");
    expect(res.ok()).toBe(true);
    const ct = res.headers()["content-type"] ?? "";
    expect(ct).toMatch(/text\/plain/);

    const body = await res.text();
    // Required core metrics emitted by render_tor_metrics_prom in the
    // backup-manager. If the endpoint regresses these are the canaries.
    expect(body).toContain("tor_control_port_up");
    expect(body).toContain("tor_bootstrap_percent");
    expect(body).toContain("tor_network_liveness");
    expect(body).toContain("tor_circuits{state=");
    expect(body).toContain("tor_circuits_by_plane{plane=");
  });
});
