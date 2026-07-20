# Torhole admin redesign

Status: **draft** · Owner: AG-003 · Tracks: T-024 · Date: 2026-04-09

## 1. Why

The current admin UI (`monitoring/torhole-ui/src/App.tsx`, 2,672 lines) accumulated organically. It works, but it has three structural problems that block what we want Torhole to be:

1. **It hides the privacy guarantee.** Torhole's value is "every DNS query exits via Tor with isolated circuits." That fact is invisible in the current UI — the operator has no way to *see* the Tor circuit, *prove* there's no leak, or *trust* that anything is actually doing what the README claims. For a privacy product, the UI's job is to render the proof.
2. **It computes the same thing three different ways.** Recent screenshot: banner says "0/3 Pi-hole APIs reachable", a status tile says "1/3 healthy", another tile says "3/3", and the underlying plane cards correctly show all three healthy with real data. Three aggregations, three different answers, one page. This is a class of bug, not a one-off — different React components fetch different endpoints that compute slightly different things.
3. **It looks vibecoded.** Generic dark cards, identical visual weight everywhere, repeated chip+counter patterns, no focal point, no brand presence beyond a logo. For a security tool that lives or dies on operator trust, "looks like every other AI-generated admin shell" is a credibility problem on day one.

This document is the plan for a **greenfield rewrite** that fixes all three.

## 2. Audience

| User | Frequency | Needs |
|---|---|---|
| **The maintainer** (you) | Daily | Live state of every privacy guarantee. Operate containers, run validation, check Tor circuits, debug. |
| **Homelab operator** (GitHub user) | Weekly | First-run setup that doesn't require Linux networking knowledge. Plain-language status. Confidence that privacy is intact. |
| **Curious visitor** (GitHub repo browser) | One look | Screenshots in the README that make them want to clone. The UI itself sells the project. |

The whole project is on a path to public release on GitHub. **The UI is part of the pitch.**

## 3. Principles

1. **Render the proof, don't assert it.** Don't say "Tor: OK" — show the circuit IDs, the exit IP, the last identity rotation timestamp, and a leak test result with a wall-clock timestamp. The operator should be able to *verify* the claim by looking, not trust a green badge.
2. **One source of truth, one aggregation, one counter.** Every component on every page reads from one shared snapshot endpoint. No React component computes its own status. No backend function summarizes the same thing twice with different code.
3. **Live by default.** Privacy state can drift in seconds (Tor circuit dies, dnscrypt restarts, alert channel times out). The UI must show drift in real time, not on F5.
4. **Teach the architecture on first contact.** A new visitor should understand `client → Pi-hole → dnscrypt → Tor → exit` from looking at the home screen. No prior knowledge required.
5. **Five screens, no more.** Each screen answers exactly one question. Anything that doesn't fit one of the five questions either gets folded in or removed.
6. **Configurable in the UI for common things, in `.env` for advanced things.** The line between the two must be obvious.
7. **Single-LAN is the default topology.** The current VLAN-only mode is opt-in advanced; most GitHub users run a flat home LAN.
8. **The visual design is intentional.** Restrained palette, real type hierarchy, monospace for proofs, density where it earns it. No generic admin chrome.

## 4. Information architecture

Five screens. Locked.

| # | Screen | Question it answers | Update model |
|---|---|---|---|
| 1 | **Glance** | Is my privacy guarantee intact right now? | Live (SSE) |
| 2 | **Privacy** | What does Torhole prove, and how? | Live (SSE) |
| 3 | **Operate** | What button do I press to fix or change something? | Polled (5s) |
| 4 | **Configure** | Where do I set the things I'm allowed to set? | Form-based |
| 5 | **Setup** (first run / reconfigure) | How do I get from `git clone` to working in 5 minutes? | Stepwise |

Navigation: a left rail with five icons + labels. Sticky. Always visible. No nested menus. No tabs inside pages. No "more options" buttons that hide things.

### 4.1 Glance — the home screen

**One focal point. No scrolling on a 1080p laptop.**

```
┌─────────────────────────────────────────────────────────────────────┐
│  ◐  Torhole                                  hp · sign out         │
├─────────────────────────────────────────────────────────────────────┤
│ ▣ │                                                                 │
│ Glance     ╭──────────────────────────────────────────────────────╮ │
│ Privacy    │                                                      │ │
│ Operate    │   ✓  DNS exits via Tor                               │ │
│ Configure  │                                                      │ │
│ Setup      │   3 isolated circuits · last rotation 4m ago         │ │
│            │   exit: DE · 185.220.101.34 · BeidouRelay            │ │
│            │                                                      │ │
│            ╰──────────────────────────────────────────────────────╯ │
│                                                                     │
│            ┌───────────┬───────────┬───────────┬───────────┐        │
│            │  LEAK     │  DNS      │  ALERTS   │  BACKUP   │        │
│            │  PASS     │  3/3 up   │  ✓ ✓     │  4h ago   │        │
│            │  02:11    │  191k qps │  TG·MAIL  │  12 MB    │        │
│            └───────────┴───────────┴───────────┴───────────┘        │
│                                                                     │
│            queries/min last 60m                                     │
│            ▁▂▂▃▂▃▄▆▇█▆▅▄▃▂▂▃▃▂▂▁▁▂▃▄▆▇▆▄▃▂▂▁▂▃▄▅▆█▆▄▃▂▂▁▂▃         │
│                                                                     │
│            Recent privacy events                                    │
│            02:14  Tor identity rotated (all planes)                 │
│            02:11  Leak test PASS · 0 leaked queries                 │
│            01:55  Pi-hole gravity refresh complete                  │
│            01:32  Authelia session created · hp                     │
│                                                                     │
│            ┌─ Quick actions ─────────────────────────────────────┐  │
│            │ [ Rotate Tor identity ]  [ Run leak test ]          │  │
│            │ [ Run validation ]       [ Take snapshot ]          │  │
│            └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**Hero rules:**
- Two states only: `✓ DNS exits via Tor` (accent) or `✗ Privacy guarantee compromised` (danger). Never show "degraded" here — degraded is failure.
- Below the hero: the current circuit count, last rotation, exit country, exit IP, exit relay name. **All in monospace.** This is the proof.
- The hero is the only large element on the page. Everything else is subordinate.

**Proof tiles** (4 max, single row):
- **LEAK** — last leak test result + wall-clock time
- **DNS** — N/M planes serving + queries/sec or queries today
- **ALERTS** — channel ✓/✗ icons (Telegram, mail, etc.)
- **BACKUP** — age of last snapshot + size

Each tile is clickable → drills into the relevant screen.

**Sparkline** — queries/min, last 60 minutes. Tremor `<SparkAreaChart>`. No axes. Shows pulse.

**Recent privacy events** — read-only feed of the last ~5 events that mattered. Tor rotation, leak tests, gravity refresh, validation runs. Not a generic "log" — only operator-meaningful events. Live via SSE.

**Quick actions** — the four most common ops, one click each. Confirmation modal only for destructive ones.

### 4.2 Privacy — the proof screen

This is the screen that justifies Torhole's existence.

**Sections:**

1. **Tor circuit panel** (the hero of this page)
   - Per-plane (or single, in single-LAN mode), show:
     - Entry node: fingerprint short-id, country flag, "first hop"
     - Middle node: same
     - Exit node: same + IP + bandwidth class
     - Built at: timestamp
     - Isolated SOCKS auth user (proves circuit isolation)
   - **"Rotate this identity"** button per plane, **"Rotate all"** button at top
   - Stream of circuit changes via SSE — the panel reflects rotations live without refresh

2. **DNS leak test panel**
   - Last result: PASS / FAIL with timestamp and which provider was queried
   - Mini history: last 24h pass rate as a sparkline
   - **"Run now"** button → runs the test, panel updates live
   - Schedule: "every N minutes" with a config link to Configure

3. **Per-plane upstream proof**
   - For each plane: a horizontal flow `pi-hole → dnscrypt-trusted → tor:9050 → exit`
   - Each arrow either ✓ (probe successful within last 30s) or ✗ (with reason on hover)
   - This is the only place in the UI where the whole DNS path is rendered visually

4. **Live query feed** (terminal-style, monospace, dense)
   - Last N=200 queries from FTL via the existing pihole-FTL log stream
   - Columns: `time · plane · query · type · result(allowed|blocked|forwarded)`
   - Pause / scroll-lock toggle
   - Search/filter input
   - Export disabled (PII)

### 4.3 Operate — the actions screen

**Sections:**

1. **Containers** — compact data table
   - Columns: name, status, uptime, last restart, image, actions (start/stop/restart/logs)
   - "Logs" opens a slide-over panel with a tail of the container's stdout
   - Bulk actions: select containers, restart all selected
   - **Destructive action gate:** any bulk stop/restart goes through a type-to-confirm modal (see below)
2. **Backups**
   - Table of snapshots: id, created, size, retention status, actions (download/restore/delete)
   - **Create snapshot** button (with optional label)
   - **Restore** is destructive: opens a type-to-confirm modal that requires typing the snapshot name (or `RESTORE`) to confirm; explicitly warns about what gets overwritten
   - **Delete** is destructive: opens a type-to-confirm modal that requires typing `DELETE` to confirm; warns that the archive cannot be recovered
   - **Rule (applies everywhere in the admin UI):** any irreversible destructive operation must go through a type-to-confirm modal — not a yes/no dialog that can be clicked by accident. The operator types a verb (`DELETE`, `RESTORE`, `FORCE`) or the resource name before the action button enables. This rule is load-bearing for operator safety and must not be softened.
3. **Validation**
   - **Run validation** button (single click)
   - Below: results from last run, each check expandable to show its full output
   - History of last 10 runs as a small sparkline of pass/fail
4. **Recovery**
   - Last recovery event log
   - **Recovery actions** with plain-language descriptions of what each one does
   - "Why is recovery needed?" link → docs
5. **Maintenance**
   - Pi-hole gravity refresh button
   - Tor identity rotation (cross-link to Privacy)
   - "Check for updates" → opens dockhand in new tab

### 4.4 Configure — the settings screen

All forms. Each section is collapsible. Apply/cancel per section. Per-field validation. **No drafts pattern** (the current "draft → review → apply" pattern adds friction without value here).

**Sections:**

1. **Identity & access**
   - Admin username (read-only after setup)
   - Change password (current + new + confirm)
   - Authelia session timeout
2. **Topology** (read-only summary)
   - Current mode: Single-LAN / VLAN
   - Detected interfaces, IPs
   - **"Reconfigure topology"** → re-enters the Setup wizard
3. **DNS upstreams**
   - Per-plane dnscrypt resolver list (multi-select from a curated list)
   - Custom resolver entry (advanced)
4. **Blocklists**
   - Gravity URL list editor
   - Per-list: enabled toggle, source URL, last fetched, domain count
   - Add new list, remove list
   - **"Update gravity now"** button
5. **Allow/deny domains**
   - Per-plane plain-text editors for explicit allow and deny entries
6. **Alerts**
   - Telegram: bot token, chat id, **"Send test"** button
   - Email (SMTP): host, port, auth, from, to, **"Send test"** button
   - Notification policy: which event categories notify which channel
7. **Backup policy**
   - Schedule (cron-ish picker)
   - Retention count
   - Local target dir
   - (Future: remote targets — not in v1)
8. **Advanced**
   - Single panel: "These settings live in `.env`. Edit `/opt/pi-dns-warden/.env` and re-run `bash ops/scripts/19-validate-stack.sh`."
   - List of advanced keys with their current values (read-only)

### 4.5 Setup — the first-run wizard

**Triggered:** automatically on first run if `.env` is missing or `TORHOLE_SETUP_COMPLETE` is unset. Manually re-invokable from Configure → Topology.

**Steps** (each is its own screen, with Back/Next, skippable where it makes sense):

1. **Welcome** — what Torhole does, in 4 lines. ETA ~5 minutes. Continue.
2. **Topology** — Single-LAN (recommended) vs VLAN (advanced). Each option shows a small ASCII/SVG diagram. Default = Single-LAN.
3. **Network** — auto-detected interface, gateway, subnet. Editable. Single-LAN: just one Pi-hole IP. VLAN: two (Trusted/IoT) with parent interfaces.
4. **Admin account** — username, password (twice). Authelia session secret + storage encryption key generated automatically and shown once with "save these somewhere" warning.
5. **Blocklists** — curated picker: StevenBlack hosts, OISD basic, OISD full, AdGuard DNS, etc. Each with a description and domain count. User picks 1+. Custom URLs allowed.
6. **Tor** — exit country preference (any / specific country), bridges (no / obfs4 with config), identity rotation interval (default 10 min).
7. **Alerts** (optional, skippable) — Telegram or email setup with test buttons.
8. **Test** — runs DNS resolution test + leak test. Shows pass/fail with details. If fail, link back to the relevant step.
9. **Done** — summary of what was set up, link to admin home, command to view logs, link to docs.

After completion, the wizard:
- Writes `/opt/pi-dns-warden/.env`
- Runs the relevant render scripts (`18-render-auth.sh`, etc.)
- Restarts the affected containers
- Sets `TORHOLE_SETUP_COMPLETE=true` in `.env`

## 5. Visual system

The current UI's biggest problem isn't structural — it's that it has no design system, just defaults. This section locks the visual language so every component pulls from the same well.

### 5.1 Palette

Dark only. No theme toggle.

| Token | Hex | Use |
|---|---|---|
| `bg` | `#0a0d11` | Page background |
| `bg-1` | `#10141a` | Panel background |
| `bg-2` | `#171c24` | Inset / code block |
| `border` | `#1c2330` | Subtle dividers |
| `border-strong` | `#2b3645` | Form fields, table dividers |
| `fg` | `#dce3eb` | Primary text |
| `fg-muted` | `#7c8a9c` | Secondary text, labels |
| `fg-mono` | `#a8b8cc` | Monospace values (proofs) |
| `accent` | `#5fd1a8` | "Privacy intact", primary actions, links |
| `accent-glow` | `rgba(95, 209, 168, 0.18)` | Hero background wash |
| `danger` | `#f06464` | Failure, destructive actions |
| `warn` | `#f0b864` | Warnings, partial states |

The accent is a desaturated teal-green — Tor onion adjacent without being on the nose. It signals "trust + technical" rather than "marketing green."

### 5.2 Type

| Role | Family | Size / line-height | Weight |
|---|---|---|---|
| Display | Geist Sans (or Inter Display) | 36 / 44 | 700 |
| Title | Geist Sans | 22 / 28 | 600 |
| Body | Geist Sans | 15 / 22 | 400 |
| Body strong | Geist Sans | 15 / 22 | 600 |
| Mono | Geist Mono (or JetBrains Mono) | 13 / 20 | 400 |
| Mono tight | Geist Mono | 12 / 16 | 400 |

Three families max (display, body, mono — and display can be the same family as body in a heavier weight). Three sizes per family max. **Anything that's a proof is monospace.**

### 5.3 Spacing

`4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`. Nothing else. Tailwind spacing scale with the in-between values disabled.

### 5.4 Radius

`0 · 4 · 8`. Nothing else.
- `0` for the live query feed (terminal feel)
- `4` for inputs and small chips
- `8` for panels

### 5.5 Component primitives

Built on **shadcn/ui** + **Tremor** for charts. No bespoke panels.

| Component | Purpose |
|---|---|
| `<Hero status="ok"|"warn"|"fail">` | Single-line statement with mono accent and optional glow background |
| `<Proof label icon value>` | Proof tile (the four-up row on Glance) |
| `<Pane title eyebrow actions>` | The only content container; replaces the current 3 different panel styles |
| `<DataTable>` | shadcn data table for containers, snapshots, blocklist URLs |
| `<LiveFeed source="queries"|"events">` | Terminal-style monospace stream, virtualized, SSE-bound |
| `<Sparkline series>` | Tremor SparkAreaChart preset, no axes, with optional delta label |
| `<MonoBlock>` | Code/proof block with subtle border |
| `<Form>` + `<FieldGroup>` + `<Field>` | Configure forms |
| `<Wizard>` + `<WizardStep>` | Setup wizard chrome |
| `<ConfirmModal>` | The only confirmation UI; takes a "type to confirm" prop |

If a screen needs a layout primitive that isn't in this list, it's a sign the screen is doing too much.

### 5.6 References (steal from, don't copy)

- **Tailscale admin** — clearest privacy product UI in production. Density done right.
- **Fly.io dashboard** — intentional density, real type hierarchy.
- **Linear** — spacing system, motion restraint.
- **Vercel observability** — live data UI patterns.

The goal is to land somewhere in this neighborhood — *not* to look like any one of them.

## 6. API contract changes

### 6.1 Single source of truth

**New endpoint:**
```
GET /api/system/snapshot
```

Returns the unified state used by every screen. Server-side cache TTL ~2s to prevent thundering-herd against Pi-hole. The shape:

```json
{
  "generated_at": "2026-04-09T00:14:32Z",
  "torhole": {
    "overall_status": "ok",
    "privacy_intact": true,
    "version": "0.5.0"
  },
  "tor": {
    "bootstrap_pct": 100,
    "circuits": [
      {
        "plane": "trusted",
        "entry": {"fp": "ABC123", "country": "DE"},
        "middle": {"fp": "DEF456", "country": "NL"},
        "exit":  {"fp": "GHI789", "country": "DE", "ip": "185.220.101.34"},
        "built_at": "2026-04-09T00:10:14Z",
        "socks_auth_user": "torhole-trusted"
      }
    ],
    "last_rotation_at": "2026-04-09T00:10:14Z"
  },
  "dns": {
    "planes": [
      {"id": "trusted", "status": "healthy", "queries_today": 191234, "blocked": 29701, "block_pct": 15.5}
    ],
    "totals": {"queries_today": 202957, "blocked": 29701, "block_pct": 14.6}
  },
  "leak_test": {
    "last_result": "pass",
    "last_run_at": "2026-04-09T00:11:00Z",
    "last_provider": "ipleak.net",
    "history_24h_pass_rate": 1.0
  },
  "containers": [
    {"name": "tor", "status": "running", "uptime_s": 345600, "health": "healthy"}
  ],
  "backup": {
    "last_snapshot_at": "2026-04-08T20:12:00Z",
    "last_snapshot_size_bytes": 12582912,
    "snapshot_count": 8
  },
  "alerts": {
    "channels": [
      {"name": "telegram", "enabled": true, "healthy": true, "last_test_at": "2026-04-08T18:00:00Z"}
    ]
  },
  "validation": {
    "last_run_at": "2026-04-08T22:00:00Z",
    "last_result": "pass",
    "checks_pass": 14,
    "checks_total": 14
  }
}
```

**Every page** uses one shared React hook (`useSnapshot()`) that polls this endpoint every 5s and feeds every component. **No component computes its own status.** Three-counter mismatch becomes structurally impossible.

### 6.2 Live streams (Server-Sent Events)

```
GET /api/stream/health     # diff stream — push when something changes in the snapshot
GET /api/stream/queries    # live DNS query feed (filtered, no PII export)
GET /api/stream/events     # privacy events: rotation, leak test, validation, gravity refresh
```

Why SSE (not WebSockets): one-way, simple, works through Caddy with no extra config, ~50 lines added to `server.py`. The UI is read-mostly; bidirectional isn't needed.

### 6.3 Action endpoints

```
POST /api/tor/rotate                          # body: { "plane": "all" | "trusted" | ... }
POST /api/leak-test/run
POST /api/backup/snapshot                     # body: { "label": "..." }
POST /api/backup/restore                      # body: { "snapshot_id": "...", "confirm": "..." }
POST /api/validation/run
POST /api/containers/{name}/{action}          # action: start|stop|restart
POST /api/containers/{name}/logs              # SSE stream of logs
POST /api/gravity/refresh
POST /api/config/save                         # body: { "section": "...", "values": {...} }
POST /api/setup/{step}                        # body varies by step
```

Every action returns the new snapshot inline so the UI updates atomically.

### 6.4 What gets removed from `server.py`

- Per-page status helpers that compute slightly different aggregations (`summarize_plane_api_health` standalone, `system_status_payload`, `get_dns_stats` — fold into `snapshot()`)
- Draft-state endpoints if the new Configure pages are form-based (most are)
- Legacy compatibility endpoints serving the static HTML pages

## 7. Cut list

Files to delete:

| Path | Reason |
|---|---|
| `monitoring/caddy/operate.html` | Superseded by React app |
| `monitoring/caddy/resolver.html` | Superseded |
| `monitoring/caddy/access.html` | Superseded |
| `monitoring/caddy/app.css` | Belongs to the dead static UI |
| `monitoring/caddy/app.js` | Belongs to the dead static UI |
| Legacy Caddyfile redirect routes | Operate/resolver/access redirects |
| Stale `index-*.{js,css}` bundles in `caddy/assets/` | Vite build hashes; only the current pair should remain |
| Draft-state endpoints in `server.py` | If unused after rewrite |
| Earlier monolithic `monitoring/torhole-ui/src/App.tsx` | Replaced by the current screen-based React application |

## 8. Migration history

These five phases describe the completed cutover from the development-era UI.

### Phase 1 — API foundation
- Add `/api/system/snapshot` and `/api/stream/*` to `server.py`
- Existing endpoints stay live and untouched
- Unit tests against the new endpoints
- Backup-manager image rebuilds via `ops/scripts/70-deploy-dev.sh`, which
  also builds `torhole-ui`, syncs the Vite build output under
  `monitoring/caddy/admin-ui/`, and rebuilds the container so the COPY'd
  `server.py` is picked up.
- **Exit criterion:** the new endpoints return the right data; old UI unaffected.

### Phase 2 — Greenfield React app
- New `monitoring/torhole-ui/` sibling tree (Vite/React/TS, separate `package.json`)
- All 5 screens implemented against the new endpoints
- Mounted at `/v2` in the Caddyfile (old UI still at `/`)
- Both UIs coexist; you can flip between them in the browser
- **Exit criterion:** every Glance/Privacy/Operate/Configure feature works in /v2 against the live stack.

### Phase 3 — Setup wizard + single-LAN compose
- New `docker-compose.single-lan.yml` (or a profile in the existing compose)
- Setup wizard step that picks the topology and writes the right compose selection into `.env`
- `deploy.sh` honors the topology choice
- **Exit criterion:** a fresh GitHub clone can boot Torhole in single-LAN mode using only the wizard.

### Phase 4 — Cutover
- `/v2` becomes `/`
- Old UI removed from Caddyfile
- Cut-list files deleted
- Legacy `server.py` paths removed
- **Exit criterion:** `App.tsx` (the new one) is the only UI; total UI line count drops by >50%; no functional regressions vs the v2 phase.

### Phase 5 — GitHub polish
- README rewrite with screenshots from the new UI
- Demo GIF/video of the setup wizard
- Contribution guide
- Issue templates
- **Exit criterion:** repo is presentable for public release.

## 9. Per-screen build estimates (rough)

| Phase | Screen | Estimate |
|---|---|---|
| 1 | API: snapshot + SSE + actions | 1-2 days |
| 2 | Glance | 1 day |
| 2 | Privacy (Tor circuits + leak test + query feed) | 2-3 days |
| 2 | Operate | 1-2 days |
| 2 | Configure | 2 days |
| 3 | Setup wizard | 2 days |
| 3 | Single-LAN compose + topology branching | 1-2 days |
| 4 | Cutover, cleanup | 1 day |
| 5 | GitHub polish | 1 day |

Total: ~12-16 working days end-to-end. Each phase is independently mergeable.

## 10. Decisions locked

- **Greenfield rewrite**, not incremental refactor
- **Single-LAN default**, VLAN as opt-in
- **5 screens**, no more
- **Dark theme only**
- **shadcn/ui + Tremor** as the component foundation
- **SSE** for live data (not WebSockets)
- **One snapshot endpoint** as the single source of truth
- **Setup wizard** is mandatory first-run, re-invokable from Configure
- **No multi-user / RBAC / OIDC** in v1

## 11. Open questions

These need an answer before Phase 2 starts. Phase 1 (API) can proceed without them.

1. **Brand palette.** The proposed accent is `#5fd1a8` (desaturated teal-green). Is this the brand? If there's an existing brand kit in `torhole_branding_agent_pack/`, I should use it instead — flag for review.
2. **Live query feed retention.** In-memory ring buffer (lightweight, ephemeral, ~1k queries) or persisted SQLite (queryable, heavier, retains across restarts)? Recommendation: in-memory for v1 — Pi-hole already persists query history.
3. **Backup destinations.** Local only in v1, or include S3/B2/SSH targets? Recommendation: local only in v1; remote in v2.
4. **Alert channels beyond Telegram + email.** Discord webhook? Slack? Recommendation: keep tight — Telegram + email + a generic webhook URL covers 90% of users.
5. **Setup wizard re-entry behavior.** "Reconfigure topology" via wizard — does it tear down and re-create the stack, or just rewrite `.env` and reload? Has implications for data persistence.
6. **Pi-hole `max_sessions` default.** Currently bumped to 256 manually on the live stack. Should this become the bake-in default in `docker-compose.yml` via `FTLCONF_webserver_api_max_sessions=256`? Recommendation: yes — fold into Phase 1.
7. **Tor bootstrap log parsing.** The current `build_tor_assurance` regex misses the actual bootstrap line emitted by the Tor build in this repo. Small standalone fix in `server.py` — fold into Phase 1.
8. **Greenfield strategy: in-place or new directory?** Recommendation: new isolated UI tree during Phases 1-3 so the old UI keeps working; flip names in Phase 4. The alternative ("delete src/, start over") leaves the live stack with no UI for the duration of the rewrite, which is unacceptable.

## 12. Out of scope (v1)

- Authelia replacement / OIDC SSO
- Multi-user accounts / RBAC
- Light theme / theme toggle
- Mobile-first responsive (desktop-first; mobile = "works, doesn't shine")
- i18n (English only)
- Public-facing instance / multi-tenant
- Plugin system / external integrations beyond alert webhooks
- Built-in remote-attestation of the Tor exit node identity (would be cool — not in v1)

## 13. What success looks like

A first-time visitor lands on the GitHub README, sees a screenshot of the Glance screen, and immediately understands: *this is a privacy product that proves its claims.* They clone, run `docker compose up`, hit the setup wizard, click through 8 screens in 5 minutes, and end up at a Glance screen that shows their actual Tor circuit. They believe what they're looking at because the proof is rendered in monospace, with timestamps, with verifiable IDs.

Then they star the repo.
