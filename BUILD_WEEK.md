# Torhole — OpenAI Build Week build record

This document distinguishes the work completed during the OpenAI Build Week
submission period and explains how Codex and GPT-5.6 contributed. The public
repository history begins on July 18, 2026, inside the submission window. If
private experiments or the underlying Torhole concept predated July 13, only
the work documented here should be considered for judging.

## What was built during Build Week

- A single guided installer that lets an operator choose Home or Advanced.
- A Home experience with one understandable, live privacy proof and safe
  allowlisted controls.
- An Advanced experience supporting both a flat LAN and isolated Trusted/IoT
  VLAN planes without changing the privacy guarantee.
- A canonical React administration UI covering privacy proof, Tor circuits,
  leak testing, operations, recovery, configuration, and monitoring links.
- Fail-closed network topology and runtime checks that verify only Tor has an
  internet-capable egress path for upstream DNS.
- A full Grafana and Prometheus audit against a disposable Advanced VM,
  including corrected Tor version, traffic counters, alert semantics,
  topology-aware panels, missing-data behavior, and actionable remediation.
- Public-release documentation, installation testing, security checks,
  updated live screenshots, and a reproducible container-update workflow.

## How Codex and GPT-5.6 were used

Codex served as the implementation and verification partner across the
repository. It traced behavior through Bash, Python, TypeScript, Compose,
Prometheus rules, and Grafana dashboards; proposed focused changes; generated
and updated tests; built the UI; and diagnosed failures using live container,
API, metrics, and browser evidence.

The human operator remained responsible for the important product decisions:
the narrow DNS-privacy promise, fail-closed behavior, Home versus Advanced
capabilities, acceptable operational risk, and whether each release change
matched the intended experience. Codex did not replace those decisions; it
made them faster to implement and easier to verify across the full system.

The primary Codex build task should be submitted with its `/feedback` session
ID as required by the challenge. The dated Git history provides an additional
record of the work performed during the submission window.

## Dated repository evidence

| Date | Evidence |
|---|---|
| July 18 | Initial public release plus clarified privacy model, editions, and host preparation |
| July 19 | Installer proof, credential handling, shallow-install updates, and complete Home/Advanced setup flows |
| July 20 | Unified installer and admin experience, canonical UI lifecycle, privacy-aware monitoring audit, Tor metrics repair, responsive release polish, and live VM validation |

## Live verification

The release candidate was tested on disposable Proxmox virtual machines in
both Home and Advanced single-LAN modes. Advanced validation included all
Prometheus targets and alert rules, every provisioned Grafana dashboard query,
Tor control-port metrics, the DNS leak test, container health, and checks that
client-identifying metrics and resolver query logs were not exported into the
monitoring stack.
