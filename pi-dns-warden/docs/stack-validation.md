# Stack validation

In Advanced, open **Operate → Stack validation** to preview the checks before running them. The list reflects optional configuration files present on the installation. Each check explains what it inspects; failures include a suggested next step.

The page uses one compact checklist: before the first run it previews checks, then shows the latest result or live progress. Expand any row for its explanation; failed rows expand automatically with corrective guidance. During a new run, the previous result is collapsed below the checklist. Longer scope and diagnostic notes live under **Scope and technical details**, while the configuration-only limitation stays visible.

This is configuration validation, **not** proof of live DNS resolution, Tor egress, leak protection, working SSO or delivered alerts. Use the dedicated privacy checks and alert tests for those behaviors.

## What a run does

- Resolves Compose definitions and validates the installed Prometheus, Alertmanager, Caddy, Authelia and Alloy configurations where applicable.
- Parses dashboard JSON and checks Python syntax without executing application code or creating bytecode.
- Uses locally available configured validator image tags, which can differ from running container images. No image pulls, service restarts or configuration regeneration occur from the web action.
- Creates temporary validator containers and writes validation result metadata. Missing bind sources fail instead of being created. Authelia validation storage is temporary.
- Stops at the first failure. Only explicit completion counts as success; later or unfinished checks are skipped, never passed.

The page polls actual progress. Previous results are shown separately during a run. Overlapping backend validation/recovery jobs are rejected. Web runs have a five-minute timeout (plus a short termination grace period); closing the browser does not cancel the server-side run. Backend restart interrupts in-memory progress tracking.

The JSON download contains check identities/statuses, timestamps and scope. Raw command output is deliberately excluded, including from legacy results. For detailed local diagnostics:

```bash
cd pi-dns-warden
sudo bash ops/scripts/19-validate-stack.sh
```

Local output can contain sensitive configuration; review it before sharing. If a required validator image is missing, obtain the configured image deliberately and retry. Deployment, startup, update and restore scripts explicitly use `--allow-image-pulls` to retain fresh-install behavior. Rendering happens in those workflows, not in the validator.

## API and rollout

- Authenticated `GET /api/system/validation`: catalog, scope, impact, current progress and previous result; does not execute validation.
- Authenticated `POST /api/system/validate`: existing synchronous execution contract. `/api/recovery/validate` remains an alias.
- Deploy the backend, shell scripts and UI together. An older backend without the preview endpoint leaves the new run button disabled rather than presenting an invented check list.

Before production rollout, smoke-test on staging with real validator images, including a fresh-install path. Local fake-daemon tests verify orchestration and unchanged files, not compatibility with every image release.
