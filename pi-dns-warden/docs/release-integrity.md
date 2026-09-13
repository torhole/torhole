# Release integrity

Torhole release archives are built by GitHub Actions from the tagged commit.
Each release includes a SHA-256 manifest, and the archive receives a signed
GitHub artifact attestation backed by Sigstore.

The release workflow calls the repository's reusable CI workflow at the same
tagged revision and publishes only after all its jobs succeed. Checks include
backend regressions, all three Compose variants, UI typecheck/build and mocked
browser tests, shell lint, an isolated Ansible installation test, and a real
Docker-volume recovery drill. The publishing job alone receives release and
attestation write permissions. See [GitHub's reusable workflow semantics](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).

These gates exercise disposable fixtures. They do not prove live LAN/VLAN
routing, Tor availability, fail-closed behavior, or production database
consistency. Perform the target-host checks in
[README-TESTING.md](../../README-TESTING.md) before deploying a release to clients.

For example, verify `v0.2.2` with GitHub CLI:

```bash
gh release download v0.2.2 \
  --repo torhole/torhole \
  --pattern 'torhole-v0.2.2.tar.gz' \
  --pattern SHA256SUMS

sha256sum --check SHA256SUMS
gh attestation verify torhole-v0.2.2.tar.gz \
  --repo torhole/torhole
```

On macOS, use `shasum -a 256 --check SHA256SUMS` if `sha256sum` is not
installed.

The attestation connects the archive digest to this repository, workflow, tag,
and commit. It proves provenance and detects artifact replacement; it does not
by itself prove that the software is vulnerability-free.

The archive also contains `pi-dns-warden/.torhole-revision`. Torhole passes
that revision into the running application so the About screen can identify
the exact deployed source.
