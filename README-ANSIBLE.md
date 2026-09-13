# Deploy Torhole Advanced with Ansible

Ansible provisions the host, backs up an existing installation, and synchronizes
source files. The shared `pi-dns-warden/deploy.sh` then prepares networking,
renders configuration and authentication, installs systemd units, starts the
stack, and runs its deployment checks.

## Requirements

- A control node with Python, Ansible, `ansible.posix` (synchronize), and
  `community.general` (timezone).
- A supported Debian-family Linux target with SSH and privilege escalation.
- A free Trusted DNS address and a working wired interface. VLAN mode also
  requires the configured VLANs to be carried by the switch/virtual interface.
- `rsync` on the control node; the base role installs it on the target.

Use the Ansible version selected in `.github/workflows/ci.yml` when reproducing
CI. Synchronization with privilege escalation requires a sudo configuration
that permits the remote rsync invocation.

## Inventory and configuration

From the repository root:

```bash
cd ansible
cp inventory.ini.example inventory.ini
cp group_vars/dns_warden.yml.example group_vars/dns_warden.yml
cp group_vars/dns_warden_vault.yml.example group_vars/dns_warden_vault.yml
```

Edit the inventory and both variable files. Set `torhole_topology` to:

- `single-lan`: one Trusted DNS plane; no IoT VLAN is required.
- `vlan`: Trusted and IoT DNS planes; this is the compatibility default.

Set the network values, Pi-hole credentials, `torhole_admin_password`, and
`tor_control_password`. Replace all example secrets, then encrypt the Vault file:

```bash
ansible-vault encrypt group_vars/dns_warden_vault.yml
ansible-galaxy collection install ansible.posix community.general
ansible-playbook -i inventory.ini playbook.yml --ask-vault-pass
```

The environment template manages operator settings. Generated internal
Authelia/API secrets and other unspecified installed settings are retained by
an atomic merge into the target `.env`, which is private (`0600`). An explicit
value supplied for a key replaces its old value. Omitting a key preserves it;
removal requires an intentional edit to the installed environment.

## Staging or an explicitly supplied environment

The staging playbook uses the same deployment role:

```bash
ansible-playbook -i inventory.staging.ini playbook.staging.yml \
  -e staging_env_file=/absolute/path/to/staging.env
```

Provide the Advanced environment values required by `deploy.sh`, including
`TORHOLE_TOPOLOGY`, admin credentials, Tor control password, and network settings.
The supplied file is staged privately and merged using the same preservation
rules. Production can select this input with `-e torhole_env_file=/absolute/path/to/file`.

## Existing installations and recovery

If the target has `.env`, the role runs its installed `50-backup.sh` **before**
synchronizing source or changing managed configuration. Backup failure stops the
deployment. A partial installation with `.env` but no usable backup script must
be repaired or recovered before this path can proceed.

Synchronization excludes controller environment files, recovery archives,
runtime state, Pi-hole data, generated authentication configuration, and TLS
material. It does not delete unmatched target files. The maintained deployer
owns topology selection and systemd configuration; Ansible no longer launches
an independent raw Compose stack.

The standalone `40-update.sh` also backs up before its own rendering and service
changes. It cannot recover source files an operator replaced before invoking it.
Take a backup before manually replacing a checkout or unpacking a new release.
See [deployment reference](pi-dns-warden/docs/deploy-reference.md) for recovery.

## Post-deployment checks

Use the URLs printed by the deployer. Named HTTPS endpoints use the configured
reverse-proxy domain and shared authentication; the management-IP HTTP endpoint
provides password-protected recovery access. Do not assume public host ports for
Prometheus or Grafana.

On the target, `bash ops/scripts/21-verify-privacy.sh` checks active services,
authenticated recovery access, DNS resolution on each selected plane, Tor egress,
control-port authentication, and dnscrypt's internal-only network attachment.
This check contacts external services. It is not a Tor-outage fail-closed test.

See [testing](README-TESTING.md) for isolated CI coverage and live-network checks.
