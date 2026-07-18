# Alerting plan (Prometheus/Grafana)

## Prometheus rules (suggested)
- `ProbeFailureRateHigh`: fire if `avg_over_time(probe_success{job=~"blackbox-.*"}[5m]) < 0.8` for 10m.
- `PiholeDown`: fire if `up{job="blackbox-dns-udp-pihole"} == 0` for 2m.
- `TorSocksDown`: fire if `avg_over_time(probe_success{job="blackbox-tor-socks"}[5m]) < 0.9` for 5m.
- `ContainerRestarts`: fire if `increase(container_restart_count_total[1h]) > 2` for any container.

Rules now live in `pi-dns-warden/monitoring/prometheus/alert.rules.yml` and are loaded via `rule_files` in `prometheus.yml`.

## Notification
- Use Grafana Alerting or Prometheus Alertmanager. For minimal setup, point Alertmanager to email/Slack/Webhook.
- Grafana: create contact point, add alert rules on dashboards (DNS p95 latency, Tor SOCKS uptime).

## Next steps
1) Alertmanager is now included. Set env vars `SLACK_WEBHOOK_URL` and `SMTP_PASSWORD` (and adjust SMTP/to/from) before starting the stack.
2) Alternatively or additionally, configure Grafana contact points for dashboard-based alerts.
3) Restart monitoring services to pick up changes.
