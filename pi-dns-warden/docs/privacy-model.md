# Privacy Model

This document explains what torhole protects against, what it does not protect against, and why the design choices were made. Read this before deploying.

## The core guarantee

**All upstream DNS queries exit through Tor.** The dnscrypt containers have no route to the internet except through the Tor container. This is enforced at the Docker network layer, not just by configuration:

- `dns_int` is an `internal: true` bridge — containers on it have no default gateway to the internet.
- Only the `tor` container is also attached to `tor_out`, the sole outbound bridge.
- Tor's `SocksPolicy reject *` with an explicit allowlist means only the three dnscrypt container IPs can use the SOCKS port.

If Tor is down, DNS resolution fails. There is no fallback to a cleartext or direct resolver. This is intentional.

## Threat model

### What torhole protects against

| Threat | Mitigation |
|--------|-----------|
| ISP seeing which domains you query | Tor hides your IP from the upstream resolver; the ISP sees only a Tor connection |
| Network-level DNS interception (captive portals, MITM) | dnscrypt encrypts DNS in transit between the container and the resolver |
| Ad and tracker domains resolving | Pi-hole blocklists applied per VLAN before the query reaches dnscrypt |
| Cross-VLAN DNS correlation | Each VLAN uses separate SOCKS credentials → separate Tor circuits (`IsolateSOCKSAuth`); IoT device queries cannot be linked to trusted device queries at the circuit level |
| Rogue DNS on managed networks | Pi-hole is the only configured DNS server per VLAN; queries go nowhere else |

### What torhole does not protect against

| Limitation | Why |
|-----------|-----|
| The resolver knowing which domains are queried | The resolver sees the domain, just not who asked. Tor hides your IP. Choose resolvers with strict no-logging policies. |
| A malicious Tor exit node reading DNS content | Tor exits see plaintext traffic. dnscrypt mitigates this: DNS is encrypted between the dnscrypt container and the resolver, so the exit node only sees an encrypted TLS/DNSCrypt session, not the query. |
| Non-DNS traffic (HTTP, HTTPS, app telemetry) | torhole only intercepts DNS. Applications that embed hardcoded IPs, use DoH internally, or send telemetry over HTTPS are unaffected. |
| Timing correlation attacks on Tor circuits | A sophisticated adversary watching both ends of a Tor circuit can correlate traffic over time. This is a known Tor limitation. |
| A compromised Pi-hole or dnscrypt container | Container isolation limits blast radius, but a compromised container could observe or modify DNS responses for its VLAN. Keep images up to date. |
| Local network traffic analysis beyond DNS | An adversary on your LAN can still observe connection metadata (destination IPs, timing, volume). DNS privacy does not hide what you connect to, only the name resolution step. |

## Why `require_nolog = false` and `require_nofilter = false`

The dnscrypt-proxy config sets both of these to `false`. This is intentional:

- `require_nolog = true` would exclude nearly all public resolvers, leaving very few options, and would rely on resolver self-attestation rather than network-level guarantees. Since Tor already hides your IP from the resolver, resolver-side logging is less dangerous: the log entry contains a Tor exit IP, not your home IP.
- `require_nofilter = false` allows malware-blocking resolvers (Cloudflare Security, Quad9). These filter known malicious domains. If you prefer truly unfiltered resolution, set your `DNSCRYPT_RESOLVERS` to resolvers without filtering (e.g. `cloudflare`, `google`, `dnscrypt.nl-ns0`).

## Why DNSSEC is not required

`require_dnssec = false` in the dnscrypt config. DNSSEC provides integrity (ensures the answer came from the authoritative server), not privacy. It does not hide your queries and does not prevent resolver logging. Adding it would significantly reduce resolver choice without improving the privacy properties this project is built for.

If you want DNSSEC validation, add an Unbound instance between Pi-hole and dnscrypt and configure it as a DNSSEC-validating resolver. torhole does not currently include this.

## Resolver trust model

torhole ships with `cloudflare-security` and `quad9-dnscrypt-ip4-filter-pri` as defaults. These are chosen for:
- Reliability (high uptime, low latency even over Tor)
- Malware/phishing blocking (additional layer beyond Pi-hole ad blocking)
- Published no-logging policies (see `docs/resolvers.md` for links)

Since Tor hides your IP, a resolver that logs queries only gets a Tor exit IP — not your home IP. This substantially reduces the risk of resolver-side logging compared to using these resolvers directly.

See `docs/resolvers.md` for how to choose and add resolvers.

## Network isolation verification

After deploying, verify the isolation guarantees:

```bash
# 1. Confirm dns_int has no gateway (Internal: true)
docker network inspect pi-dns-warden_dns_int | grep -i internal

# 2. Confirm dnscrypt containers are NOT on tor_out
docker inspect dnscrypt-trusted --format '{{json .NetworkSettings.Networks}}' | jq 'keys'
# Should show only: ["pi-dns-warden_dns_int"]

# 3. Confirm tor container IS on tor_out
docker inspect tor --format '{{json .NetworkSettings.Networks}}' | jq 'keys'
# Should show: ["pi-dns-warden_dns_int", "pi-dns-warden_tor_out"]

# 4. Confirm Tor is actually routing queries
docker compose logs dnscrypt-trusted | grep -i "relay\|circuit\|tor"

# 5. Confirm SOCKS port is not exposed to the host
ss -tlnp | grep 9050   # should return nothing
```
