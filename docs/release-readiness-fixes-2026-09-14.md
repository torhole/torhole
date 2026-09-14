# Release-readiness corrections — 2026-09-14

This follow-up addresses the remaining findings from the assessment of
`c369f91`. Each correction is kept in a separate reviewable commit with a
regression that exercises the reported failure.

## Scope

- Require all relevant Tor assurance signals and all active DNS planes before
  reporting that the configured privacy checks are healthy.
- Bound snapshot polling and stop presenting old measurements as fresh when
  requests hang.
- Serialize Ansible credentials in a format understood consistently by Docker
  Compose and Torhole's literal environment readers.
- Describe the scope of privacy checks accurately in both summary and result
  messages.
- Detect disconnected query-feed clients even when no new queries arrive.
- Reject missing or malformed Pi-hole statistics instead of reporting healthy
  zero measurements.
- Label the recent conclusive-test pass rate and its reporting window accurately.
- Refresh affected npm dependencies within the existing declared version ranges.

## Verification

- 230 backend and integration tests passed, including actual Compose dotenv
  round trips, localhost Ansible fixtures, and disposable Docker recovery.
- UI typecheck, production build, and all 59 mocked browser tests passed.
- npm audit reported zero vulnerabilities after the lockfile refresh.
- Six shell suites passed in a disposable checkout.
- The bootstrap Python module layout and credential codec passed an isolated
  Python 3.12 container import check.
- Each of the seven findings was exercised by a failing regression before its
  correction. Independent review found no new concrete regression.

## Follow-up from staging validation

Further regressions were found while preparing and running the recovery drill:

- Tor's control-password renderer now uses the shared literal environment
  loader before hashing. Encoded punctuation is no longer hashed as syntax.
- Restore checks that the archived stack's images and recovery helper are
  cached before shutdown. It validates without image pulls and restarts with
  `--pull never --no-build`, keeping recovery independent of the DNS service it
  is restoring. This also works with archives containing older startup scripts.
  Load missing images before restoring; preflight leaves the installation
  running when the required cache is incomplete.

- Archive extraction preserves safe directory access modes under a restrictive
  process umask. Restore copies the packaged contents without applying the
  private packaging directory's mode to the installation root. This prevents
  non-root DNS services from losing access to their configuration.

- Backup metadata listing reads a bounded 256 KiB decompressed prefix and
  limits the metadata payload to 64 KiB. It no longer scans multi-gigabyte
  archives on a cold dashboard request. Missing or late metadata remains
  unavailable; restore still validates complete archives independently.

These have separate commits and failing-before/passing-after regressions.
Recovery tests also cover legacy topology defaults and inherited image overrides.
Malformed environment files abort both hashing and recovery preflight; they do
not fall through to inherited credential values.

## Credential compatibility

Ansible, backend updates, and setup receipts use the same literal-value codec.
Punctuation is escaped for Compose, without shell evaluation. Double-quoted
`$$` follows Compose's literal-dollar convention; existing hand-edited values
using a different interpretation should be checked before updating credentials.
Newline and NUL values are rejected. Ordinary generated credentials are
unchanged.

## Staging evidence

The Advanced VLAN candidate passed a real staging reboot with its persistent
host resolver using the protected DNS stack. DNS readiness followed dnscrypt's
startup wait; container startup alone was not counted as readiness.

During a controlled Tor outage, uncached queries on both planes timed out and
packet capture observed no outbound DNS on ports 53 or 853. Both planes passed
privacy verification after Tor recovered. External clients also resolved through
both staging VLAN addresses, including a client on the IoT VLAN.

The full restore drill recovered source/configuration hashes, removed test
markers from both project files and the authentication volume, and passed
SQLite integrity checks. Its first run exposed a directory-permission regression
that prevented DNS services from reading their configuration. After the fix,
a second full restore passed without manual repairs: safe directory modes and
the installation root mode were preserved, both DNS planes resolved, Tor egress
and control authentication passed, and dnscrypt networks remained internal.
The drill used an archive of `0bc2ca0` with the recovery implementation from
`d4bcca3`, exercising compatibility with archived older startup scripts.

A subsequent cold backend restart exposed a slow snapshot response: backup
metadata lookup scanned complete compressed archives. The bounded reader in
`b5a5c61` passed six real-archive regressions. A fresh backend process against
the actual staging backups then built a healthy snapshot in 0.878 seconds,
within the dashboard's ten-second request deadline.

Final candidate `b5a5c61` was deployed and verified on staging. All 19 services
were running, configured container health checks passed, and the authenticated
snapshot reported healthy with the expected revision. Running backend source
hashes matched the candidate; image identities were recorded. Temporary build
network rules were removed. External Trusted and IoT DNS checks also passed.

An isolated ARM64 run passed 175 backend and maintenance tests on a target
host without modifying its installed services. Image identities were recorded
on staging. Target inspection found local Compose and authentication-renderer
customizations; rollout must preserve these files and existing private state.

## Deployment boundaries

The live evidence above covers Advanced VLAN on staging. It does not establish
live Home behavior or completion of production rollout. Remaining gates are:

1. Hosted CI must pass on the actual PR revision.
2. Back up the canary device with the expanded coverage, preserve its local
   configuration and source customizations, then verify the deployed ARM64
   stack before updating the second device.
3. Test a live Home installation before claiming that edition is release-ready.

Mutable upstream image tags remain a release reproducibility limitation.
Container startup and configuration validation remain separate from live DNS
and fail-closed verification. Production devices have not been updated.
