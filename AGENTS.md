# Torhole agent instructions

Version 1.0 — 2026-09-13. Written for Codex with GPT-6 Astra; applicable to other capable coding agents.

## Working agreement

- For non-trivial work, state a short plan and what will verify the result before editing.
- Inspect `git status --short` first. Preserve existing edits and untracked work; review the current working tree unless the user requests a particular revision.
- Complete authorized work using reasonable implementation choices. Ask only when missing information materially changes the outcome or an action needs authorization that the session has not supplied.
- A review request means inspect, verify, and recommend. Apply runtime fixes when requested; an instruction-file update does not imply permission to deploy.
- Prefer the smallest correct change. Avoid unrelated refactors, dependencies, and model-setting changes.
- If a check fails, identify the cause and adjust the next step before retrying. Distinguish application failures from unavailable tooling or sandbox restrictions.
- Delegate only complex work with independent, bounded subtasks. Keep ownership of shared files clear and verify returned findings.
- Report findings with severity, trigger, consequence, file/line evidence, and a proposed fix. Separate demonstrated defects from hypotheses.
- End with a short account of changes, verification, and remaining risks. Do not imply local tests prove a live deployment works.

## Project constraints

- Torhole protects upstream DNS handled by Pi-hole through dnscrypt-proxy and Tor. It does not tunnel ordinary application traffic or provide complete anonymity.
- Preserve the Tor-only upstream path and per-plane isolation. Do not introduce direct-DNS fallback to make a health check pass. Green container status alone is not privacy evidence.
- Treat **edition** (Home/Advanced) and **topology** (single-LAN/VLAN) as separate dimensions. Check Home, Advanced single-LAN, and Advanced VLAN when shared behavior changes.
- Missing, failed, or stale measurements must remain distinguishable from successful verification. HTTP success does not necessarily mean a privacy test or validation passed.
- Keep privileged host operations behind the existing narrow command interfaces. Preserve authentication, input validation, confirmation controls, and secret redaction.
- Use `ops/lib/load-env.sh` for deployment environment loading; do not source environment files as executable shell code.
- Use the topology-aware Compose helpers for Advanced operations. Raw Compose calls can omit the VLAN profile and its IoT services.
- For recovery changes, validate archive contents before stopping services or replacing files; account for persistent volumes and a usable rollback path.
- Never commit or print local credentials, environment values, private keys, authentication cookies, query histories, or backup contents. Use example configuration and temporary fixtures for tests.
- Follow existing ignore rules for private operational assessments (`AUDIT-*.md`) and local state. Do not force-add these files to publish review findings.

## Where to work

| Area | Entry points |
| --- | --- |
| Guided installation | `get-torhole.sh`, `install.sh`, `pi-dns-warden/bootstrap/` |
| Home | `pi-dns-warden/docker-compose.quickstart.yml`, `pi-dns-warden/home-dashboard/` |
| Advanced deployment | `pi-dns-warden/deploy.sh`, `pi-dns-warden/ops/scripts/`, main and monitoring Compose files |
| Administration API | `pi-dns-warden/monitoring/backup-manager/` |
| Privileged controls | `pi-dns-warden/control-helper/`, `pi-dns-warden/bootstrap/host_runner.py` |
| Admin UI | `pi-dns-warden/monitoring/torhole-ui/` |
| Monitoring | `pi-dns-warden/monitoring/`, `pi-dns-warden/ops/tests/test-monitoring-dashboards.py` |
| Optional provisioning | `ansible/` |
| Product documentation | `README.md`, `pi-dns-warden/docs/`, `website/` |

Read the relevant section of [SKILLS.md](SKILLS.md) for checks and workflow details. Treat current code and `.github/workflows/ci.yml` as evidence when older documentation disagrees.

## Astra and skill use

Keep instructions specific to this project. Select skills by their actual task scope and load only relevant references. User instructions take precedence over skill guidelines, subject to the platform's higher-priority constraints.

If a skill causes an otherwise unexpected pause or scope change, identify the exact file and instruction and explain its relevance. Do not infer a new approval requirement from a generic checklist. Preserve the ongoing objective when the user adds corrections or asks a side question.

Run proportional verification: documentation needs link/content checks; behavior changes need tests of the affected behavior. Repeat or broaden checks only when changes, failures, or unresolved risks warrant it.

These choices follow the [official Astra prompting guidance](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices), checked 2026-09-13. This file does not select a model or change Codex account settings. Preserve historical Build Week model attribution.

## Forgejo synchronization

When synchronization is requested, first read the operator's existing `forgejo.md` memory (normally under `${CODEX_HOME:-$HOME/.codex}/memories/`) and inspect existing remotes, including the local `MinixNeoU1` project when available. Reuse verified connection details before requesting a URL. Never store credentials in memory.
