# Live Playwright testing on a dedicated runner

Hosted CI already runs bootstrap browser tests and isolated Ansible/recovery
integration. The separate live Playwright suite requires a reachable Torhole
deployment with authentication. There is currently **no checked-in `e2e.yml`
workflow** or automatic self-hosted live test gate.

Release publication depends on the reusable hosted CI workflow. Neither that
workflow nor the live UI suite proves DNS remains fail-closed during a Tor
outage; use the live drill in [the testing guide](../../README-TESTING.md).

## Test host and deployment

Use a dedicated test deployment and a runner that can resolve and reach its
named HTTPS endpoints, including the authentication redirect host. Install the
Node version used by CI, then install project dependencies and the Playwright
browser dependencies on that host. The runner does not need Docker or root
access merely to drive the browser against a remote deployment.

The live suite serializes actions because some tests mutate shared state.
Choose the deployment deliberately and avoid running concurrent live suites
against it. Use dedicated test credentials where the deployment supports them.

## Run manually first

From a reviewed checkout:

```bash
cd pi-dns-warden/monitoring/torhole-ui
npm ci
npm run test:e2e:install
cp tests/.env.test.example tests/.env.test
# Set TORHOLE_BASE_URL, TORHOLE_TEST_USER, TORHOLE_TEST_PASSWORD privately.
chmod 600 tests/.env.test
npm run test:e2e
```

Install browser system dependencies appropriate to the runner OS if Playwright
requests them. Set the base URL explicitly; do not rely on the configuration's
fallback deployment. Do not commit credentials or saved browser sessions.

The current live config ignores HTTPS certificate errors for local CA setups.
A pass therefore does not establish certificate trust. Test trust separately
when validating a production certificate deployment.

## Optional GitHub runner integration

If adding a workflow, make it a deliberate repository change and review its
triggers, checked-out ref, secrets, and artifact retention. Register the runner
using the commands provided by the repository's **Settings → Actions → Runners**
page. Use a dedicated label and ensure the workflow selects it.

Keep execution restricted to reviewed code and trusted operators. Do not add an
unrestricted fork pull-request trigger to a runner with LAN access and live
deployment credentials. A manual trigger alone is insufficient if it allows an
unreviewed ref to execute with those credentials. Use a dedicated unprivileged
runner account and isolate the host from unrelated services and secrets.

Supply `TORHOLE_BASE_URL`, `TORHOLE_TEST_USER`, and `TORHOLE_TEST_PASSWORD` through
the workflow environment/secrets mechanism. Do not interpolate secrets into
shell command text. The Playwright configuration accepts environment variables,
so a workflow need not write a credential file. Remove saved authentication
state after the run and limit retention of traces/screenshots that may expose
administrative data.

## Troubleshooting

- If the browser cannot reach the site, check name resolution and routing from
  the runner to both the application and authentication hosts.
- If authentication fails, verify the configured URL and account against the
  designated test deployment; inspect test output without sharing secrets.
- If a configured workflow remains queued, check its runner labels and that the
  registered runner is online. This repository does not supply that workflow.
- If the UI suite passes but DNS behavior is uncertain, run the separate network
  checks. UI success is not evidence of upstream privacy or outage behavior.
