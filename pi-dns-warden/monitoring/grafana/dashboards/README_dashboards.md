# Grafana dashboards

These six dashboards are provisioned with the Advanced monitoring stack. Torhole Home does not deploy Prometheus, Grafana, or Loki, so these dashboards are not a Home-mode health surface.

Both Advanced topologies are supported:

- `single-lan` has one active DNS plane. Prometheus omits the intentionally absent IoT probe targets; the `trusted` metric label represents Flat LAN.
- `vlan` has separate Trusted and IoT planes. Per-role and per-target panels show both active planes.

Dashboard overview:

- `Pi DNS Warden - Control Room`: current alerts, Tor egress verification and age, DNS availability, metrics freshness, selected-range HTTP/DNS composition, and service timelines.
- `Pi DNS Warden - DNS Path`: per-plane Pi-hole and dnscrypt availability, latency, query disposition, workload, and the independent Tor SOCKS egress check.
- `Pi DNS Warden - Tor Flow & Runtime`: Tor egress verification, verification age, control-port state, bootstrap/directory/circuit state, traffic, latency, and errors.
- `Pi DNS Warden - Edge & Egress`: HTTP-or-HTTPS reverse-proxy reachability, Caddy request/latency/upstream state, Tor edge traffic, and Tor egress verification.
- `Pi DNS Warden - Visibility & Logs`: edge errors and denials, selected-range DNS status/type/reply mixes, bounded control-plane logs, and actionable Loki failure/discard metrics. Forwarded-upstream panels are intentionally omitted because the live exporter does not expose trustworthy forwarded-resolver series.
- `Pi DNS Warden - Host Infrastructure`: host CPU, memory, disk, normalized load, IO, and selected physical-interface traffic.

## Status semantics

- `Tor egress verification` uses the compatibility-named scheduled leak test: it sends an independent request through Tor SOCKS and checks whether the remote service observes a Tor exit. It does **not** trace a DNS query through Pi-hole or dnscrypt, so it must not be described as end-to-end DNS proof.
- Port reachability, DNS answers, traffic volume, circuit counts, and the independent Tor egress check are complementary evidence. The topology guarantee still comes from the enforced Pi-hole → dnscrypt → Tor network path.
- Current-state cards use instant Prometheus queries. Missing critical health data is rendered as failed or unknown instead of reusing an older value from the dashboard time range.
- Availability panels include only targets configured for the active topology. Historical panels may have gaps; missing rows are not proof of health.
- Blocking ratio, traffic volume, request volume, and log ingest volume are workload characteristics. They intentionally do not use red/green health thresholds.

## Privacy and operator focus

Default dashboards avoid client-name/IP leaderboards and raw resolver log panels. Those data can contain locally identifying DNS-client information and should be queried deliberately in Pi-hole, Prometheus, or Grafana Explore by an authorized operator.

Noisy implementation counters and duplicate visualizations are omitted from the default views. Dashboard and health-panel links point to the operator guide and privacy verification procedure for remediation context.

Telemetry sources:

- Caddy reverse-proxy metrics (`caddy_*`)
- Authenticated Pi-hole v6 metrics from `pihole-exporter`
- Tor runtime and scheduled leak-test metrics from `backup-manager`
- Node Exporter and cAdvisor host/container metrics
- Loki logs shipped by Alloy
