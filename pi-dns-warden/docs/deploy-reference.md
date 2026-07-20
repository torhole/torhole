# Advanced VLAN reference: Pi-hole + dnscrypt-proxy over Tor + Monitoring

This reference covers `TORHOLE_TOPOLOGY=vlan`, which creates **2 local DNS endpoints**: **Trusted** and **IoT**. For a flat network with the same Advanced SSO, monitoring, logging, alerting, backup, and control stack, choose `single-lan` in the web installer.

Each VLAN uses its own Pi-hole container (static IP on that VLAN). Pi-hole forwards DNS to a dedicated **dnscrypt-proxy** instance, and dnscrypt-proxy resolves DNS **through Tor SOCKS** (TCP-only).

The stack uses an externally isolated internal Docker network for service-to-service traffic. Only the `tor` container is attached to a second outbound network, so upstream resolver traffic cannot bypass Tor by leaving directly from the `dnscrypt-*` containers.

Published management UIs use a separate `mgmt_net` bridge. This keeps Prometheus, Grafana, Dockhand, Alertmanager, and blackbox-exporter reachable from the host and your trusted LAN while leaving `dns_int` isolated.

Monitoring is included:
- Prometheus
- Grafana (auto-provisioned dashboards)
- node-exporter (host metrics)
- cAdvisor (container metrics)
- blackbox-exporter (DNS/HTTP/TCP probes)
- backup-manager (protected recovery API behind the Torhole landing page)

## Example network values
- **Host IP (Pi management):** `192.168.1.10`

**CIDRs**
- Trusted: `192.168.1.0/24`
- IoT: `192.168.50.0/24`

**Gateways**
- Trusted: `192.168.1.1`
- IoT: `192.168.50.1`

**VLAN IDs**
- Trusted: `1`
- IoT: `50`

**Resolvers (malware blocking only)**
- `cloudflare-security`
- `quad9-dnscrypt-ip4-filter-pri`

## Recommended hostname
Pick something short and easy:
- `torhole` (recommended)

## UniFi prep (high level)
1. Create the 2 networks (Trusted/IoT) with the VLAN IDs above.
2. Configure the Pi’s switch port as a trunk that carries VLAN 50.
3. DHCP: set **DNS server per VLAN** to the Pi-hole IP of that VLAN.

> Note: VLAN 1 (Trusted) is often the **untagged/native** LAN on UniFi. In that common case, `TRUSTED_PARENT=eth0` (no `.1`).

## Quick install (one command)
### 1) Copy project to the Pi
Example:
```bash
sudo mkdir -p /opt/pi-dns-warden
sudo chown -R $USER:$USER /opt/pi-dns-warden
cd /opt/pi-dns-warden
# copy the project files here
```

### 2) Deploy
First run creates `.env` and stops:
```bash
cd /opt/pi-dns-warden
chmod +x deploy.sh ops/scripts/*.sh
sudo ./deploy.sh
```

Edit `.env` (at minimum: set 2 Pi-hole passwords, set the 2 Tor SOCKS passwords used for circuit isolation, and confirm `TRUSTED_PARENT`):
```bash
nano .env
```

Optional alert delivery settings in `.env`:
- Email: `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_SMARTHOST`, optional SMTP auth, and `ALERT_EMAIL_REQUIRE_TLS`
- Telegram: `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID`
- External Prometheus watchdog: `PROMETHEUS_WATCHDOG_URL`, `PROMETHEUS_WATCHDOG_CONTAINER_NAME`, `PROMETHEUS_WATCHDOG_NETWORK`, `PROMETHEUS_WATCHDOG_PORT`, `PROMETHEUS_WATCHDOG_PATH`, `PROMETHEUS_WATCHDOG_TIMEOUT_S`
- Reverse proxy: `REVERSE_PROXY_DOMAIN`, `REVERSE_PROXY_HTTP_PORT`
- Edge auth: `TORHOLE_ADMIN_USER`, `TORHOLE_ADMIN_PASSWORD`
- Torhole local DNS names: `TORHOLE_DNS_HOSTS`
- Extra Pi-hole local DNS records: `PIHOLE_LOCAL_DNS_RECORDS`
- Recovery service: `BACKUP_MANAGER_IMAGE`, `BACKUP_MANAGER_ROOT_DIR`

Run deploy again:
```bash
sudo ./deploy.sh
```

### Optional flags
- Disable Wi-Fi + Bluetooth (requires reboot):
```bash
sudo ./deploy.sh --disable-radios
```

- Set hostname:
```bash
sudo ./deploy.sh --hostname torhole
```

- Apply a safe host hardening baseline (SSH keys-only + UFW + unattended upgrades):
```bash
sudo ./deploy.sh --harden-host
```

## After deployment
### DNS endpoints
- Trusted Pi-hole DNS: `192.168.1.53`
- IoT Pi-hole DNS: `192.168.50.53`

### Web UIs
- Trusted Pi-hole direct VLAN IP: `http://192.168.1.53/admin`
- Reverse-proxy landing page: `https://torhole.lan.home.arpa`
- Auth portal: `https://auth.lan.home.arpa`
- Grafana: `https://grafana.lan.home.arpa`
- Prometheus: `https://prometheus.lan.home.arpa`
- Alertmanager: `https://alertmanager.lan.home.arpa`
- Dockhand: `https://dockhand.lan.home.arpa`
- Pi-hole Trusted: `https://pihole-trusted.lan.home.arpa/admin/`
- Pi-hole IoT: `https://pihole-iot.lan.home.arpa/admin/`

The Torhole landing page, recovery API, Prometheus, and Alertmanager now sit behind a shared Authelia session. Grafana and Dockhand still use their application logins. Caddy uses an internal CA for LAN HTTPS, so you need to trust its root certificate on your devices to avoid browser warnings.

### Reverse proxy
The stack can also publish a single LAN reverse proxy with local hostnames:
- `https://torhole.<your-domain>`
- `https://auth.<your-domain>`
- `https://grafana.<your-domain>`
- `https://prometheus.<your-domain>`
- `https://alertmanager.<your-domain>`
- `https://dockhand.<your-domain>`
- `https://pihole-trusted.<your-domain>/admin/`
- `https://pihole-iot.<your-domain>/admin/`

For example, `REVERSE_PROXY_DOMAIN=lan.home.arpa` makes these resolve as
`*.lan.home.arpa`. Do not use bare `home.arpa`: it is a special public suffix,
so Authelia cannot set a session cookie for it.
The canonical host records and their short aliases are rendered from `.env` during deploy, update, and restore, so Pi-hole owns those local DNS entries automatically.
You can also add arbitrary Pi-hole local DNS records in `.env` via `PIHOLE_LOCAL_DNS_RECORDS`. Use `host=ip;fqdn=ip`. Short names are expanded under `REVERSE_PROXY_DOMAIN`.

The shared Torhole edge session is rendered from `.env` by `ops/scripts/18-render-auth.sh`. `TORHOLE_WEB_MODE` selects plain HTTP, Caddy-local HTTPS, or an uploaded custom certificate. HTTPS uses Authelia; HTTP and the permanent `http://HOST_MGMT_IP/` recovery route use Caddy authentication with the same admin credentials. On first render the script auto-generates internal Authelia secrets plus `BACKUP_MANAGER_API_TOKEN` if they are blank, then writes them back into `.env`. Caddy presents that token to `backup-manager`; direct internal API calls are rejected.

### Autostart
Two systemd units are installed:
- `pihole-tor-vlans.service` (checks the flat parent or creates VLAN sub-interfaces, according to `TORHOLE_TOPOLOGY`)
- `pihole-tor.service` (starts the Docker Compose stack)

## Tor-only egress model
- `dns_int` is an internal Docker bridge used for service-to-service traffic only.
- `dnscrypt-*` containers are attached only to `dns_int`, so they have no direct route to the internet.
- `tor` is attached to both `dns_int` and `tor_out`; `tor_out` is the only outbound bridge with a gateway.
- monitoring UIs that need DNS-plane visibility are attached to both `dns_int` and `mgmt_net`, so published ports remain reachable from the host and trusted LAN.
- Dockhand is attached only to the internal `admin_net`, which it shares with Caddy; it is not directly reachable from workload containers on `dns_int`.
- `reverse-proxy` is attached to both `dns_int` and `mgmt_net`, publishes one HTTP port to the host, and routes to the internal services by local hostname.
- `authelia` stays on `dns_int` only and provides the shared login session for the landing page, Prometheus, Alertmanager, and the recovery API.
- active `pihole_*` containers use `dns_int` as the preferred internal route for upstream DNS and keep macvlan attachments for client traffic. Single-LAN activates one plane; VLAN activates Trusted and IoT.
- `loki` and `alloy` keep logs inside the stack so Grafana can correlate metrics, alerts, and service logs.
- `pihole-exporter` authenticates to the Pi-hole v6 API and exposes real DNS/cache/client/upstream metrics to Prometheus.
- This survives `docker compose down && docker compose up -d` because the network topology is defined in `docker-compose.yml`, not in temporary firewall state.

## Verification
### Network topology
```bash
docker network inspect pi-dns-warden_dns_int
docker inspect dnscrypt-trusted --format '{{json .NetworkSettings.Networks}}'
# VLAN topology only:
docker inspect dnscrypt-iot --format '{{json .NetworkSettings.Networks}}'
docker inspect tor --format '{{json .NetworkSettings.Networks}}'
docker inspect reverse-proxy --format '{{json .NetworkSettings.Networks}}'
```

Expected:
- `pi-dns-warden_dns_int` shows `"Internal": true`
- each `dnscrypt-*` container is attached only to `pi-dns-warden_dns_int`
- `tor` is attached to both `pi-dns-warden_dns_int` and `pi-dns-warden_tor_out`
- published UIs such as `grafana` and `prometheus` are attached to `pi-dns-warden_mgmt_net`
- `reverse-proxy` is attached to `pi-dns-warden_dns_int` and `pi-dns-warden_mgmt_net`

### Tor configuration
```bash
docker exec tor tor --verify-config -f /etc/tor/torrc
docker exec tor tor --dump-config short -f /etc/tor/torrc | grep -E '^(SocksPort|SocksPolicy)'
docker logs --tail 100 tor
```

Expected:
- config verifies cleanly
- `SocksPolicy` allows only `127.0.0.1`, `172.30.0.11`, `172.30.0.12`, and `172.30.0.33`
- Tor bootstraps to `100% (done)` with no protocol warnings

### Alerting
Alertmanager config is rendered from `.env` by `ops/scripts/17-render-alertmanager.sh`.

Prometheus itself cannot alert you when it is totally down. To cover that case, deployment also installs a host-side systemd timer that runs `ops/scripts/18-prometheus-watchdog.sh` every minute and sends Telegram directly if Prometheus stops answering on its internal container health endpoint.

By default the watchdog now auto-discovers the `prometheus` container IP on `pi-dns-warden_dns_int` and checks `http://<container-ip>:9090/-/healthy`. You only need `PROMETHEUS_WATCHDOG_URL` if you want to override that behavior.

Render and restart just the alerting stack:
```bash
./ops/scripts/17-render-alertmanager.sh
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d alertmanager prometheus
```

Verify:
```bash
docker logs --tail 50 alertmanager
docker logs --tail 50 prometheus
```

Expected:
- `alertmanager` stays up without config parse errors
- `prometheus` stays up and can reach `alertmanager:9093`
- if no `ALERT_EMAIL_*` or `ALERT_TELEGRAM_*` values are set, Alertmanager still starts with a no-op receiver

Verify the external watchdog:
```bash
systemctl status pihole-tor-prometheus-watchdog.timer
systemctl list-timers | grep pihole-tor-prometheus-watchdog
```

### Validation
Validate the rendered stack before deploys or updates:

```bash
./ops/scripts/19-validate-stack.sh
```

This checks:
- Compose render
- Prometheus config and rules
- Alertmanager config
- Caddy config
- Alloy config
- Grafana dashboard JSON

### Backup and restore
Create a point-in-time backup before risky changes:

```bash
./ops/scripts/50-backup.sh
```

Backups now include:
- project config and deployment scripts
- `pihole/` bind-mounted state, including local DNS entries and Pi-hole data
- Docker volume data for `Grafana`, `Prometheus`, `Loki`, `Alertmanager`, `Caddy`, `Dockhand`, and `Alloy`

Restore a previous backup archive:

```bash
sudo ./ops/scripts/60-restore.sh /opt/pi-dns-warden/backups/torhole-backup-YYYYMMDD-HHMMSS.tar.gz
```

The restore script:
- creates a safety backup of the current state first
- stops the stack before applying the archive
- restores both the project tree and the service volumes
- re-renders and validates config before restart
- requires explicit restore confirmation

For unattended recovery from the landing page, the Torhole main page (`https://torhole.<your-domain>`) exposes a protected recovery panel. Use the Torhole admin credentials configured in `.env` for the protected monitoring surfaces to create a backup or schedule a restore without leaving the page.
The recovery panel polls running jobs automatically and each archive reports how many service volumes were captured alongside the Pi-hole state.
Backup deletion is also available there, but it requires repeated confirmation and the exact archive name before anything is removed.

### Functional DNS checks
```bash
dig @192.168.1.53 example.com
dig @192.168.50.53 example.com
```

### Failure-mode check
Stopping Tor should break upstream resolution and prove there is no direct bypass:
```bash
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml stop tor
dig @192.168.1.53 example.com
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml start tor
```

### Log timestamps
Tor logs are typically emitted in UTC. If the host is configured for `CEST` or another local time zone, a 1-2 hour offset between `date` and `docker logs tor` is expected.

## Monitoring dashboards (included)
Grafana will auto-load 4 dashboards:
- **Pi DNS Warden - Control Room** (alerts, stack health, request path, host saturation, Tor traffic)
- **Pi DNS Warden - DNS Path** (Pi-hole -> dnscrypt -> Tor availability, latency, pressure)
- **Pi DNS Warden - Tor Traffic & Runtime** (Tor RX/TX, Tor runtime health, dnscrypt demand into Tor)
- **Pi DNS Warden - Platform & Edge** (host hardware, reverse-proxy edge, storage, network, and Tor edge traffic)

## Project structure
```text
pihole-tor-dnscrypt/
├── deploy.sh
├── docker-compose.yml
├── docker-compose.monitoring.yml
├── .env.example
├── tor/
│   └── torrc
├── ops/
│   ├── dnscrypt-proxy.toml.template
│   ├── scripts/
│   │   ├── 00-prereqs.sh
│   │   ├── 05-disable-radios.sh
│   │   ├── 06-harden-host.sh
│   │   ├── 10-vlan-interfaces.sh
│   │   ├── 15-render-dnscrypt.sh
│   │   ├── 17-render-alertmanager.sh
│   │   └── 20-up.sh
│   └── systemd/
│       ├── pihole-tor-vlans.service.template
│       └── pihole-tor.service.template
├── dnscrypt/
│   ├── trusted/
│   └── iot/
├── pihole/
│   ├── trusted/
│   └── iot/
└── monitoring/
    ├── prometheus/
    │   └── prometheus.yml
    ├── blackbox/
    │   └── blackbox.yml
    └── grafana/
        ├── provisioning/
        │   ├── datasources/
        │   └── dashboards/
        └── dashboards/
            ├── pi-dns-warden-overview.json
            ├── pi-dns-warden-dns-tor.json
            └── pi-dns-warden-containers.json
```

## Empty folders: is that normal?
Yes, some folders exist to be mounted as volumes (Pi-hole config/state). They can be empty until the first container start.

## Host hardening: what we apply (minimum)
The `--harden-host` option applies a small baseline:
- SSH: disables password auth + root login (you already use SSH keys)
- UFW: default deny incoming, allow management ports from Trusted LAN
- Unattended upgrades: enabled

If you want to go deeper, the guide you linked is a good checklist.

## License
MIT (see LICENSE).
