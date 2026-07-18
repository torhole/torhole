# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for the
[`torhole/torhole`](https://github.com/torhole/torhole) repository. Do not open
a public issue for a suspected vulnerability or include credentials, private
network details, logs, or exploit material in public discussions.

Include the affected version or commit, deployment profile (Home or Advanced),
reproduction steps, impact, and any suggested mitigation. Reports will be
acknowledged through the private report and coordinated there until a fix is
available.

## Supported versions

Security fixes target the latest release and the current `main` branch. Older
releases may require upgrading before a fix can be applied.

## Deployment boundaries

Torhole is intended for a trusted self-hosted network. Home publishes DNS and
local administration ports on the configured host address. Advanced adds
segmented networks and authenticated operational tooling. Neither edition is
designed to expose its administration interfaces directly to the public
internet.

Keep generated `.env` files, backup archives, certificates, private keys,
inventory files, and runtime data out of Git. Rotate any credential that may
have been disclosed, even if it was later removed from the current tree.
