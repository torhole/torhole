# Maintenance fixes — 2026-09-13

Implemented against the existing working tree, preserving the earlier validation
and dashboard work. The initial inspection and local verification preceded
commits and deployment; the staging follow-up is recorded below. The local review bundle under `scratch/review-fixes-2026-09-13/`
contains separate patches relative to the saved starting tree, so the earlier
uncommitted changes are excluded. Apply those patches only to that starting
state, not to this already-updated checkout.

## Review units

| Patch | Change | Regression evidence |
| --- | --- | --- |
| 01 recovery | Preflight before shutdown/replacement; validated shared staging; required restore files, metadata, nested payloads and link boundaries; Authelia included | 20 isolated recovery tests; real SQLite backup into a fresh Docker volume; missing bind payload leaves existing data intact |
| 02 configuration transactions | Serialize writes and rollback across backend threads; private unique temporary/backup files; matching literal dotenv parsing/encoding | Concurrent saves retain both values; rollback cannot erase another save; quoted/backslash credentials and command substitution round-trip safely |
| 03 Pi-hole failures | Import the connection exception and retain offline/degraded status behavior | Connection-refusal and malformed-response regressions |
| 04 Home DNS | Decode actual answer count; reject failed, truncated and mismatched responses | CNAME plus A, multiple answers, DNS failure and malformed response tests |
| 05 Tor control | Check each command response after authentication | Later command failures and incomplete replies are rejected |
| 06 dashboard reporting | Failed polls hide old health claims and retain last-success time; quick actions inspect domain results | Good → failed → recovered polling on four screens; HTTP 200 with failed/unavailable results; circuit error label |
| 07 website feedback | Clipboard rejection reports failure | Rejected, unsupported/failing fallback, and successful copy cases |
| 08 deployment entrypoints | Backup before update rendering and Ansible sync; shared deployer; preserve unspecified generated secrets | Backup failure aborts mutation; both topologies; real localhost Ansible modules with harmless deploy/backup executables |
| 09 CI and documentation | Release depends on same-revision reusable CI; integration job; broader syntax/lint coverage; render Caddy include before validation; refreshed operator guides | CI dependency contract; invalid control-helper syntax fails; Caddy include exists before validation; native Caddy/Prometheus validators |

All ten original priority findings are covered by these groups: findings 1 and
3 map to recovery; 2 and 9 to dashboard reporting; 4 and 5 to deployment
entrypoints; 6 to configuration transactions; 7 to Pi-hole failures; 8 to Home
DNS; and 10 to Tor control. Website feedback and CI/documentation are additional
improvements, which is why the nine groups do not correspond one-to-one with
the ten findings.

The failures were reproduced before the corresponding corrections. Follow-up
tests also exposed the container staging-path issue, link boundary cases,
quoted credential mismatch, and missing Caddy CI include, which are included in
the fixes. Existing assertions tied to raw dotenv formatting were replaced with
loader round-trip and non-execution assertions.

## Verification

| Suite | Result |
| --- | --- |
| Backend, bootstrap, Home, helper, exporter | 158 passed |
| Monitoring dashboards | 10 passed |
| Recovery preflight and coverage | 20 passed |
| Maintenance and Ansible template checks | 8 passed |
| CI contract and executable configuration checks | 3 passed |
| Real localhost Ansible fixtures | 2 passed, including both topology values |
| Disposable Docker recovery | 2 passed |
| Local mocked browser suite | 39 passed |
| Six shell suites | Passed |
| UI typecheck and production build | Passed |
| ShellCheck, Actionlint, native Caddy/Prometheus validation | Passed |

The Python and integration total is 203 tests. Native Caddy validation uses
synthetic authentication/TLS snippets, as CI does. Test Docker volumes have
unique names and are removed by the tests. Ansible uses temporary installations,
real modules, stub backup/deploy commands, and removes root ownership settings
from its fixture so it can run unprivileged. The UI build refreshes ignored
generated assets. Non-blocking tooling messages included Node's module-loader
deprecation warning and Caddy's existing formatting warning.

## Staging follow-up

The work was committed in twelve reviewable changes, ending at `12c1b6a`, and
that source revision was deployed to the existing Advanced VLAN test VM using
`deploy.sh --skip-prereqs`. The first three commits preserve the earlier agent
instructions, validation experience, and Glance/navigation changes separately
from the nine maintenance fixes. No remote push or release publication occurred.

The test VM runs Debian 13 with Python 3.13.5. A Proxmox filesystem snapshot and
the installed version's recovery archive were created before source replacement.
The archive contains the previous version's backup coverage; the VM snapshot
provides the broader rollback point. The VM remains running for further testing.

| Target-host check | Result |
| --- | --- |
| Recovery, configuration concurrency, Pi-hole failures, Home DNS, Tor control, deployment-entrypoint regressions | 51 passed |
| Disposable Docker SQLite recovery and missing-payload preservation | 2 passed |
| UI production build and native configuration validation | Passed |
| Validation through the rebuilt administration API | All 10 checks reported success |
| API image/source comparison | Backend modules matched the installed source |
| Live invalid-archive restore | Rejected before downtime; error reported; container IDs/start times and sampled source/environment hashes unchanged |
| Post-deployment privacy verification | Both Pi-hole planes resolved; Tor egress confirmed; control authentication passed; dnscrypt networks remained internal |
| IP recovery authentication | Unauthenticated request rejected; authenticated request succeeded |
| Final runtime state | All 19 stack containers running; declared health checks healthy |

The live rejection test restored the preceding recovery-status file after
asserting the expected error, so its synthetic failure does not remain in the UI.
The disposable recovery drill did not restore or replace the installed volumes.

Deployment initially failed because the VM's configured host resolver was
unavailable. A temporary systemd-resolved override routes host DNS through the
working staging Pi-hole on its Docker bridge. Build containers additionally
needed narrowly scoped temporary DNS rules to reach that Pi-hole. Those firewall
rules were removed before the final privacy verification; no direct upstream DNS
fallback was introduced. The host resolver override remains runtime-only and
will be lost on reboot. A working persistent host resolver is still needed for
future unattended builds and updates.

## Operational limits

- Both staging DNS planes and Tor egress were checked, but external VLAN clients,
  deliberate Tor-outage injection, reboot/soak, and full installed-volume restore
  were not exercised. Home had regression coverage, not a live Home deployment.
- Backend transaction locking coordinates one server process. Do not edit
  configuration concurrently through independent host-side deployment tools.
- Backups capture running volume files. A planned quiesced backup or host/VM
  snapshot is still needed when cross-database application consistency matters.
- The direct updater cannot recover source replaced before its invocation.
  Advanced instructions now require a backup before downloading source; Ansible
  backs up the installed tree before synchronization.
- Restores reject unsupported/incomplete layouts and invalid preflight inputs
  before shutdown. A later disk, runtime, or validation failure still needs
  operator recovery from the safety archive; automatic rollback was not added.
- Older backups cannot supply an omitted Authelia database. Make a fresh backup
  after upgrading. Idle SSE cleanup remains a separate follow-up.

See [testing](../README-TESTING.md), [Ansible](../README-ANSIBLE.md), and
[release integrity](../pi-dns-warden/docs/release-integrity.md) for maintained
commands and deployment boundaries.


## Dashboard follow-up

The Glance page framing, typography, and panel surfaces are now shared across
Privacy, Operate, Configure, Setup, and About. Privacy now has three routed
pages beneath a shared top menu: DNS leak test, Live query feed, and Tor
circuits. Each page opens at the top with its own content. Sidebar links,
reloads, and browser history preserve the selection; old `?section=` bookmarks
redirect to the new routes. Snapshot refreshes preserve the reading position,
and Back to top remains available on long pages. Leaving Live query feed
closes its browser connection.

The exit-check description states that it verifies the test request's Tor
exit, rather than claiming that one successful request proves the route of
every DNS query.

Verification: typecheck and production build passed; the 49-test mocked browser
suite passed, plus a focused connection-cleanup regression. Visual checks
covered both themes at 1024px and 1440px; Privacy navigation regressions use a
1024×600 viewport. The dashboard retains its existing 1024px minimum width.
Live staging verification checks that the authenticated dashboard serves the
exact built bundle.
