# torhole

Torhole turns Pi-hole into a segmented, observable, Tor-routed DNS platform. No trust in public resolvers. No telemetry. Runs on a Pi 5 or any Debian VM.

## What lives here
- `pi-dns-warden/` — core DNS stack (Pi-hole + dnscrypt-proxy + Tor); will be promoted to repo root in Phase 0 T-047
- `ansible/` — playbooks to provision and configure the DNS host
- `scripts/` — bootstrap and ops scripts
- `TASK.md` — active tasks and status
- `README-ALERTING.md`, `README-ANSIBLE.md`, `README-PROXMOX.md`, `README-TESTING.md` — topical docs

## Architecture

```
Client → Pi-hole (DNS) → dnscrypt-proxy → Tor → upstream resolver
```

Pi-hole handles blocking and local DNS. dnscrypt-proxy provides encrypted DNS-over-HTTPS/TLS. Tor routes all upstream resolver traffic — no ISP or public resolver sees your queries.

## Install Torhole Home

Torhole Home is the beginner-friendly edition: Pi-hole blocking, encrypted
DNS, and Tor routing without VLANs, Ansible, SSO, or a monitoring stack.
Run:

```bash
curl -fsSL https://raw.githubusercontent.com/torhole/torhole/main/get-torhole.sh | bash
```

The bootstrap downloads the Torhole repository into `~/torhole`, then opens
the same guided installer used by a normal clone. It does not contain a second
installation path. To inspect it before running it:

```bash
curl -fsSLO https://raw.githubusercontent.com/torhole/torhole/main/get-torhole.sh
less get-torhole.sh
bash get-torhole.sh
```

The original clone workflow remains supported:

```bash
git clone https://github.com/torhole/torhole.git
cd torhole
./install.sh
```

On Debian or Ubuntu, the installer can install Docker Engine and Compose from
the operating system repository after asking for permission. On other systems,
install Docker Engine or Docker Desktop first.

The installer creates a secure password, starts Torhole, and prints the admin
address and the DNS address to enter in your router. Give Tor about a minute
to connect, then verify it:

```bash
# Torhole Home:      http://localhost:8080
# Pi-hole advanced:  http://localhost:8081/admin   (password from installer)

# Verify DNS resolves through the stack:
dig @127.0.0.1 example.com               # returns an A record
dig @127.0.0.1 doubleclick.net           # returns 0.0.0.0 (blocked)
```

Point a device's DNS at this host's IP and you're browsing with ad-blocked,
Tor-routed DNS. Every upstream query exits through Tor — no ISP or public
resolver sees them.

> **Port 53 already in use?** Torhole must use port 53 to serve ordinary
> routers and devices. Stop the conflicting DNS service, then run the installer
> again. Advanced users can change `DNS_PORT` in
> `pi-dns-warden/.env.quickstart.local` for local testing, but most routers
> cannot use a custom DNS port. Torhole Home uses `WEB_PORT` (default 8080),
> while Pi-hole's advanced interface uses `PIHOLE_WEB_PORT` (default 8081).

Useful commands:

```bash
./install.sh status    # show service health
./install.sh logs      # follow logs
./install.sh stop      # stop without deleting configuration
```

### Which edition should I use?

| Edition | For | Includes |
|---|---|---|
| **Torhole Home** *(default)* | Homes and first-time self-hosters | One DNS plane, Pi-hole, dnscrypt-proxy, Tor |
| **Torhole Advanced** | Homelabs and managed networks | VLAN isolation, admin UI, SSO, backups, Prometheus, Grafana, Loki, and alerts |

Start with Home. Choose Advanced only when you need multiple network segments
or detailed operations and observability.

## Production deploy (industrialized)

The full product — two isolated DNS planes (trusted + IoT) on real VLANs,
Caddy + Authelia SSO, the torhole v2 admin UI, Prometheus/Grafana/Loki
monitoring, scheduled backups and alerting:

```bash
# On the target host (Pi 5 or Debian VM):
cd pi-dns-warden
cp .env.example .env                     # fill in VLAN/plane values
sudo ./deploy.sh

# Or provision + deploy fleet-style with Ansible:
cd ansible
ansible-playbook -i inventory.ini.example playbook.yml
```

See `README-TESTING.md` for the full verification checklist,
`README-ANSIBLE.md` and `README-PROXMOX.md` for the fleet path.

## Conventions
- ASCII files; minimal comments; keep edits scoped.
- No destructive git commands; do not revert unrelated changes.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
