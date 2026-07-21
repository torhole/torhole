# Changelog

All notable changes to torhole are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-21

### Added
- Public product website with animated privacy topology, real administration UI
  captures, responsive light and dark themes, and Cloudflare Worker deployment
  configuration
- GPL v3 license
- `docs/privacy-model.md` — threat model and trust boundary documentation
- `docs/architecture.md` — prose architecture reference
- `docs/resolvers.md` — resolver selection guide
- `CONTRIBUTING.md` — contributor guide
- `.github/` — issue templates and CI workflow
- Genericized `.env.example` (removed all personal/site-specific values)

### Changed
- Replaced MIT stub license with GPL v3
- Grafana: `AUTO_ASSIGN_ORG_ROLE` changed from `Admin` to `Viewer`; sign-up disabled
- Dockhand replaced with Watchtower (optional, disabled by default)

### Removed
- Guest DNS plane. The stack is now two planes — Trusted and IoT. Removed the
  `pihole_guest`/`dnscrypt_guest` services, `macvlan_guest` network, guest VLAN
  interface, all `*_GUEST` env vars, guest Caddy vhosts, guest Prometheus/Grafana
  targets, and the guest plane from the backend and admin UI.
- Internal planning documents (`ADMIN-FEATURE-MATRIX.md`, `ADMIN-IMPLEMENTATION-PLAN.md`)
- Personal backup archives from repository

## [0.1.0] — 2026-02-15

### Added
- Initial stack: 3× Pi-hole + 3× dnscrypt-proxy + Tor, one per VLAN (Trusted/IoT/Guest)
- `dns_int` internal bridge — no outbound route from dnscrypt containers
- `tor_out` as sole egress bridge
- SOCKS auth circuit isolation per VLAN (`IsolateSOCKSAuth`)
- Pi-hole macvlan attachment per VLAN for real IP presence on each segment
- Full monitoring: Prometheus, Grafana, Loki, Alloy, blackbox-exporter, node-exporter, cAdvisor, pihole-exporter, Alertmanager
- Caddy reverse proxy + Authelia session gate for all admin routes
- systemd watchdog timer (host-level, outside Docker)
- `deploy.sh` one-command bootstrap with VLAN sub-interface creation
- Alert channels: email, Telegram, Discord
