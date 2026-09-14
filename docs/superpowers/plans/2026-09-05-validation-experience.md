# Validation Experience Implementation Plan

> Execute inline with test-first checkpoints. Scope approved in conversation: validation preview, honest results, read-only checks, progress and failure guidance; no unrelated backup/update features.

## Design

The existing backend owns the check catalog. An authenticated GET endpoint returns applicable checks, descriptions, impact and remediation guidance without executing commands. Validation examines installed configuration, not regenerated desired configuration, and explicitly excludes live DNS/privacy assurance.

The shell runner emits explicit start/success/error markers. Missing completion evidence is never a pass. The existing POST remains compatible; an authenticated progress GET allows the UI to show actual running/queued checks. Concurrent validation is rejected. The previous result stays separate. Reports contain structured results and guidance, not unredacted command output.

## Steps

- [x] Add failing backend tests for missing markers, explicit completion, optional checks and catalog consistency. Implement the catalog/preview and honest result parsing.
- [x] Add a shell harness with fake Docker to verify every check and failure, plus unchanged configuration bytes. Remove live render/bytecode writes; use temporary validator storage and explicit completion markers.
- [x] Add backend progress and concurrency protection without changing the synchronous POST contract. Test in-progress/completed/error behavior.
- [x] Add browser regressions for preview before running, real progress, previous-result separation, failure guidance, and report download. Implement using existing UI components.
- [x] Run backend tests, shell harness, TypeScript, build and browser suite; review the diff. Leave production unchanged until this feature is verified and reviewed.

## Verification and rollout checkpoint

105 backend tests and 22 browser tests pass; TypeScript, UI build, shell syntax and diff whitespace checks pass. Independent reviewer tool was unavailable; direct diff review completed. No production deployment, commit or push performed.

### Staging smoke test (2026-09-05)

Staging deployment approved and completed. VM was stopped and was started; changed SSH host key was verified through the trusted Proxmox guest agent, then pinned in a temporary local known-hosts file. Only the backend was recreated; UI assets were published before index.html. Backend image and affected files were retained for rollback.

All 10 real-image checks passed both from the host and through the backend API. Configuration hashes were unchanged in both runs. Live queued/running/success transitions were observed; unauthorized preview returned 401 and overlapping validation returned 409. An isolated copy with invalid Prometheus YAML failed after Compose and did not run subsequent checks. Snapshot returned 200 with both DNS planes healthy; both resolved A records. Public HTTPS redirected to staging Authelia and Caddy's UI index matched the local build hash.

The normal image build initially could not resolve Docker Hub from the staging host. A code-only image was built from the retained local backend (unchanged Dockerfile/dependencies), and all 105 tests passed inside it. This validates the installed-image path, not a fresh registry-backed installation.

The host DNS issue was subsequently diagnosed and fixed with approval: UniFi deliberately blocks direct external DNS from staging, but its provisioned resolver was public DNS. Staging now uses production Torhole as its only host resolver, both live and in Netplan and Proxmox/cloud-init. Old settings were backed up; no VM/network/stack restart or firewall change was needed. Netplan's list-append behavior required clearing the old address before setting the new one; effective and persistent settings were verified. Host Docker Hub lookup, registry HTTPS (expected unauthenticated 401), and BuildKit's previously failing base-image metadata check now succeed.

The remaining clean backend build was then verified with `docker build --pull --no-cache` under a separate staging-only buildcheck tag. Base-image/dependency downloads succeeded, all 105 tests passed inside the fresh image, and all 10 real stack validation checks passed when run from that image. No running image was replaced during this verification. TypeScript and all 22 browser regressions passed again. This closes the clean backend build smoke test, not a whole-platform bare-VM installation test. Commit/PR review and production rollout remain separate steps.

The shell uses explicit start/success markers and nonzero exit status to identify the failed check (no redundant error marker). Deployment callers explicitly allow missing-image pulls; web validation never does. A five-minute web timeout prevents an indefinitely held recovery lock.

## Constraints

No new dependencies. No automatic repairs, service restarts, live-config regeneration, image pulls, or claims that syntax checks prove DNS/privacy health. Write only validation job/result metadata and temporary validator files. Preserve existing authentication on all endpoints.
