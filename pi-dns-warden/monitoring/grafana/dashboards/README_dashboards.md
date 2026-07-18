Dashboards:
- `Pi DNS Warden - Control Room`: high-signal operator view for alerts, chain health, HTTP status mix, DNS disposition, edge request rate, resolver demand, restart anomalies, and service-state timeline.
- `Pi DNS Warden - DNS Path`: per-VLAN and per-role visibility across `Pi-hole -> dnscrypt -> Tor`, with clearer ingress-pressure, egress-demand, admin-reachability views, and role-share charts.
- `Pi DNS Warden - Tor Flow & Runtime`: Tor ingress and egress, demand into Tor, edge traffic, runtime health, latency, network error visibility, and visual Tor split/share panels.
- `Pi DNS Warden - Platform & Edge`: organized host and edge view for CPU, RAM, storage, disk IO, node networking, real reverse-proxy request telemetry, upstream health, and Tor edge traffic.
- `Pi DNS Warden - Visibility & Logs`: investigation view for edge denials, query and upstream mix, client and upstream volume leaders, proxy latency, and live logs from the resolver path and control plane.

Telemetry now available to use in dashboards:
- Prometheus metrics for the reverse proxy (`caddy_*`)
- Authenticated Pi-hole v6 metrics via `pihole-exporter`
- Loki logs from Docker containers and selected host log files via Alloy
