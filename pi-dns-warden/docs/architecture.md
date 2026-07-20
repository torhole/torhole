# Architecture

## Overview

torhole creates two isolated DNS endpoints — one per network segment (VLAN) — each with its own Pi-hole for ad/tracker blocking and its own dnscrypt-proxy instance for encrypted upstream resolution over Tor.

```
                        ┌──────────────────┐
                        │     Internet     │
                        └────────┬─────────┘
                                 │
                        ┌────────┴─────────┐
                        │   tor_out bridge │  ← only outbound bridge
                        └────────┬─────────┘
                                 │
                        ┌────────┴─────────┐
                        │   Tor container  │  SOCKS auth isolation per VLAN
                        │  (cap_drop ALL)  │  IsolateSOCKSAuth
                        └──────┬──────┬────┘
                               │      │
              ─────────────────────────────────────────────────
              dns_int  (internal: true, no default gateway)
              ─────────────────────────────────────────────────
                               │      │
                   ┌───────────┘  ┌───┘
                   ▼              ▼
              dnscrypt        dnscrypt
              (trusted)        (IoT)
              :5053            :5053
                   │              │
                   ▼              ▼
              Pi-hole         Pi-hole
              trusted          IoT
            192.168.1.53   192.168.50.53
                   │              │
                macvlan        macvlan
                VLAN 1         VLAN 50
                   │              │
                   ▼              ▼
              Trusted LAN      IoT LAN
           192.168.1.0/24  192.168.50.0/24
```

## Docker networks

| Network | Type | Purpose |
|---------|------|---------|
| `dns_int` | bridge, `internal: true` | Service-to-service communication; no outbound route |
| `tor_out` | bridge | Tor's only egress path to the internet |
| `mgmt_net` | bridge | Published management ports (Prometheus, Grafana, Caddy) |
| `admin_net` | bridge, `internal: true` | Dedicated Caddy-to-Dockhand control path |
| `macvlan_trusted` | macvlan | Pi-hole trusted gets a real IP on VLAN 1 |
| `macvlan_iot` | macvlan | Pi-hole IoT gets a real IP on VLAN 50 |

The key constraint: **dnscrypt containers are only on `dns_int`**. They have no path to the internet except through Tor, which is the only container bridging `dns_int` and `tor_out`.

## DNS query path

```
Device on VLAN 1
  → Pi-hole trusted (192.168.1.53, UDP/TCP 53)
    → dnscrypt-trusted (172.30.0.11, port 5053, TCP-only)
      → Tor (172.30.0.10, SOCKS5 with auth credentials)
        → tor_out → internet
          → upstream resolver (Cloudflare / Quad9 / etc.)
```

Each VLAN uses separate SOCKS credentials (`DNSCRYPT_SOCKS_USER_*` / `DNSCRYPT_SOCKS_PASS_*`), which causes Tor to issue separate circuits per VLAN via `IsolateSOCKSAuth`. DNS queries from IoT devices cannot be linked to trusted device queries at the Tor circuit level.

## Monitoring stack

Monitoring containers that need DNS-plane visibility live on `dns_int` (no direct internet access). Published monitoring services also use `mgmt_net`. Dockhand is isolated on `admin_net`, shared only with Caddy, so workload containers cannot bypass the authenticated proxy and reach its Docker control interface directly.

```
Trusted LAN browser
  → Caddy (reverse proxy, TLS, port 443)
    → Authelia (session gate, dns_int only)
    → Torhole admin UI (/, file_server) — React SPA
    → backup-manager (/api/*, :8080)        — Python HTTP + SSE
    → Grafana / Prometheus / Alertmanager    — th-*.<domain> subdomains
```

Caddy is the single LAN entry point. All admin routes pass through an Authelia forward-auth check. Grafana and Dockhand also use application-level authentication.

### Admin UI

The admin UI is a Vite + React 19 + Tailwind 4 single-page app built from `monitoring/torhole-ui/` into `monitoring/caddy/admin-ui/`. Caddy serves the static build at the site root behind Authelia. The installed Advanced UI has four operational screens; Setup is a separate first-run bootstrap mode:

| Screen | Question it answers |
|---|---|
| **Glance** (`/`) | "Is the privacy guarantee intact right now?" Overall health + container counts + per-plane status + Quick Actions strip. |
| **Privacy** (`/#/privacy`) | "What does Torhole prove?" Live Tor runtime strip, per-plane circuit panel with rotate buttons, DNS leak test, live query feed (SSE), internal circuits tab. |
| **Operate** (`/#/operate`) | "What do I need to change?" Containers, backups, stack validation, and an Insights tab linking out to every Grafana dashboard + raw Prometheus / Alertmanager / Pi-hole admin / Dockhand. |
| **Configure** (`/#/configure`) | "What can I tune?" Identity + admin password change, topology, alert channels, full `.env` reference. |
| **Setup** (temporary bootstrap URL) | "How do I get from clone to a live stack?" Guided Home/Advanced installer that writes the selected configuration atomically and streams progress. |

All five screens read from a single `/api/system/snapshot` endpoint served by `backup-manager`. Writes go through dedicated endpoints (`/api/tor/rotate*`, `/api/leak-test/run`, `/api/recovery/*`, `/api/identity/password`, `/api/setup/apply`, etc.).

### backup-manager

The `backup-manager` container (`monitoring/backup-manager/`) is a Python stdlib HTTP server that the admin UI talks to. It:

- exposes `/api/system/snapshot` as a single cache-aware read endpoint aggregating Pi-hole, dnscrypt, Tor, container, backup, and alert state
- streams `/api/stream/queries` (Pi-hole query feed) and `/api/containers/<name>/logs` (SSE live logs)
- reads the Tor control port at `tor:9051` and re-exports as `/api/metrics/tor` in Prometheus text format (scraped as job `torhole-tor`)
- executes recovery scripts via `docker-cli-compose` from inside the container, with atomic status tracking (`run/` dir)
- owns every write path that touches `.env` — via the `update_env_keys()` atomic write helper with timestamped backups before every change
- the Tor control port authentication is the only other `.env`-derived config written into a non-container file — `ops/scripts/20-render-torrc.sh` hashes `TOR_CONTROL_PASSWORD` and writes the result between markers in `tor/torrc`, so rotating the password in `.env` and re-running deploy is the complete rotation workflow

Caddy adds a generated bearer token to proxied API requests, and `backup-manager` verifies it before routing application endpoints. Direct container-to-container requests therefore cannot bypass Authelia. `/health` and read-only `/api/metrics/tor` remain unauthenticated service endpoints.

### Grafana dashboards

Six provisioned dashboards in `monitoring/grafana/dashboards/`, all linked from Operate › Insights:

| UID | Title | Focus |
|---|---|---|
| `pidns-control` | Control Room | Top-level health, chain reachability, service state timeline |
| `pidns-path` | DNS Path | Per-plane Pi-hole + dnscrypt probe latency, query/forward/cache rates |
| `pidns-torflow` | Tor Flow & Runtime | Tor I/O, bootstrap, circuit state, entry guards — sourced from `/api/metrics/tor` |
| `pidns-platform` | Edge & Egress | Reverse proxy health, HTTPS request share, Tor edge flow |
| `pidns-visibility` | Visibility & Logs | Query status/type/reply mix, upstream share, Loki log panels, top clients |
| `pidns-host` | Host Infrastructure | node-exporter + cadvisor (CPU, RAM, disk, network) |

## Host-level watchdog

A systemd timer (`pihole-tor-prometheus-watchdog.timer`) runs outside Docker and checks that the Prometheus container is reachable on `dns_int`. If Prometheus is down for more than the threshold, it fires a Telegram or email alert. This exists because Docker cannot reliably watch itself — a crashed Docker daemon would take all container-level health checks with it.

## Compose file layout

| File | Contents |
|------|----------|
| `docker-compose.yml` | Core DNS stack: Tor, 3× dnscrypt, 3× Pi-hole, all networks |
| `docker-compose.monitoring.yml` | Monitoring: Prometheus, Grafana, Loki, Alloy, Caddy, Authelia, torhole-api, exporters |

Run both together:
```bash
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d
```
Or use `deploy.sh`, which sources `.env`, creates VLAN sub-interfaces, installs systemd units, and starts both compose files.
