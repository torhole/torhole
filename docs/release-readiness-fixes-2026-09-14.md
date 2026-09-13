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

- 214 backend and integration tests passed, including actual Compose dotenv
  round trips, localhost Ansible fixtures, and disposable Docker recovery.
- UI typecheck, production build, and all 59 mocked browser tests passed.
- npm audit reported zero vulnerabilities after the lockfile refresh.
- Six shell suites passed in a disposable checkout.
- The bootstrap Python module layout and credential codec passed an isolated
  Python 3.12 container import check.
- Each of the seven findings was exercised by a failing regression before its
  correction. Independent review found no new concrete regression.

## Credential compatibility

Ansible, backend updates, and setup receipts use the same literal-value codec.
Punctuation is escaped for Compose, without shell evaluation. Double-quoted
`$$` follows Compose's literal-dollar convention; existing hand-edited values
using a different interpretation should be checked before updating credentials.
Newline and NUL values are rejected. Ordinary generated credentials are
unchanged.

## Deployment boundaries

Code regressions and disposable integration tests establish the corrected
behaviors, not complete device readiness. Before broad rollout, require hosted
CI on the actual PR revision and perform the remaining target-host checks:

1. Persist and verify the staging host resolver configuration through reboot.
2. Exercise uncached DNS during a controlled Tor outage with packet evidence,
   then verify recovery on every active plane.
3. Restore a complete backed-up stack on a disposable target and verify its
   authentication state, DNS configuration, and runtime behavior.
4. Exercise external VLAN clients and the editions/architectures intended for
   deployment, including a live Home installation where applicable.
5. Record image digests and deploy to one canary device with a tested rollback
   before extending the rollout.

These corrections do not authorize or perform a production rollout. Mutable
upstream image tags remain a release reproducibility limitation.
