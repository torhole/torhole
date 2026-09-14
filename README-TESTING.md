# Testing Torhole

Hosted CI runs backend and configuration regressions, UI build checks, browser
coverage for bootstrap options, and isolated deployment/recovery integration.
It does not deploy the complete DNS stack or prove DNS remains fail-closed during
a live Tor outage. Release tags call the same reusable CI workflow and publish
only after its jobs pass.

## Fast local checks

Run from the repository root:

```bash
git ls-files -z -- '*.sh' | xargs -0 shellcheck --severity=warning
python3 pi-dns-warden/ops/tests/test_recovery.py
python3 pi-dns-warden/ops/tests/test-maintenance-entrypoints.py
python3 pi-dns-warden/ops/tests/test_ci_contract.py
```

Maintenance tests use temporary directories and fake host commands. The CI
contract check requires PyYAML. Ansible template checks also require Jinja2;
without those libraries the template checks skip. CI installs Ansible, which
supplies both. `test_recovery.py` exercises archive validation and restore preflight without changing a
real installation. It also checks cached-image preflight and restored directory
permissions under a restrictive `umask 077`.

The complete command list is maintained in `.github/workflows/ci.yml`. It also
runs backend, bootstrap, Home, control-helper and exporter tests, shell loader
and installer tests, topology/security checks, and configuration validators.
Some render tests overwrite generated files: run the full workflow in a clean
checkout or disposable copy instead of an installed stack.

## Isolated integration

Install the Ansible tooling/collection selected by CI, then run:

```bash
python3 pi-dns-warden/ops/tests/test-ansible-integration.py
```

This uses real localhost Ansible modules and rsync against temporary
installations. It covers backup-before-sync ordering, both topology values,
secret preservation, exclusions, deployment handoff, and aborting when backup
fails. Only root ownership fields are removed from the fixture role for
unprivileged runners; deployment and backup commands are stub scripts. No Docker
stack, VLANs, or production systemd units are created.

For the opt-in Docker recovery drill:

```bash
docker pull python:3.12-slim
TORHOLE_RUN_DOCKER_TESTS=1 python3 pi-dns-warden/ops/tests/test_recovery_integration.py
```

It creates uniquely named disposable volumes and a small SQLite fixture, checks
that authentication database state survives restoration into a fresh volume,
and checks missing payloads do not erase existing volume contents. It uses the
actual recovery helpers and removes its test volumes. It does not boot Authelia
or the DNS stack. Docker access and host bind-mount support are required.

The sign-out integration fixture runs the real Caddyfile with synthetic
configuration, a disposable local CA, and a stub authentication gate:

```bash
docker pull caddy:latest
TORHOLE_RUN_DOCKER_TESTS=1 python3 pi-dns-warden/ops/tests/test_caddy_integration.py
```

It checks configured auth hosts and aliases, logout after session expiry, and
HTML cache headers without contacting a deployment. The browser suite separately
checks the HTTPS Sign out button on custom dashboard hostnames.

## UI and browser checks

```bash
cd pi-dns-warden/monitoring/torhole-ui
npm ci
npm run typecheck
npm run build
npm run test:e2e:install
npm run test:e2e:bootstrap
```

Bootstrap browser tests run in hosted CI with isolated fixtures. The separate
`npm run test:e2e` suite requires an explicitly configured reachable deployment
and credentials; see [contributing](pi-dns-warden/CONTRIBUTING.md) and
[self-hosted testing](pi-dns-warden/docs/self-hosted-runner.md).

## Live DNS validation

Use a disposable Linux deployment or an agreed maintenance window. Live tests
can interrupt DNS for clients using the test server.

1. Deploy the selected Advanced topology and run
   `bash ops/scripts/21-verify-privacy.sh` on that host.
2. From a LAN client, query the Trusted DNS address and, in VLAN mode, the IoT
   address. Verify resolution and a known configured blocklist entry.
3. Confirm each active dnscrypt container is attached only to the internal DNS
   network, and Tor has its separate outbound network.
4. For an outage drill, record the initial state, temporarily stop Tor, and
   query previously uncached names on each DNS plane. Cached replies are not
   evidence of a leak or a failed test. Observe upstream traffic while testing;
   there must be no direct DNS escape path. Restore Tor even if a check fails,
   then verify successful resolution and service health again.
5. Record the topology, image versions, query/cache conditions, packet evidence,
   and result. A successful hosted CI run does not substitute for this drill.

Latency and restart behavior should be measured on the actual network rather
than inferred from fixture tests or assigned a universal Tor latency threshold.
