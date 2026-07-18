# Torhole

Torhole is a self-hosted DNS privacy gateway. It blocks unwanted domains with
Pi-hole, encrypts outbound DNS resolver connections with dnscrypt-proxy, and
sends those connections through Tor.

The purpose is specific: **obfuscate the origin and network path of upstream
DNS traffic**. The resolver receives the DNS question from a Tor exit instead
of directly from your household or office IP address.

## Torhole is not a VPN

Torhole deliberately protects the DNS path. It does not tunnel all traffic from
your devices.

- It does **not** route web, video, messaging, or application traffic through
  Tor.
- It does **not** replace your public IP address when you visit a website.
- It does **not** make browsing anonymous or make an unsafe device secure.
- It cannot protect DNS requests from an application that ignores your network
  DNS setting and uses its own resolver or encrypted-DNS service.

A conventional full-tunnel VPN changes the route for most or all device
traffic and moves trust to the VPN operator. Torhole makes a narrower change:
devices keep their normal Internet connection, while DNS handled by Torhole
takes a filtered, encrypted, Tor-routed path.

## What happens to a DNS lookup

```text
Your device
  -> Pi-hole                    filters domains and answers local DNS
  -> dnscrypt-proxy             encrypts the upstream resolver connection
  -> Tor circuit                separates the request from your public IP
  -> upstream DNS resolver      sees the query coming from a Tor exit
```

Your ordinary application traffic follows its normal route:

```text
Your browser or app -> your normal Internet connection -> destination service
```

Tor and encrypted DNS solve different parts of the problem:

- **Pi-hole** keeps filtering and local DNS under your control.
- **dnscrypt-proxy** protects the resolver traffic, including beyond the Tor
  exit, using DNSCrypt or HTTPS-based resolvers.
- **Tor** prevents the resolver from receiving the connection directly from
  your household public IP.

### Who can see what?

| Observer | What it can see |
|---|---|
| Your Torhole host | DNS questions, client information, and Pi-hole logs according to your settings |
| Your ISP or upstream network | A connection to the Tor network, but not the DNS payload carried inside it |
| A Tor exit relay | A connection to the selected resolver; the resolver protocol remains encrypted |
| The DNS resolver | The DNS question and the Tor exit address, not your household public IP |
| Websites and Internet services | Your normal public IP and application traffic, because Torhole is not a full-traffic tunnel |

This is DNS privacy through source obfuscation and transport encryption, not a
claim of complete anonymity. Tor usage can be identified as Tor usage, timing
analysis remains possible, and Pi-hole is still a DNS logging point that you
operate. Devices must actually use Torhole as their DNS server for this path to
apply.

## One product, two editions

Torhole has one repository, one installer, and one privacy core. During setup,
you choose a capability profile:

| | Torhole Home | Torhole Advanced |
|---|---|---|
| Designed for | Households and first-time self-hosters | Homelabs, segmented networks, and experienced operators |
| DNS layout | One simple DNS plane | Separate trusted and IoT/VLAN DNS planes |
| Privacy path | Pi-hole -> dnscrypt-proxy -> Tor | The same core path, isolated per network plane |
| User experience | Guided setup and a lightweight privacy dashboard | Guided setup plus the full operational workspace |
| Controls | Verify privacy, start, stop, restart, and renew Tor identity | Per-plane Tor controls, validation, recovery, and deeper operations |
| Optional operations | Intentionally minimal | SSO, Caddy, backups, Prometheus, Grafana, Loki, alerting, and container tooling |

### Why have two editions?

The DNS privacy mechanism should be usable without requiring knowledge of
VLANs, identity providers, metrics, or log aggregation. Home keeps the number
of components and decisions small, which makes installation, recovery, and
everyday use more approachable.

Advanced exists because segmented networks and long-running infrastructure
need more visibility and control. Its operational tools are valuable in that
environment, but they also consume more resources and create more configuration
surface. They should not be mandatory for someone who only wants a private DNS
path at home.

These are not separate products or installers. Both use the same Torhole code
and guided setup. Start with Home unless you already know why you need the
Advanced capabilities.

## Install

Torhole is intended for a Raspberry Pi 5 or a Debian/Ubuntu host or VM. Docker
Engine and Docker Compose are required; on Debian and Ubuntu the installer can
install them after asking for permission.

Run:

```bash
curl -fsSL https://raw.githubusercontent.com/torhole/torhole/main/get-torhole.sh | bash
```

The bootstrap:

1. installs Git if it is missing and you approve the change;
2. downloads Torhole into `~/torhole`;
3. starts a temporary local setup service;
4. opens or prints a private setup URL;
5. lets you choose **Home** or **Advanced** and configure that profile in the
   browser.

The wizard writes deployment-specific values to local, ignored environment
files. They are not committed to the repository.

To inspect the bootstrap before running it:

```bash
curl -fsSLO https://raw.githubusercontent.com/torhole/torhole/main/get-torhole.sh
less get-torhole.sh
bash get-torhole.sh
```

The traditional clone workflow starts the same installer:

```bash
git clone https://github.com/torhole/torhole.git
cd torhole
./install.sh
```

### Home setup

Choose **Home** in the web installer. Home creates a secure local configuration,
starts one Pi-hole/dnscrypt/Tor path, and shows the Torhole Home dashboard. The
installer prints:

- the Torhole dashboard address;
- the Pi-hole administration address and password;
- the DNS address to configure in your router or device.

After the stack starts, allow Tor a minute to establish a circuit. The Home
dashboard then verifies DNS resolution, blocking, Tor routing, the current exit,
and whether the resolver sees the Tor exit rather than the host's normal public
address.

Command-line checks are also available:

```bash
dig @127.0.0.1 example.com
dig @127.0.0.1 doubleclick.net
```

The first should resolve. The second should return a blocked response after the
Pi-hole lists are ready.

> **Port 53 already in use?** Torhole needs port 53 to serve ordinary routers
> and devices. Stop the conflicting DNS service, then run the installer again.
> Advanced users can change `DNS_PORT` in
> `pi-dns-warden/.env.quickstart.local` for testing, but most routers cannot use
> a custom DNS port.

### Advanced setup

Choose **Advanced** in the same web installer. The wizard exposes the additional
network planes and operational features, validates the configuration, and lets
experienced users review or edit the generated environment values.

Advanced can provide:

- trusted and IoT/VLAN DNS isolation;
- the full Torhole administration workspace;
- Caddy and Authelia single sign-on;
- Prometheus metrics, Grafana dashboards, Loki logs, and alerting;
- protected backup and recovery operations;
- detailed Tor circuits, per-plane identity renewal, leak tests, and service
  controls.

These features are optional capability choices, not a different privacy model.
See [the detailed deployment reference](pi-dns-warden/docs/deploy-reference.md),
[Ansible notes](README-ANSIBLE.md), and [Proxmox notes](README-PROXMOX.md).

## Dashboard: proof, not a promise

Torhole is meant to show evidence that the configured DNS privacy path is
working. Depending on the selected edition, the dashboard presents:

- DNS resolution and blocking results;
- the observed Tor exit address;
- a comparison between the normal host address and the resolver path;
- live Tor circuit and relay details;
- a fail-closed or bypass result;
- start, stop, restart, verification, and Tor identity controls;
- service health and, in Advanced, operational metrics and alerts.

The dashboard proves the Torhole DNS path at that moment. It does not claim
that unrelated application traffic is using Tor.

## Operations

From the repository directory:

```bash
./install.sh status         # show Home service health
./install.sh logs           # follow Home logs
./install.sh stop           # stop Home without deleting configuration
./install.sh close-wizard   # close the temporary setup service
```

Advanced operations and validation commands are documented under
[`pi-dns-warden/docs/`](pi-dns-warden/docs/).

## Repository layout

- `install.sh` and `get-torhole.sh` - the single guided installation entrypoint
- `pi-dns-warden/` - DNS, Tor, dashboards, monitoring, and operational services
- `ansible/` - optional Advanced provisioning
- `scripts/` - repository-level bootstrap and validation helpers
- `README-ALERTING.md`, `README-ANSIBLE.md`, `README-PROXMOX.md`, and
  `README-TESTING.md` - focused operator documentation

## Security

Keep Torhole administration interfaces on a trusted network. Do not commit
generated environment files, certificates, keys, backups, query databases, or
deployment inventories.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
