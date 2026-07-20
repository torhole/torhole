# Build Week demo video script

Target length: about 2 minutes 25 seconds. The submitted video must remain under
three minutes and include audio. The narration is intentionally conversational;
the entrant can still replace the guide voice with their own recording before
the public YouTube upload.

## 1. The problem — title / Home hero

Your DNS history can reveal nearly everything you do online. Torhole changes
that. It is a self-hosted privacy gateway that blocks unwanted domains,
encrypts DNS, and forces it through Tor. The resolver sees a Tor exit—not your
home.

## 2. Torhole Home

This is Torhole Home. It asks four separate questions: does DNS resolve, is the
exit really Tor, is bypass blocked, and does Pi-hole filtering work? The green
state appears only when every answer is yes. Anyone can understand the result,
without becoming a network engineer.

## 3. Torhole Advanced

Advanced keeps the same privacy guarantee, then exposes the evidence. This is
live data from a disposable virtual machine: Tor bootstrap, isolated circuits,
DNS traffic, backups, containers, and the anonymized exit. It works on one LAN,
or separate Trusted and IoT VLANs, with the same fail-closed path.

## 4. Live privacy proof

And this is not a decorative badge. The Privacy workspace reads Tor's control
port and runs a real leak test through the protected path. Here, the Tor
Project confirms the exit address. The recent test history is one hundred
percent passing.

## 5. Operations and recovery

If something fails, Torhole tells you what failed and what to do next. Advanced
can restart a service, run full validation, manage snapshots, and open focused
Grafana dashboards. During Build Week, every dashboard query was checked
against live Prometheus data—including missing and stale data.

## 6. Built with Codex and GPT-5.6

I built this release with Codex powered by GPT-5.6. It traced Bash, Python,
TypeScript, Docker Compose, Prometheus, and Grafana as one system. It implemented
focused fixes, wrote tests, deployed both editions, and debugged real failures
from live metrics. I made the privacy and product decisions; Codex compressed
the loop from idea, to code, to proof.

## 7. Close

Torhole is not a VPN, and it does not promise anonymous browsing. It makes one
narrow promise you can test: DNS handled by Torhole leaves through an encrypted,
Tor-only path. Do not trust a green badge. Verify the path.
