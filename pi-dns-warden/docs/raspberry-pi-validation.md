# Raspberry Pi validation and soak testing

Torhole's reference small-device platform is a Raspberry Pi 5 running a
64-bit Debian-family operating system from reliable storage. Validation must
preserve the installed system and its operational history.

## Safety boundary

The standard validation workflow does not reimage storage, reinstall Torhole,
remove volumes, prune Docker data, rotate circuits, restart services, or inject
network failures. Clean-install testing requires separate SD or NVMe media.

Never publish raw reports, logs, backups, Prometheus databases, Loki data, or
Pi-hole databases. They may contain household network information.

## Capture a validation report

From the Torhole project directory on the Pi:

```bash
cd /opt/pi-dns-warden
sudo ./ops/scripts/80-hardware-validation.sh \
  --output validation/raspberry-pi-$(date -u +%Y%m%d).md
```

The report contains hardware, operating-system, capacity, container, backup,
and pass/fail privacy-path evidence. Identifying network and Tor exit data are
excluded. Keep generated reports private until they have been reviewed.

Use `--skip-privacy-check` only when an external dependency is temporarily
unavailable. A release validation report should include the privacy check.

## Run a read-only soak

Start with 24 hours, then extend to 72 hours:

```bash
./ops/scripts/81-soak-observe.sh \
  --hours 24 \
  --interval 60 \
  --output validation/soak-24h.csv
```

The CSV records temperature, load, available memory, disk use, container
health and restarts, plus non-identifying Tor health metrics. It does not
capture DNS questions, clients, local addresses, credentials, or Tor exits.

Acceptance criteria for an observation-only run:

- no unhealthy containers;
- no unexpected increase in container restart counts;
- Tor bootstrap remains at 100 percent;
- the control port and circuit-established signals remain available;
- the independent Tor egress verifier remains healthy;
- disk use remains comfortably below capacity;
- the Pi does not report sustained thermal pressure.

Circuit rotation, service interruption, network failure, reboot recovery, and
restore exercises are separate opt-in tests. Take and verify a backup before
running any of them.
