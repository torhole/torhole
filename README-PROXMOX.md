# Proxmox Cloud-Init Templates (Debian 12 & 13)

## Debian 12 (bookworm) template
```
wget https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2
vmid=9000
qm create $vmid --name debian12-ci --memory 4096 --cores 2 --net0 virtio,bridge=vmbr0,tag=1
qm importdisk $vmid debian-12-genericcloud-amd64.qcow2 local-lvm
qm set $vmid --scsihw virtio-scsi-pci --scsi0 local-lvm:vm-$vmid-disk-0
qm set $vmid --ide2 local-lvm:cloudinit
qm set $vmid --boot c --bootdisk scsi0
qm set $vmid --agent enabled=1
qm template $vmid
```

## Debian 13 (trixie) template
```
wget https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2
vmid=9001
qm create $vmid --name debian13-ci --memory 4096 --cores 2 --net0 virtio,bridge=vmbr0,tag=1
qm importdisk $vmid debian-13-genericcloud-amd64.qcow2 local-lvm
qm set $vmid --scsihw virtio-scsi-pci --scsi0 local-lvm:vm-$vmid-disk-0
qm set $vmid --ide2 local-lvm:cloudinit
qm set $vmid --boot c --bootdisk scsi0
qm set $vmid --agent enabled=1
qm template $vmid
```

## Create a VM from template (example for trixie)
```
newid=9102
qm clone 9001 $newid --name dns-warden-trixie
qm set $newid --memory 4096 --cores 2
qm resize $newid scsi0 20G
qm set $newid --ipconfig0 ip=192.168.1.105/24,gw=192.168.1.1
qm set $newid --nameserver 1.1.1.1
qm set $newid --sshkey /root/id_ed25519.pub
qm set $newid --ciuser debian
qm set $newid --cipassword ''
qm set $newid --net0 virtio,bridge=vmbr0,tag=1
qm set $newid --ciupgrade 1
qm start $newid
```

`agent: enabled=1` exposes the Proxmox device but does not install the guest
package. Ensure `qemu-guest-agent` is present in the template or install it in
the clone. The 20 GB resize is intentional: the 3 GB cloud-image base is too
small for Docker, build layers, and Torhole runtime data.

## Optional cloud-init user-data snippet
```
cat > /var/lib/vz/snippets/userdata-$newid.yml <<'YAML'
#cloud-config
package_update: true
packages: [sudo, curl, gnupg, python3, qemu-guest-agent, git, vlan]
users:
  - name: ubuntu
    groups: sudo
    ssh_authorized_keys:
      - ssh-ed25519 AAAA...yourkey
runcmd:
  - systemctl enable --now qemu-guest-agent
YAML
qm set $newid --cicustom "user=local:snippets/userdata-$newid.yml"
```

## Notes
- `tag=1` assumes untagged mgmt on vmbr0; change to your mgmt VLAN tag if needed.
- Ensure vmbr0 carries VLANs 1/50/99 from the switch; Docker macvlan inside the VM will create per-VLAN interfaces for Pi-hole endpoints.
- After boot, run the Ansible playbook from your control node (see README-ANSIBLE.md) with `--check` for a dry run, then full apply.
