# Deploy Pi DNS Warden with Ansible

## Requirements
- Control node: Ansible >= 2.13, Python3, `community.general` collection (for timezone module).
- Target: Debian/Ubuntu/Raspbian host with network trunk carrying VLANs.

## Inventory
Copy the example and edit it:
```
cp inventory.ini.example inventory.ini
[dns_warden]
vm1 ansible_host=192.168.1.50 ansible_user=ubuntu
```

## Vars
Copy `ansible/group_vars/dns_warden.yml.example` to
`ansible/group_vars/dns_warden.yml`, then edit it. Use Ansible Vault for real
secrets.

## Run
```
cd ansible
ansible-galaxy collection install community.general
ansible-playbook -i inventory.ini playbook.yml
```

## What it does
1) Installs base packages + Docker.
2) Creates VLAN subinterfaces (8021q) for Trusted/IoT.
3) Copies project to `/opt/pi-dns-warden`, renders `.env`, dnscrypt configs, reverse-proxy settings, and optional watchdog settings.
4) Renders dnscrypt and Alertmanager config from inventory/env values.
5) Starts stack via docker compose; installs systemd units for autostart.
6) Enables a host-side systemd timer that sends Telegram directly if Prometheus itself stops answering.
7) Deploys a Docker network topology where `dns_int` is internal-only, only the `tor` container gets outbound internet access, and published monitoring UIs live on a separate management bridge.

## Post-deploy checks
- Pi-hole Trusted UI: `http://<trusted_ip>:8080/admin`
- Prometheus: `http://<host_mgmt_ip>:9090`
- Grafana: `http://<host_mgmt_ip>:3000` (set admin password on first login)
- Control view: Grafana dashboard "Pi DNS Warden - Control Room"
- Path view: Grafana dashboard "Pi DNS Warden - DNS Path"
- Tor view: Grafana dashboard "Pi DNS Warden - Tor Traffic & Runtime"
- Reverse proxy: `http://grafana.<reverse_proxy_domain>`, `http://prometheus.<reverse_proxy_domain>`, `http://dockhand.<reverse_proxy_domain>`, and the `pihole-*` hosts should resolve to the Pi management IP through Pi-hole
- `docker network inspect pi-dns-warden_dns_int` should show `"Internal": true`
- `docker inspect dnscrypt-trusted --format '{{json .NetworkSettings.Networks}}'` should show only `pi-dns-warden_dns_int`
- `docker inspect tor --format '{{json .NetworkSettings.Networks}}'` should show `pi-dns-warden_dns_int` and `pi-dns-warden_tor_out`
- `docker inspect grafana --format '{{json .NetworkSettings.Networks}}'` should show `pi-dns-warden_dns_int` and `pi-dns-warden_mgmt_net`
- `docker inspect reverse-proxy --format '{{json .NetworkSettings.Networks}}'` should show `pi-dns-warden_dns_int` and `pi-dns-warden_mgmt_net`
- `docker logs --tail 50 alertmanager` should show a clean startup once `ALERT_EMAIL_*` and/or `ALERT_TELEGRAM_*` are populated in `.env`
- `systemctl status pihole-tor-prometheus-watchdog.timer` should show the external Prometheus watchdog timer as active

## Testing on a Linux VM
- Ensure VLAN-capable vNIC or run single-LAN by pointing DHCP DNS to Trusted IP and ignoring IoT (set VLANs to 1 and IPs to free addresses in the LAN).
- Run `dig @<trusted_ip> example.com` from a client; verify answers; check Tor SOCKS uptime panel.
