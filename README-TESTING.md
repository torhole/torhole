# Quick test checklist (Linux VM)

1) Deploy: `ansible-playbook -i inventory.ini ansible/playbook.yml`
2) DNS functional: `dig @192.168.1.53 example.com` returns A record, no SERVFAIL.
3) Blocklists: query an ad domain and expect 0.0.0.0.
4) Tor path topology:
   `docker network inspect pi-dns-warden_dns_int` shows `"Internal": true`
   `docker inspect dnscrypt-trusted --format '{{json .NetworkSettings.Networks}}'` shows only `pi-dns-warden_dns_int`
   `docker inspect tor --format '{{json .NetworkSettings.Networks}}'` shows `pi-dns-warden_dns_int` and `pi-dns-warden_tor_out`
5) Tor config: `docker exec tor tor --verify-config -f /etc/tor/torrc` succeeds.
6) Tor health: in Grafana "Pi DNS Warden - Control Room", Tor SOCKS reachability should be healthy.
7) Path visibility: in Grafana "Pi DNS Warden - DNS Path", Pi-hole UDP and dnscrypt TCP probes should be green across all three roles.
8) Tor visibility: in Grafana "Pi DNS Warden - Tor Traffic & Runtime", Tor RX/TX and dnscrypt demand into Tor should move when DNS traffic is generated.
9) Alerting: run `./ops/scripts/17-render-alertmanager.sh` and verify `docker logs --tail 50 alertmanager` stays clean when `ALERT_EMAIL_*` and/or `ALERT_TELEGRAM_*` are configured.
10) Failure-mode check: temporarily stop `tor`; DNS lookups through Pi-hole should fail until `tor` starts again.
11) Latency: p95 < 3s on LAN; acceptable if Tor adds <5s.
12) Container health: Grafana "Pi DNS Warden - Control Room" should show restart count 0 in the last 24h under normal operation.
