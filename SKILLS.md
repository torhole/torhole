# Torhole maintenance playbook

Version 1.0 — 2026-09-13. Read the section relevant to the task; [AGENTS.md](AGENTS.md) holds the shared constraints.

This is a repository workflow reference, explicitly linked from `AGENTS.md`. It is not an installed Codex skill or model configuration. Installed skills have their own `SKILL.md` entrypoints; use available skills when they materially help the requested work.

## Review and assessment

Inspect the working-tree diff and the affected component's callers, configuration, tests, and documentation. For a broad review, cover installation, both editions and topologies, DNS/Tor isolation, authentication, configuration writes, backup/restore, UI result handling, monitoring, CI/release, and operator documentation.

Prioritize reproducible failures and data-loss/privacy consequences. Use temporary fixtures for failure cases. Record commands and results, skipped checks, and whether conclusions come from static inspection, mocked tests, or a live environment. Keep private assessments in the existing ignored `AUDIT-*.md` convention.

## Local backend checks

Run relevant files directly from the repository root; the suites load their neighboring modules themselves:

```bash
python3 pi-dns-warden/monitoring/backup-manager/test_security.py
python3 pi-dns-warden/monitoring/backup-manager/test_characterization.py
python3 pi-dns-warden/monitoring/backup-manager/test_validation.py
python3 pi-dns-warden/bootstrap/test_server.py
python3 pi-dns-warden/bootstrap/test_host_runner.py
python3 pi-dns-warden/home-dashboard/test_server.py
python3 pi-dns-warden/monitoring/pihole-exporter/test_exporter.py
python3 pi-dns-warden/ops/tests/test-monitoring-dashboards.py
```

For configuration writers, exercise concurrent requests, failed writes, round-trip parsing, and rollback as applicable. Atomic rename alone does not serialize read-modify-write operations. For external service clients, test offline and malformed responses as well as success.

## Shell, configuration, and topology

From the repository root:

```bash
bash pi-dns-warden/ops/tests/test-executable-modes.sh
bash pi-dns-warden/ops/tests/test-load-env.sh
bash pi-dns-warden/ops/tests/test-security-compose.sh
bash pi-dns-warden/ops/tests/test-topology-compose.sh
bash pi-dns-warden/ops/tests/test-prometheus-render.sh
bash pi-dns-warden/ops/tests/test-get-torhole.sh
```

Use `bash -n` on changed shell scripts and ShellCheck when available. The security Compose test requires the Compose CLI; syntax checks cannot replace it. Validate all three deployment variants with example values in a temporary copy when changing Compose. Use `config --quiet` to avoid dumping interpolated secrets.

Validate generated dnscrypt configurations as TOML; `ops/templates_dnscrypt_proxy.toml` contains substitution tokens and is not valid TOML before rendering. Prometheus, alert rules, Caddy, and Tor need their native validators for semantic checks. See CI and [stack validation](pi-dns-warden/docs/stack-validation.md) for the maintained commands. Some validation modes can pull images or render files: inspect the command and use an isolated copy for a review.

Do not execute installers, deployers, restores, host hardening, or VLAN scripts as syntax checks. A local macOS checkout does not establish Linux host/network behavior.

## UI checks

From `pi-dns-warden/monitoring/torhole-ui/`, with dependencies installed:

```bash
npm run typecheck
npm run build
npm run test:e2e:bootstrap
```

Use `npm ci` when dependency installation is needed and permitted. The production build replaces generated assets in `monitoring/caddy/admin-ui/`; it does not deploy them. The bootstrap Playwright configuration uses a localhost Vite server and mocked APIs, including tests for parts of the Advanced UI. Chromium must be available at the configured path or through `PLAYWRIGHT_CHROME_EXECUTABLE`.

The separate `npm run test:e2e` suite uses deployment credentials and can perform real operations. Inspect its target and tests before running it; a review alone does not authorize changing a live DNS service. Never regenerate visual baselines just to hide a regression.

For status/control changes, cover successful fetch followed by failure, stale data, HTTP 200 with a failed domain result, unavailable measurements, and recovery. Preserve readable error states and keyboard access.

## Recovery and releases

For recovery work, test corrupt, empty, incomplete, and supported legacy archives without touching a real installation. Check that rejection happens before downtime or file replacement, and that the backup inventory includes the state needed for fresh-host recovery. Test actual restore behavior on a disposable Linux deployment when that work is authorized.

For release changes, inspect both CI and `.github/workflows/release.yml`. Version matching, archive checksums, and provenance do not prove that the tagged commit passed tests. Retain build identity and verify the artifact corresponds to the tested revision.

## Live verification

Use [privacy model](pi-dns-warden/docs/privacy-model.md), [Raspberry Pi validation](pi-dns-warden/docs/raspberry-pi-validation.md), and [deployment reference](pi-dns-warden/docs/deploy-reference.md) for the requested target. Confirm the edition, topology, and maintenance scope from available context before mutation. Separate configuration validity, runtime health, DNS functionality, and fail-closed evidence in the result.

Prefer bounded existing workflows over a new generalized skill or framework. If a workflow becomes a reusable installed skill later, keep its trigger narrow and link this playbook instead of copying all project instructions.
