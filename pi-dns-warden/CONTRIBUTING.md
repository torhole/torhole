# Contributing to torhole

torhole is a privacy-first DNS platform. Contributions are welcome as long as they preserve the core guarantee: **all upstream DNS exits through Tor, no exceptions**.

## What we're looking for

- Bug fixes and reliability improvements
- Documentation improvements (especially setup guides for non-UniFi routers)
- Additional alert channels
- Grafana dashboard improvements
- Test coverage for `monitoring/backup-manager/server.py`
- Config editor improvements in the admin UI (gravity lists, DNS upstreams, per-plane allow/deny — see `docs/admin-redesign.md`)

## What we will not merge

- Changes that add any DNS path that bypasses Tor
- Telemetry, analytics, or phone-home behaviour of any kind
- Auto-update mechanisms that fetch and execute remote code without explicit user opt-in
- Dependencies with opaque or proprietary licensing

## Development setup

You do not need a Pi or VLAN-capable hardware to contribute. The stack runs on any Linux or macOS machine with Docker and Docker Compose installed.

```bash
# Clone
git clone https://github.com/your-org/torhole.git
cd torhole/pi-dns-warden

# Configure
cp .env.example .env
# Edit .env — at minimum set the three PIHOLE_*_PASSWORD values
# and the three DNSCRYPT_SOCKS_PASS_* values.
# For local dev, the macvlan networks will fail on macOS; set:
#   TRUSTED_PARENT=lo0   (or any existing interface)

# Start the core DNS stack
docker compose up -d

# Start monitoring (optional)
docker compose -f docker-compose.monitoring.yml up -d
```

For macOS dev, macvlan does not work with the default Docker Desktop network driver. You can comment out the `macvlan_*` networks and the corresponding Pi-hole network attachments in `docker-compose.yml` — the stack will still function on `dns_int` alone for testing purposes.

## Admin UI development

The admin UI lives in `monitoring/torhole-ui/` as a Vite + React 19 + Tailwind 4 project. It builds into `monitoring/caddy/admin-ui/`, which Caddy serves at the site root behind Authelia.

```bash
cd monitoring/torhole-ui
npm install

# Type-check (strict tsc)
npm run typecheck

# Production build — writes into ../caddy/admin-ui/
npm run build

# Hot-reload dev server (proxies /api/* to a local backup-manager)
npm run dev
```

### End-to-end tests (Playwright)

The E2E tests run against a live backup-manager + Caddy + Authelia stack — they're not unit tests. You'll need a reachable deployment (local or remote) and the test user credentials in `tests/.env.test`:

```bash
cd monitoring/torhole-ui
cp tests/.env.test.example tests/.env.test
# fill in TORHOLE_BASE_URL, TORHOLE_TEST_USER, TORHOLE_TEST_PASSWORD

npm run test:e2e:install    # one-time: install chromium to ./.playwright-browsers
npm run test:e2e            # full suite
npm run test:e2e:ui         # UI mode for debugging a single test
```

Visual regression baselines live in `tests/visual.spec.ts-snapshots/`. Update them with `--update-snapshots` after an intentional UI change and commit the new PNGs.

## Continuous integration

A GitHub Actions workflow at `.github/workflows/ci.yml` runs on every PR and push to `main`:

- **`ui`** — `npm ci` + `npm run typecheck` + `npm run build` in `monitoring/torhole-ui`
- **`dashboards`** — JSON validity + unique UID check for every file in `monitoring/grafana/dashboards`
- **`caddyfile`** — `caddy validate` against `monitoring/caddy/Caddyfile` in an ephemeral container

Playwright E2E is **not** in hosted CI — it needs the full 14-container stack running. If you have infrastructure, see `docs/self-hosted-runner.md` for how to wire a self-hosted runner.

## Making changes

- Keep PRs small and scoped. One logical change per PR.
- If you change a compose file, run `docker compose config` to validate it before opening a PR.
- If you change `monitoring/backup-manager/server.py`, run `python3 -m py_compile monitoring/backup-manager/server.py`.
- If you change a Prometheus config, run `docker compose exec prometheus promtool check config /etc/prometheus/prometheus.yml`.
- If you change the admin UI, run `npm run typecheck && npm run build` at a minimum before opening the PR. `npm run test:e2e` should be run locally against a real stack.
- For destructive UI operations, gate the action behind a `ConfirmModal` type-to-confirm input — see `docs/admin-redesign.md` §4.3.

## Commit style

```
<type>: <short description>

type: fix | feat | docs | refactor | test | ci | chore
```

## Reporting a privacy issue

If you believe you have found a design flaw that undermines the privacy guarantees (DNS leaking outside Tor, unintended network exposure, etc.), **do not open a public issue**. Email the maintainer directly or use GitHub's private security advisory feature.
