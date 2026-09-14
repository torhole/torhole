# Contributing to Torhole

Changes to the private DNS path must preserve Tor-only upstream routing and
avoid adding an alternate egress path. Keep changes focused and provide tests
for the behavior being changed.

## Development setup

A Pi is not required for backend tests, frontend development, or the isolated
integration suite. The complete Advanced macvlan deployment requires a
supported Linux host and appropriate network interfaces. Pointing macvlan at
macOS `lo0` is not a supported substitute; do not edit production network
isolation merely to make a local test start.

Clone the repository and follow [the testing guide](../README-TESTING.md) for
checks that do not require a deployed DNS server. For a complete test deployment,
use [the Ansible guide](../README-ANSIBLE.md) or the maintained `deploy.sh` flow
with a configured `.env`. Select `single-lan` for one DNS plane or `vlan` for
Trusted and IoT. The deployer prepares authentication, networking, and service
configuration before starting Compose.

## Admin UI

The UI lives in `monitoring/torhole-ui/` and builds into
`monitoring/caddy/admin-ui/` for the authenticated reverse proxy.

```bash
cd monitoring/torhole-ui
npm ci
npm run typecheck
npm run build
npm run dev
```

The development server proxies API calls to the configured backend. A production
build changes generated output, so use a development checkout.

For isolated bootstrap browser coverage:

```bash
npm run test:e2e:install
npm run test:e2e:bootstrap
```

For the separate live-deployment Playwright suite, set `TORHOLE_BASE_URL`,
`TORHOLE_TEST_USER`, and `TORHOLE_TEST_PASSWORD` explicitly, using a private
`tests/.env.test` copied from its example or environment variables. Then run
`npm run test:e2e` or `npm run test:e2e:ui`. This suite authenticates against the
real deployment and can change shared state; use a designated test installation.
Do not rely on the configured fallback hostname. Keep credentials, auth-state
files, traces, and screenshots containing private data out of commits.

Update visual baselines only for intentional changes and review the resulting
images. See [self-hosted testing](docs/self-hosted-runner.md) for runner boundaries.

## Continuous integration

The root `.github/workflows/ci.yml` runs on pull requests and pushes to `main`,
and exposes `workflow_call` for the release workflow. Release publication waits
for the complete reusable CI workflow.

- `validate`: Home and both Advanced Compose modes, backend tests, shell
  regressions, recovery preflight tests, and configuration validation.
- `ui`: reproducible dependency installation, typecheck, build, and isolated
  bootstrap browser tests.
- `lint-shell`: ShellCheck at warning severity over tracked shell files from the
  repository root, including the installers.
- `integration`: CI contract/maintenance tests, real localhost Ansible fixtures,
  and a disposable Docker-volume SQLite recovery drill.

The Caddy configuration check uses authentication/TLS stubs. The Ansible fixture
uses stub deployment executables and removes root ownership requirements from
fixture tasks. The Docker drill tests recovery helpers and persisted data,
without starting the full stack. These checks do not establish live DNS
fail-closed behavior. The live Playwright suite and live DNS outage drill remain
separate; follow [the testing guide](../README-TESTING.md).

## Making changes

- Preserve unrelated local changes and keep pull requests scoped.
- Add a failing regression for a concrete bug, then run the relevant tests after
  fixing it. Syntax checks alone do not validate runtime behavior.
- Validate Compose/config changes with the existing checks in a clean checkout;
  render scripts can overwrite generated files.
- Run backend tests for backend changes, and typecheck/build plus relevant
  browser checks for UI changes.
- Test backup/restore changes against malformed inputs and failure paths before
  destructive actions. The standalone updater can back up only the source state
  present when invoked; back up before replacing source files.
- Describe what changed, how it was verified, and any remaining live-environment
  limitations in the pull request.

## Reporting a privacy issue

Use the repository's private security reporting channel for suspected DNS leaks,
unauthenticated administrative access, or other vulnerabilities. Avoid posting
credentials or live deployment details in public issues.
