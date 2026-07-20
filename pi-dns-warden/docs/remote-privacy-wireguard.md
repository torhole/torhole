# Remote privacy — WireGuard (bring your own VPN server)

Keep torhole's Tor-routed, ad-blocked DNS on your phone/laptop when you're
away from home, **without adding any new service to the torhole host**. If
your gateway already runs a WireGuard server (UniFi, OPNsense, pfSense,
MikroTik, Fritz!Box…), remote devices simply tunnel in and use the trusted
Pi-hole like any other LAN client:

```
phone (LTE / hotel wifi)
   │ WireGuard (UDP, encrypted)
   ▼
your gateway's WG server ──▶ LAN ──▶ pihole_trusted ──▶ dnscrypt ──▶ Tor ──▶ resolver
```

torhole's job here is zero new code: the privacy chain applies unchanged.
This page is the checklist that makes it actually work — and fail **closed**.

## 1. Point VPN clients at the trusted plane

Set the DNS your WG server hands to clients to the trusted Pi-hole IP
(`PIHOLE_TRUSTED_IP` from your `.env`).

**UniFi:** Settings → VPN → VPN Server (WireGuard) → set the **DNS Server**
for the VPN to the trusted Pi-hole IP. Re-download/re-issue client profiles
after changing it — already-installed profiles keep the old DNS.

**Any other server:** in each client's `[Interface]` section:

```ini
[Interface]
DNS = <PIHOLE_TRUSTED_IP>
```

## 2. Let the VPN subnet reach the Pi-hole

VPN clients arrive from the VPN's own subnet (UniFi default is separate from
your LAN). Two things must allow that:

1. **Firewall**: a LAN-in rule permitting `<vpn-subnet> → <PIHOLE_TRUSTED_IP>`
   on **53/udp + 53/tcp**. Add **443/tcp** too if you want the torhole admin
   UI reachable over the tunnel.
2. **Pi-hole listening policy**: the VPN subnet is *routed*, not on-link. If
   Pi-hole is set to "Allow only local requests" it will refuse these
   queries — it must permit all origins (the firewall above is the actual
   gate; Pi-hole sits on an isolated VLAN either way).

## 3. Fail closed on the client — this is the whole point

Do **not** configure a fallback DNS (no `1.1.1.1` second entry, no
"use cellular DNS when VPN drops"). A fallback silently reintroduces exactly
the leak torhole exists to prevent. The correct behavior when the tunnel is
down is **no DNS** until it reconnects:

- iOS/Android WireGuard apps: enable **on-demand** activation so the tunnel
  is always up when off-wifi (Settings → the tunnel → On-Demand → Cellular +
  unknown Wi-Fi).
- Split vs full tunnel: `AllowedIPs = <PIHOLE_TRUSTED_IP>/32` gives DNS-only
  (light, battery-friendly); `AllowedIPs = 0.0.0.0/0, ::/0` routes everything
  home (stronger; your traffic exits via your home connection).

## 4. Verify

From a device on LTE with the tunnel up:

1. `dig example.com` (or open any site) — should resolve.
2. Check the Pi-hole query log for the trusted plane and confirm the VPN client
   is using that resolver. Client identities are intentionally not shown on the
   default Grafana dashboards.
3. In the Privacy screen, confirm the DNS-hop probes, Tor control state, and
   scheduled Tor-egress verification are all current. The historical
   `torhole_leak_test_pass` metric confirms external Tor egress; it does not by
   itself trace an individual DNS query through Pi-hole and dnscrypt.
4. Kill the tunnel: DNS should **stop working** (fail closed). If it still
   resolves, the device has a leaking fallback — fix the profile.

## Known trade-offs (read before relying on it)

- **Metadata**: every network your device joins sees encrypted traffic to
  your home IP. torhole hides *what* you resolve, not *where you live*.
- **One VPN slot on mobile**: iOS/Android run a single VPN profile — this
  can't stack with another always-on VPN.
- **Latency**: remote DNS = device → home → Tor → resolver. Fine in-country;
  noticeable intercontinentally (uncached lookups).
- **Availability coupling**: home outage = remote DNS outage. That is the
  fail-closed deal; don't "fix" it with a fallback resolver.
- **CGNAT**: if your ISP doesn't give you a reachable public IP, an inbound
  WG server can't work; a self-hosted relay (e.g. headscale) or small VPS
  rendezvous is the escape hatch.

## No WireGuard-capable gateway?

A torhole-hosted WireGuard module (optional compose profile, off by default,
QR provisioning, handshake-age metric + alert) is on the roadmap — see
T-062 on the task board. Bring-your-own-server is and will remain the
recommended path: it keeps the torhole host's privileged surface unchanged.
