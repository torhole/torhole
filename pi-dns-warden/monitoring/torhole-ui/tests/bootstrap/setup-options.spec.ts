import { expect, test, type Page } from "@playwright/test";

const config = {
  TORHOLE_EDITION: "home",
  TORHOLE_TOPOLOGY: "single-lan",
  TORHOLE_WEB_MODE: "https-local",
  TORHOLE_BLOCKLISTS: "stevenblack",
  TORHOLE_ADMIN_USER: "admin",
  TORHOLE_ADMIN_PASSWORD: "",
  TZ: "Europe/Zurich",
  PARENT_IF: "eth0",
  HOST_MGMT_IP: "10.0.0.149",
  REVERSE_PROXY_DOMAIN: "lan.home.arpa",
  TRUSTED_PARENT: "eth0",
  TRUSTED_VLAN_ID: "1",
  TRUSTED_SUBNET_CIDR: "10.0.0.0/24",
  TRUSTED_GATEWAY: "10.0.0.1",
  PIHOLE_TRUSTED_IP: "10.0.0.150",
  IOT_PARENT: "eth0.50",
  IOT_VLAN_ID: "50",
  IOT_SUBNET_CIDR: "10.0.50.0/24",
  IOT_GATEWAY: "10.0.50.1",
  PIHOLE_IOT_IP: "10.0.50.150",
  ALERT_EMAIL_REQUIRE_TLS: "true",
  ALERT_DISCORD_USERNAME: "torhole",
};

async function mockBootstrap(
  page: Page,
  status: Record<string, unknown> = { status: "idle", message: "Ready", logs: [] },
) {
  let submitted: Record<string, unknown> | null = null;
  await page.route("**/api/config", (route) =>
    route.fulfill({ json: { config } }),
  );
  await page.route("**/api/system/snapshot", (route) =>
    route.fulfill({
      json: {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        overall_status: "healthy",
        banner: null,
        planes: [],
        containers: [],
      },
    }),
  );
  await page.route("**/api/bootstrap/status", (route) =>
    route.fulfill({ json: status }),
  );
  await page.route("**/api/bootstrap/install", async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 202,
      json: { status: "error", message: "Stopped by browser test", logs: [] },
    });
  });
  await page.goto("/?mode=bootstrap");
  await expect(page.getByText("Set up a privacy-first DNS gateway", { exact: false })).toBeVisible();
  return () => submitted;
}

async function mockInstalledAdvanced(
  page: Page,
  topology: "single-lan" | "vlan",
  webMode: "http" | "https-local" | "https-custom" = "https-local",
) {
  const fullInstalledConfig = {
    ...config,
    TORHOLE_EDITION: "advanced",
    TORHOLE_TOPOLOGY: topology,
    TORHOLE_WEB_MODE: webMode,
    PIHOLE_IOT_PASSWORD: "***",
    DNSCRYPT_SOCKS_USER_IOT: "iot",
    DNSCRYPT_SOCKS_PASS_IOT: "***",
    TORHOLE_HOST_PIHOLE_IOT: "pihole-iot",
    TORHOLE_ALIAS_PIHOLE_IOT: "pi",
  };
  const vlanOnlyKeys = new Set([
    "TRUSTED_VLAN_ID",
    "IOT_VLAN_ID",
    "IOT_PARENT",
    "IOT_SUBNET_CIDR",
    "IOT_GATEWAY",
    "PIHOLE_IOT_IP",
    "PIHOLE_IOT_PASSWORD",
    "DNSCRYPT_SOCKS_USER_IOT",
    "DNSCRYPT_SOCKS_PASS_IOT",
    "TORHOLE_HOST_PIHOLE_IOT",
    "TORHOLE_ALIAS_PIHOLE_IOT",
  ]);
  const installedConfig = Object.fromEntries(
    Object.entries(fullInstalledConfig).filter(
      ([key]) => topology === "vlan" || !vlanOnlyKeys.has(key),
    ),
  );
  const planes =
    topology === "vlan"
      ? [
          { id: "trusted", label: "Trusted", status: "healthy" },
          { id: "iot", label: "IoT", status: "healthy" },
        ]
      : [{ id: "trusted", label: "Flat LAN", status: "healthy" }];

  await page.route("**/api/config", (route) =>
    route.fulfill({ json: { config: installedConfig } }),
  );
  await page.route("**/api/system/snapshot", (route) =>
    route.fulfill({
      json: {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        banner: null,
        dns: { planes },
      },
    }),
  );
  await page.route("**/api/notifications", (route) =>
    route.fulfill({ json: { channels: [] } }),
  );
  await page.goto("/?mode=advanced#/configure");
  await expect(page.getByRole("heading", { name: "What can you tune?" })).toBeVisible();
}

async function mockAdvancedGlance(page: Page) {
  const now = new Date().toISOString();
  await page.route("**/api/system/snapshot", (route) =>
    route.fulfill({
      json: {
        schema_version: 1,
        generated_at: now,
        banner: null,
        torhole: {
          overall_status: "healthy",
          privacy_intact: true,
          headline: "DNS is resolving through the isolated Tor path.",
          summary_sentence: "Privacy path verified.",
        },
        tor: {
          overall_status: "healthy",
          summary: "Tor ready",
          bootstrap: { status: "healthy", detail: "Bootstrapped 100%", percent: 100 },
          isolation: { status: "healthy", detail: "IsolateSOCKSAuth verified" },
          network_path: { status: "healthy", detail: "Tor egress confirmed" },
          plane_identities: { overall_status: "healthy" },
          circuits: {
            available: true,
            reason: null,
            items: [],
            by_plane: { trusted: [], iot: [] },
            count: 1,
            fetched_at: now,
          },
          last_rotation_at: null,
        },
        dns: {
          planes: [{ id: "trusted", label: "Flat LAN", status: "healthy" }],
          counts: { healthy: 1, degraded: 0, offline: 0, total: 1 },
          overall_status: "healthy",
          totals: { queries_today: 1242, blocked_today: 311, block_pct: 25 },
        },
        leak_test: {
          available: true,
          reason: null,
          last_result: {
            pass: true,
            is_tor: true,
            ip: "185.220.101.42",
            target: "check.torproject.org",
            ran_at: now,
            duration_ms: 412,
            error: null,
          },
          last_run_at: now,
          history_count: 4,
          recent_pass_rate: 100,
          history: [],
        },
        containers: [],
        container_counts: { healthy: 0, degraded: 0, offline: 0, total: 0 },
        backup: {
          snapshot_count: 0,
          last_snapshot_name: null,
          last_snapshot_at: null,
          last_snapshot_size_bytes: null,
        },
        alerts: { total_channels: 0, configured_channels: 0, enabled_channels: 0 },
        validation: { last_result: null },
        recovery: { status: "idle", latest_archive: null, finished_at: null },
        links: {},
      },
    }),
  );
  await page.goto("/?mode=advanced#/");
}

async function mockHome(page: Page) {
  const now = new Date().toISOString();
  await page.route("**/api/proof", (route) =>
    route.fulfill({
      json: {
        protected: true,
        checked_at: now,
        build: {
          product: "Torhole",
          version: "0.2.2",
          revision: "abc123def456",
          edition: "home",
          topology: "single-lan",
        },
        tor: { ok: true, progress: 100 },
        dns: { ok: true, answers: 2, ips: ["93.184.216.34"] },
        blocking: { ok: true, answers: 1, ips: ["0.0.0.0"] },
        exit: { ok: true, ip: "185.220.101.42", duration_ms: 412 },
        bypass: { ok: true, detail: "Only Tor has external egress." },
        circuit: {
          ok: true,
          relays: [
            { role: "guard", nickname: "HomeGuard", country: "CH", address: "192.0.2.1", fingerprint: "A".repeat(40) },
            { role: "middle", nickname: "HomeMiddle", country: "DE", address: "192.0.2.2", fingerprint: "B".repeat(40) },
            { role: "exit", nickname: "HomeExit", country: "NL", address: "192.0.2.3", fingerprint: "C".repeat(40) },
          ],
        },
        tests: {
          tor: { query: "Tor Project exit check", expected: "IsTor=true" },
          dns: { query: "example.com", expected: "A DNS answer" },
          blocking: { query: "doubleclick.net", expected: "Blocked answer" },
          bypass: { query: "Docker network inspection", expected: "No direct resolver egress" },
        },
      },
    }),
  );
  await page.goto("/?mode=home");
}

async function chooseAdvanced(page: Page) {
  await page.getByText("Edition", { exact: true }).first().click();
  await page.getByText("Torhole Advanced", { exact: true }).click();
}

async function submit(page: Page) {
  await page.getByText("Done", { exact: true }).first().click();
  await page.getByRole("button", { name: /install Torhole/i }).click();
}

test("Home can select every curated blocklist and submits the exact list", async ({ page }) => {
  const submitted = await mockBootstrap(page);
  await page.getByText("Blocklists", { exact: true }).first().click();

  const stevenBlack = page.getByRole("checkbox", { name: /StevenBlack hosts/i });
  const oisd = page.getByRole("checkbox", { name: /OISD Basic/i });
  const adguard = page.getByRole("checkbox", { name: /AdGuard DNS filter/i });
  await expect(stevenBlack).toBeChecked();
  await oisd.click();
  await adguard.click();
  await expect(oisd).toBeChecked();
  await expect(adguard).toBeChecked();

  await submit(page);
  expect(submitted()?.edition).toBe("home");
  expect(submitted()?.blocklists).toEqual(["stevenblack", "oisd", "adguard"]);
});

test("installed Home keeps the root URL and shared visual privacy proof", async ({ page }) => {
  await mockHome(page);

  await expect(page).toHaveURL(/\/?mode=home$/);
  await expect(page.getByText("Home", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Privacy is protected" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What happens to one DNS lookup" })).toBeVisible();
  await expect(page.getByTestId("privacy-flow-canvas")).toBeVisible();
  await expect(page.getByText("Glance", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Configure", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /About v0\.2\.2/i }).click();
  await expect(page.getByRole("dialog", { name: "Torhole Home" })).toBeVisible();
  await expect(page.getByText("abc123def456", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close About" }).click();

  await page.getByRole("button", { name: "Light theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  const versionedResources = await page.evaluate(() =>
    performance.getEntriesByType("resource")
      .map((entry) => new URL(entry.name).pathname)
      .filter((path) => path.startsWith("/v2/")),
  );
  expect(versionedResources).toEqual([]);
});

test("Advanced exposes both topology options and editable blocklists", async ({ page }) => {
  const submitted = await mockBootstrap(page);
  await chooseAdvanced(page);

  await page.getByText("Topology", { exact: true }).first().click();
  await page.getByText("Segmented VLANs", { exact: true }).click();
  await page.getByText("Single LAN", { exact: true }).click();

  await page.getByText("Blocklists", { exact: true }).first().click();
  await page.getByRole("checkbox", { name: /OISD Basic/i }).click();
  await page.getByRole("checkbox", { name: /AdGuard DNS filter/i }).click();
  await expect(page.getByRole("checkbox", { name: /OISD Basic/i })).toBeChecked();

  await submit(page);
  expect(submitted()?.edition).toBe("advanced");
  expect(submitted()?.topology).toBe("single-lan");
  expect(submitted()?.blocklists).toEqual(["stevenblack", "oisd", "adguard"]);
});

test("installed Advanced single-LAN hides commissioning and every IoT topology surface", async ({ page }) => {
  await mockInstalledAdvanced(page, "single-lan");

  await expect(page.getByText("Setup", { exact: true })).toHaveCount(0);
  const caDownload = page.getByRole("link", { name: /download Torhole CA/i });
  await expect(caDownload).toBeVisible();
  await expect(caDownload).toHaveAttribute(
    "href",
    "http://10.0.0.149/torhole-local-ca.crt",
  );
  await expect(page.getByRole("button", { name: /use my own certificate/i })).toBeVisible();
  await page.getByRole("tab", { name: /Topology/i }).click();
  await expect(page.getByText("Single LAN", { exact: true })).toBeVisible();
  await expect(page.getByText("Flat LAN", { exact: true })).toBeVisible();
  await expect(page.getByText("IoT", { exact: true })).toHaveCount(0);
  await expect(page.getByText("vlan id", { exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: /App parameters/i }).click();
  await expect(page.getByText("PIHOLE_TRUSTED_IP", { exact: true })).toBeVisible();
  await expect(page.getByText("TRUSTED_VLAN_ID", { exact: true })).toHaveCount(0);
  await expect(page.getByText("PIHOLE_IOT_IP", { exact: true })).toHaveCount(0);
  await expect(page.getByText("DNSCRYPT_SOCKS_USER_IOT", { exact: true })).toHaveCount(0);
  await expect(page.getByText("TORHOLE_HOST_PIHOLE_IOT", { exact: true })).toHaveCount(0);
});

test("installed Advanced VLAN shows both DNS planes", async ({ page }) => {
  await mockInstalledAdvanced(page, "vlan");

  await page.getByRole("tab", { name: /Topology/i }).click();
  await expect(page.getByText("Segmented VLANs", { exact: true })).toBeVisible();
  await expect(page.getByText("Trusted", { exact: true })).toBeVisible();
  await expect(page.getByText("IoT", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: /App parameters/i }).click();
  await expect(page.getByText("TRUSTED_VLAN_ID", { exact: true })).toBeVisible();
  await expect(page.getByText("PIHOLE_IOT_IP", { exact: true })).toBeVisible();
  await expect(page.getByText("DNSCRYPT_SOCKS_USER_IOT", { exact: true })).toBeVisible();
});

test("installed Advanced keeps sidebar controls visible while the page scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await mockInstalledAdvanced(page, "single-lan");

  const signOut = page.getByRole("button", { name: /sign out/i });
  const appearance = page.getByText("Appearance", { exact: true });
  await expect(signOut).toBeVisible();
  await expect(appearance).toBeVisible();
  const before = await signOut.boundingBox();
  expect(before).not.toBeNull();
  expect(before!.y + before!.height).toBeLessThanOrEqual(600);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  const after = await signOut.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
  await expect(appearance).toBeVisible();
});

test("installed HTTP mode identifies Basic Auth instead of claiming SSO", async ({ page }) => {
  await mockInstalledAdvanced(page, "single-lan", "http");

  await expect(page.getByText("Choose a view", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Identity & access.*viewing/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: /App parameters.*open/i })).toBeVisible();
  await expect(page.getByText("HTTP Basic Auth", { exact: true })).toBeVisible();
  await expect(page.getByText(/Authelia SSO is available.*HTTPS/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /enable HTTPS \+ Authelia SSO/i })).toBeVisible();
});

test("installed custom HTTPS does not offer the generated Torhole CA", async ({ page }) => {
  await mockInstalledAdvanced(page, "single-lan", "https-custom");

  await expect(page.getByText(/custom certificate supplied during setup/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /download Torhole CA/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /open Authelia login/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /use generated Torhole certificate/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /replace custom certificate/i })).toBeVisible();
});

test("installed Advanced persists theme choice and sidebar submenus deep-link to controls", async ({ page }) => {
  await mockInstalledAdvanced(page, "single-lan");

  const topologyLink = page.locator('nav a[href="#/configure?section=topology"]');
  await expect(topologyLink).toBeVisible();
  await topologyLink.click();
  await expect(page).toHaveURL(/section=topology/);
  await expect(page.getByRole("tab", { name: /Topology.*viewing/i })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByRole("button", { name: "Light theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("Advanced glance explains the live DNS privacy journey", async ({ page }) => {
  await mockAdvancedGlance(page);

  await expect(page.getByRole("heading", { name: "Is the privacy guarantee intact?" })).toBeVisible();
  await expect(page.getByText("live privacy path", { exact: true })).toBeVisible();
  await expect(page.getByText("DNS ingress", { exact: true })).toBeVisible();
  await expect(page.getByText("1 isolated plane", { exact: true })).toBeVisible();
  await expect(page.getByText("Tor relay mesh", { exact: true })).toBeVisible();
  await expect(page.getByText("circuit ready", { exact: true })).toBeVisible();
  await expect(page.getByText("Anonymized exit", { exact: true })).toBeVisible();
  await expect(page.getByText("185.220.101.42", { exact: true })).toBeVisible();
});

test("an installed setup bookmark redirects to Configure", async ({ page }) => {
  await mockInstalledAdvanced(page, "single-lan");
  await page.goto("/?mode=advanced#/setup");
  await expect(page.getByRole("heading", { name: "What can you tune?" })).toBeVisible();
  await expect(page).toHaveURL(/#\/configure$/);
});

test("Advanced offers HTTP, generated HTTPS, and custom HTTPS upload", async ({ page }) => {
  await mockBootstrap(page);
  await chooseAdvanced(page);
  await page.getByText("Web access", { exact: true }).first().click();

  await page.getByRole("button", { name: /^HTTP basic auth · no sso/i }).click();
  await expect(page.getByText(/HTTP is not SSO/i)).toBeVisible();
  await page.getByRole("button", { name: /HTTPS · generated/i }).click();
  await page.getByRole("button", { name: /HTTPS · my certificate/i }).click();

  const uploads = page.locator('input[type="file"]');
  await uploads.nth(0).setInputFiles({
    name: "torhole.crt",
    mimeType: "application/x-pem-file",
    buffer: Buffer.from("-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n"),
  });
  await uploads.nth(1).setInputFiles({
    name: "torhole.key",
    mimeType: "application/x-pem-file",
    buffer: Buffer.from("-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n"),
  });
  await expect(page.getByText("PEM certificate loaded")).toBeVisible();
  await expect(page.getByText("PEM private key loaded")).toBeVisible();
});

test("Advanced supports no alerts or Telegram, email, and Discord together", async ({ page }) => {
  const submitted = await mockBootstrap(page);
  await chooseAdvanced(page);
  await page.getByText("Alerts", { exact: true }).first().click();

  await expect(page.getByRole("checkbox", { name: /^Telegram/i })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^Email \(SMTP\)/i })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^Discord webhook/i })).not.toBeChecked();

  await page.getByRole("checkbox", { name: /^Telegram/i }).click();
  await page.getByLabel("Telegram bot token").fill("123456:token");
  await page.getByLabel("Telegram chat ID").fill("-100123456");

  await page.getByRole("checkbox", { name: /^Email \(SMTP\)/i }).click();
  await page.getByLabel("Alert email recipient").fill("operator@example.net");
  await page.getByLabel("Alert email sender").fill("torhole@example.net");
  await page.getByLabel("SMTP server").fill("smtp.example.net:587");

  await page.getByRole("checkbox", { name: /^Discord webhook/i }).click();
  await page.getByLabel("Discord webhook URL").fill("https://discord.com/api/webhooks/test");

  await submit(page);
  const alerts = submitted()?.alerts as Record<string, Record<string, unknown>>;
  expect(alerts.telegram).toMatchObject({ enabled: true, chat_id: "-100123456" });
  expect(alerts.email).toMatchObject({ enabled: true, require_tls: true });
  expect(alerts.discord).toMatchObject({ enabled: true, username: "torhole" });
});

test("Advanced success receipt reveals preserved administrator credentials", async ({ page }) => {
  await mockBootstrap(page);
  await page.unroute("**/api/bootstrap/install");
  await page.route("**/api/bootstrap/install", (route) =>
    route.fulfill({
      status: 202,
      json: {
        status: "success",
        message: "Torhole Advanced installed successfully.",
        edition: "advanced",
        topology: "single-lan",
        advanced_complete: true,
        direct_ip_url: "http://10.0.0.149/",
        advanced_url: "http://torhole.lan.home.arpa/",
        pihole_trusted_url: "http://pihole-trusted.lan.home.arpa/admin/",
        trusted_dns: "10.0.0.150",
        credentials: {
          TORHOLE_ADMIN_USER: "operator",
          TORHOLE_ADMIN_PASSWORD: "preserved-sso-password",
          PIHOLE_TRUSTED_USER: "admin",
          PIHOLE_TRUSTED_PASSWORD: "preserved-pihole-password",
        },
        logs: [],
      },
    }),
  );
  await chooseAdvanced(page);
  await submit(page);

  await expect(page.getByText("Save the administrator logins")).toBeVisible();
  await expect(page.getByText("operator", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show Torhole / SSO admin password" }).click();
  await expect(page.getByText("preserved-sso-password", { exact: true })).toBeVisible();
  await expect(page.getByText("admin", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show Pi-hole admin password" }).click();
  await expect(page.getByText("preserved-pihole-password", { exact: true })).toBeVisible();
});
