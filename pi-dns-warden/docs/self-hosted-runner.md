# Self-hosted Playwright runner

The hosted GitHub Actions workflow (`.github/workflows/ci.yml`) runs typecheck, build, and static validation on every PR. It does **not** run the Playwright end-to-end suite — those tests need the full 14-container Torhole stack running behind Authelia, which isn't practical on hosted Ubuntu runners.

This guide walks through setting up a dedicated self-hosted runner that executes the `e2e.yml` workflow against a live Torhole deployment.

## What you need

- A VM (or a second Pi) on the same LAN segment as the Torhole deployment you want to test against — the runner needs to resolve `th-torhole.<your-domain>` and pass Authelia
- **Ubuntu 22.04+** recommended (runners work on Debian, Fedora, Alpine too, but most dependency guides assume Ubuntu)
- At least **2 vCPU, 4 GB RAM, 20 GB disk** — Node + Playwright browser downloads + test artifacts
- Outbound network to `github.com` (for runner heartbeat and checkout)
- Inbound network to your Torhole stack over HTTPS (same LAN is easiest)

## Security caveats — read before provisioning

1. **A self-hosted runner trusts every push to `main`.** Anyone who can merge code can execute arbitrary commands on the runner host. Keep `main` behind branch protection with required reviews.
2. **Never run a self-hosted runner in a public repo.** A stranger's fork PR can trigger workflows, and by default their code runs on your runner. This is well-documented as the [GitHub Actions pwn request](https://securitylab.github.com/research/github-actions-preventing-pwn-requests/) class of vulnerabilities. If you open-source Torhole and want self-hosted E2E, restrict the `e2e` workflow to push events from maintainers only (use `workflow_dispatch` + maintainer allowlist).
3. **Dedicated VM, not your workstation.** The runner gets the repo's secrets (TORHOLE_BASE_URL, test credentials). If the runner VM is compromised, the attacker has everything on it.
4. **Treat the runner as ephemeral-ish.** Rebuild the VM periodically, or use the `ephemeral` mode (one job per runner registration — slower but far safer).

If any of these feel shaky, **stick with the hosted `ci.yml` workflow** and run Playwright manually on your Mac from `monitoring/torhole-ui-v2` via `npm run test:e2e`. That's what I've been doing this whole time, and it works fine.

## Provisioning the runner VM

```bash
# On a fresh Ubuntu 22.04 VM
sudo apt update && sudo apt install -y \
  curl git ca-certificates \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
  libpango-1.0-0 libcairo2

# Node.js 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Dedicated runner user — never run the runner as root
sudo useradd -m -s /bin/bash torhole-runner
sudo mkdir -p /opt/actions-runner
sudo chown torhole-runner:torhole-runner /opt/actions-runner
```

## Registering the runner with GitHub

1. Go to your repo on GitHub → **Settings → Actions → Runners → New self-hosted runner**
2. Pick **Linux x64**, copy the download + config commands GitHub shows you
3. Run them as the `torhole-runner` user (not root):

```bash
sudo -u torhole-runner -i
cd /opt/actions-runner

# paste the download block from the GitHub UI — something like:
curl -o actions-runner-linux-x64-<version>.tar.gz -L https://github.com/actions/runner/releases/download/<tag>/actions-runner-linux-x64-<version>.tar.gz
tar xzf actions-runner-linux-x64-<version>.tar.gz

# paste the config command, but ADD the label flag:
./config.sh \
  --url https://github.com/<owner>/<repo> \
  --token <one-time-token-from-github> \
  --labels torhole-e2e \
  --unattended \
  --ephemeral
```

The `--labels torhole-e2e` line is important — the `e2e.yml` workflow selects runners with this label. Without it the workflow won't pick up the runner.

`--ephemeral` means each job unregisters the runner after it finishes. Safer. You'll need to re-register with a new token next run — automate with a loop or use the GitHub JIT runner API. For a hobby setup, skip `--ephemeral` and just rebuild the VM periodically.

## Installing as a systemd service

```bash
# Back as your admin user
sudo /opt/actions-runner/svc.sh install torhole-runner
sudo /opt/actions-runner/svc.sh start
sudo /opt/actions-runner/svc.sh status
```

The runner will now show up in **Settings → Actions → Runners** as "Idle" and will pick up any job that targets `runs-on: [self-hosted, torhole-e2e]`.

## Setting the required secrets

In **Settings → Secrets and variables → Actions → New repository secret**, add:

| Name | Value |
|---|---|
| `TORHOLE_BASE_URL` | `https://th-torhole.<your-domain>` (must be reachable from the runner) |
| `TORHOLE_TEST_USER` | Authelia username with admin privileges (dedicated test account recommended, not your real admin) |
| `TORHOLE_TEST_PASSWORD` | Password for that account |

The workflow's "Write tests/.env.test from secrets" step assembles these into the file format Playwright's global setup expects. Using `env:` + `printf` (not `${{ }}` inlined directly in shell) keeps GitHub's escaping layer between the secret and the shell, per the [Actions injection prevention guide](https://github.blog/security/vulnerability-research/how-to-catch-github-actions-workflow-injections-before-attackers-do/).

## First run

1. Merge `e2e.yml` to `main`
2. Go to **Actions → e2e → Run workflow** (manual dispatch is enabled by default)
3. Watch the job land on your runner, install chromium, and run the suite
4. If Authelia rejects the login, triple-check `TORHOLE_TEST_USER` + `TORHOLE_TEST_PASSWORD` against a fresh `curl` against `TORHOLE_BASE_URL/api/verify`

Once a couple of dispatches pass cleanly, uncomment the `pull_request:` trigger in `e2e.yml` so PRs exercise the suite automatically. Until then, the workflow is dispatch-only — no PR gets auto-dispatched against the runner.

## Unregistering

```bash
sudo -u torhole-runner -i
cd /opt/actions-runner
sudo /opt/actions-runner/svc.sh stop
sudo /opt/actions-runner/svc.sh uninstall
./config.sh remove --token <unregister-token-from-github>
```

## Troubleshooting

### "No runner matching the specified labels was found"

The workflow targets `[self-hosted, torhole-e2e]` but no runner is registered with both labels. Re-run `config.sh` with `--labels torhole-e2e` or add the label via the repo settings UI.

### Runner is idle but the job never dispatches

GitHub requires a PR review approval to run actions on self-hosted runners when the PR is from a first-time contributor. Check **Settings → Actions → General → Fork pull request workflows from outside collaborators**.

### Playwright hangs on global-setup

The runner can't reach `TORHOLE_BASE_URL`. Check DNS resolution and firewall rules — the runner needs to hit the reverse proxy on HTTPS and follow Authelia's redirect chain. `curl -vkI $TORHOLE_BASE_URL` from the runner VM is the fastest way to confirm.

### Everything works but the runner VM gets wedged after a while

Rebuild it. A periodic `terraform destroy && terraform apply` or a cron that wipes `/opt/actions-runner/_work/` and re-registers is standard practice.
