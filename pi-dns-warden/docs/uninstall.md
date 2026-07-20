# Uninstall Torhole safely

This checklist removes a Torhole installation without guessing which Docker or
host resources belong to it. Read the whole checklist before starting.

## 1. Move clients away from Torhole DNS

Change the DNS server configured by your router, DHCP server, VLANs, and any
manually configured clients. Renew their DHCP leases or reconnect them, then
confirm that they can resolve a name while Torhole is stopped.

Do this first. Removing a DNS server while clients still point to it will make
their Internet access appear broken.

## 2. Keep a recovery copy

For Advanced, create and download a current snapshot from **Operate → Backups**
or run:

```bash
cd ~/torhole/pi-dns-warden
sudo ./ops/scripts/50-backup.sh
```

Copy the resulting archive off the Torhole host before continuing. For either
edition, keeping the `~/torhole` directory temporarily preserves the generated
configuration and credentials.

## 3. Identify the installed edition

```bash
cd ~/torhole
./install.sh credentials
```

The heading reports **Torhole Home** or **Torhole Advanced**. Follow only the
matching section below.

## 4A. Remove Torhole Home

Remove the Home containers and networks but keep their Docker volumes:

```bash
cd ~/torhole/pi-dns-warden
sudo docker compose --env-file .env.quickstart.local \
  -f docker-compose.quickstart.yml down
```

At this point Home is uninstalled from the running system but can be restored
from the same repository and data.

To erase the Home Pi-hole database and Tor state as well, repeat the command
with `--volumes`:

```bash
sudo docker compose --env-file .env.quickstart.local \
  -f docker-compose.quickstart.yml down --volumes
```

Docker lists each removed Torhole volume. Stop if the command names a resource
you do not recognise.

## 4B. Remove Torhole Advanced

Disable the Torhole boot, networking, and watchdog services first:

```bash
sudo systemctl disable --now \
  pihole-tor.service \
  pihole-tor-prometheus-watchdog.timer \
  pihole-tor-prometheus-watchdog.service \
  pihole-tor-vlans.service
```

Then remove all Advanced containers and networks, including a VLAN-profile
installation:

```bash
cd ~/torhole/pi-dns-warden
sudo docker compose --profile vlan \
  -f docker-compose.yml -f docker-compose.monitoring.yml down
```

To permanently delete the named Prometheus, Grafana, Loki, Alloy, Alertmanager,
Authelia, Caddy, and Dockhand volumes, add `--volumes` only after the external
backup has been checked:

```bash
sudo docker compose --profile vlan \
  -f docker-compose.yml -f docker-compose.monitoring.yml down --volumes
```

Remove only the four unit files installed by Torhole, then reload systemd:

```bash
sudo rm -f \
  /etc/systemd/system/pihole-tor.service \
  /etc/systemd/system/pihole-tor-vlans.service \
  /etc/systemd/system/pihole-tor-prometheus-watchdog.service \
  /etc/systemd/system/pihole-tor-prometheus-watchdog.timer
sudo systemctl daemon-reload
```

Advanced stores Pi-hole data, rendered configuration, certificates, backups,
and secrets inside the local repository as well as in Docker volumes. They are
not erased until the repository recovery copy is deleted.

If segmented VLAN mode created transient interfaces such as `eth0.50`, they
disappear on the next host reboot after `pihole-tor-vlans.service` has been
disabled. Do not manually delete an interface unless you have confirmed that
Torhole created it and no other host service uses it.

## 5. Remove the recovery copy

First move the repository out of its normal location rather than immediately
deleting it:

```bash
cd ~
mv torhole "torhole.uninstalled.$(date +%Y%m%d-%H%M%S)"
```

Reboot the host, confirm that normal DNS and networking still work, and confirm
that the external backup opens successfully. You can then delete that precisely
named `torhole.uninstalled.<timestamp>` directory when you no longer need the
recovery copy.

## Optional host changes are not automatically reversed

If you explicitly asked the Advanced installer to change the hostname, disable
Wi-Fi/Bluetooth, enable unattended upgrades, or apply its firewall/SSH
hardening, those are host-administration choices rather than container data.
Torhole does not automatically undo them because doing so could weaken the host
or interrupt remote access. Review and reverse those settings separately if
required.

Docker Engine, Git, and general operating-system packages are intentionally
left installed because they may be used by other applications.
