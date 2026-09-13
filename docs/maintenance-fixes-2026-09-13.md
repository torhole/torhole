# Maintenance fixes — 2026-09-13

Implemented against the existing working tree, preserving the earlier validation
and dashboard work. No commits, release publication, or live deployment were
performed. The local review bundle under `scratch/review-fixes-2026-09-13/`
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

## Operational limits

- Full target-host DNS, VLAN routing, Tor fail-closed behavior, reboot/soak, and
  production restore drills were not run. Hosted integration does not replace
  those checks.
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
