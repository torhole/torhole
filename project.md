# Project Context: torhole

## Mission

Turn Pi-hole into a segmented, observable, Tor-routed DNS platform:
- All upstream DNS traffic exits through Tor — no trust in public resolvers
- dnscrypt-proxy provides encrypted DNS-over-HTTPS/TLS as the Tor-facing resolver
- Grafana dashboards expose DNS path health, Tor runtime, and block metrics
- Ansible automates provisioning on Pi 5 or any Debian VM

## Architecture

```
Client → Pi-hole → dnscrypt-proxy → Tor → upstream resolver
```

## Constraints

- All task updates must be reflected in TASK.md
- All actions must be logged in journal.md
- Agents must not overwrite unrelated sections
- Do not expose SOCKS port (9050) externally
