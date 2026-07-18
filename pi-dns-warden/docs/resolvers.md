# Choosing Resolvers

torhole routes all DNS through Tor, which means the upstream resolver sees a Tor exit IP — not your home IP. This changes the resolver trust calculus compared to using a resolver directly.

## Default resolvers

| Resolver | Protocol | Filtering | No-log policy |
|----------|----------|-----------|---------------|
| `cloudflare-security` | DoH | Malware + phishing | Yes (published) |
| `quad9-dnscrypt-ip4-filter-pri` | DNSCrypt | Malware + phishing | Yes (published) |

These are chosen for reliability over Tor and for malware blocking as a second layer beyond Pi-hole. They both publish no-logging policies. Since Tor hides your IP, even if they did log, the log entry would contain a Tor exit IP.

## Changing resolvers

Edit `DNSCRYPT_RESOLVERS` in `.env`. The value is a comma-separated list of resolver names from the [dnscrypt-proxy public resolver list](https://github.com/DNSCrypt/dnscrypt-resolvers/blob/master/v3/public-resolvers.md).

```bash
# Unfiltered (no malware blocking — queries pass through as-is)
DNSCRYPT_RESOLVERS=cloudflare,google,dnscrypt.nl-ns0-ipv4

# Maximum filtering (malware + ads at resolver level, on top of Pi-hole)
DNSCRYPT_RESOLVERS=cloudflare-security,quad9-dnscrypt-ip4-filter-pri,adguard-dns-doh

# DNSCrypt only (avoids DoH entirely)
DNSCRYPT_RESOLVERS=quad9-dnscrypt-ip4-filter-pri,scaleway-fr,cs-de
```

After changing, restart the dnscrypt containers:
```bash
docker compose restart dnscrypt-trusted dnscrypt-iot
```

## Resolver properties to consider

**Protocol: DNSCrypt vs DoH**

Both are encrypted and supported by torhole. DNSCrypt is an open protocol designed for DNS. DoH uses HTTPS and may be harder for ISPs to distinguish from regular web traffic (relevant if you use torhole on a network that blocks Tor but allows HTTPS — though Tor bridges address that separately).

**Filtering vs unfiltered**

Filtered resolvers add a second blocklist layer on top of Pi-hole. If a domain isn't in Pi-hole's lists but is in the resolver's malware feed, it still gets blocked. Tradeoff: you're trusting the resolver's categorisation. Unfiltered resolvers return whatever the authoritative server says.

**No-log policies**

Resolver no-log policies are self-attested and unverifiable. Tor provides a stronger guarantee: even a logging resolver only records a Tor exit IP. For maximum separation, choose resolvers that are geographically and organisationally distinct from your ISP and from each other.

## Running your own resolver

For maximum privacy, you can run an Unbound recursive resolver locally and point dnscrypt-proxy at it instead of a public resolver. This removes the need to trust any public resolver at all — Unbound resolves directly from root servers. The tradeoff is latency (each query traverses the full DNS tree) and that Tor exit nodes can see the raw recursive queries.

torhole does not currently ship an Unbound configuration. This is a planned addition (see issue tracker).
