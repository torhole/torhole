# Third-party software notices

Torhole is licensed under GPL-3.0-or-later. It installs, configures, links to,
or interoperates with independent third-party projects. Those projects remain
under their own licenses. Inclusion here does not imply that their authors
endorse or sponsor Torhole.

This notice is a practical attribution index, not a replacement for the license
files shipped by each project. Container images can contain additional packages
and notices. The exact installed image and package versions are authoritative
for a particular deployment.

## Privacy and DNS runtime

| Component | Role | Upstream license |
|---|---|---|
| [Tor](https://gitlab.torproject.org/tpo/core/tor) | Onion-routing client | See the upstream source and Debian package copyright notices |
| [Pi-hole](https://github.com/pi-hole/pi-hole) and [docker-pi-hole](https://github.com/pi-hole/docker-pi-hole) | DNS filtering and local DNS | EUPL-1.2, with upstream exceptions for older material |
| [dnscrypt-proxy](https://github.com/DNSCrypt/dnscrypt-proxy) | Encrypted resolver transport | ISC |
| [dnscrypt-proxy Docker image](https://github.com/klutchell/dnscrypt-proxy-docker) | Container packaging | MIT |

## Advanced operations stack

| Component | Role | Upstream license |
|---|---|---|
| [Prometheus](https://github.com/prometheus/prometheus) | Metrics storage and queries | Apache-2.0 |
| [Alertmanager](https://github.com/prometheus/alertmanager) | Alert routing | Apache-2.0 |
| [Node exporter](https://github.com/prometheus/node_exporter) | Host metrics | Apache-2.0 |
| [Blackbox exporter](https://github.com/prometheus/blackbox_exporter) | Endpoint probes | Apache-2.0 |
| [Grafana](https://github.com/grafana/grafana) | Metrics visualization | AGPL-3.0-only |
| [Loki](https://github.com/grafana/loki) | Log aggregation | AGPL-3.0-only |
| [Grafana Alloy](https://github.com/grafana/alloy) | Telemetry collection | Apache-2.0 |
| [Caddy](https://github.com/caddyserver/caddy) | Reverse proxy and local TLS | Apache-2.0 |
| [Authelia](https://github.com/authelia/authelia) | Authentication gateway | Apache-2.0 |
| [cAdvisor](https://github.com/google/cadvisor) | Container metrics | Apache-2.0 |
| [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) | Restricted Docker API proxy | Apache-2.0 |
| [Dockhand](https://github.com/Finsys/dockhand) | Optional container operations UI | Business Source License 1.1 |

Dockhand is source-available rather than OSI-approved open-source software. Its
current Additional Use Grant permits personal, internal business, non-profit,
educational, evaluation, and specified integration uses, while restricting a
commercial hosted service whose primary value is Docker management. Review its
current license before commercial or hosted deployment.

## Web and administration interfaces

The administration UI lockfile records the complete JavaScript dependency
tree. Principal browser-side components include:

| Component | Upstream license |
|---|---|
| React and React DOM | MIT |
| React Router | MIT |
| Three.js | MIT |
| Lucide | ISC |
| Vite | MIT |
| Tailwind CSS | MIT |
| Inter and JetBrains Mono | SIL Open Font License 1.1 |

Transitive packages also include software under Apache-2.0, BSD-2-Clause,
BSD-3-Clause, ISC, MIT, MPL-2.0, OFL-1.1, and CC-BY-4.0. Consult
`pi-dns-warden/monitoring/torhole-ui/package-lock.json` and the installed
packages for the exact dependency graph and license texts.

The public website currently loads Google Fonts and the MIT-licensed Three.js
r128 build from third-party content delivery networks. Their operators' terms
and privacy policies apply to those requests.

## Marks and affiliation

See [TRADEMARKS.md](TRADEMARKS.md) for the non-affiliation notice and links to
the Tor and Pi-hole brand policies.
