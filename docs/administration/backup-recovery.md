# Backup and recovery

Magic Stick has no appliance-wide backup/restore button. This is an administrator
runbook, not a claim that a disaster-recovery drill has passed on your hardware.
Agree a recovery target, retention period and maintenance window before using it.

## 1. Inventory what must survive

| Data | Why it matters |
|---|---|
| Kubernetes datastore and its decryption/bootstrap material | Runtime activations, identity Secrets, installation ID, settings and resource ownership |
| Identity and LiteLLM databases | Users, groups, provider configuration, keys and catalog administration |
| Application PVCs and external databases | Documents, conversations and application-specific state |
| Private Mesh state PVC and service Secret | Device identity, membership and associated credentials |
| Host configuration | Source/ref, Netplan, trusted CAs, K3s configuration and host-management policy |
| External dependencies | DNS, storage credentials, provider keys and separately operated services |

Model weights can usually be downloaded again, subject to access and license terms.
Cache cleanup is not a backup. A manifest export does not include volume contents;
a disk copy taken while databases are writing may not be application-consistent.

## 2. Prepare a consistent backup

1. Record source commit, image digests, OS/kernel, K3s version, storage drivers and
   database versions. Inventory PVC-to-volume/host-path mappings and external stores.
2. Stop new user traffic and local model workloads deliberately. Quiesce application
   writers and use each database's supported backup tool or coordinated volume snapshot.
3. Back up Kubernetes using the actual datastore type. K3s requires its server
   token as well as datastore contents. SQLite uses its server `db` directory;
   embedded etcd uses the snapshot procedure; external databases use their own
   backup mechanism. Follow the [K3s backup guide](https://docs.k3s.io/datastore/backup-restore)
   and [etcd snapshot instructions](https://docs.k3s.io/cli/etcd-snapshot) for the installed version.
4. Back up all persistent application data and required host files within the same
   consistency plan. For custom/multi-node storage, use the storage provider's
   procedure; do not assume everything lives on the first node's root filesystem.
5. Encrypt backups, restrict access, store a copy off the appliance and record
   checksums. The datastore, host configuration and application backups can contain
   credentials. Keep decryption keys recoverable independently of the lost appliance.
6. Resume service and verify login plus a small model/application request.

For an existing Kubernetes cluster, the platform team owns datastore, Secrets and
storage backup. Do not apply a single-node K3s procedure to that cluster.

## 3. Restore in isolation

1. Choose an isolated recovery host/network and preserve the original failed system.
   Do not run two copies of the same appliance identity on the production network.
2. Restore a compatible OS/runtime and the recorded release configuration. Stop
   automatic reconciliation while restoring; otherwise controllers may mutate an
   incomplete data set. Do not create a new first-run marker or new installation ID.
3. Restore the Kubernetes datastore with its required token/keys using the matching
   K3s or platform procedure. Restore Secrets and runtime state as a consistent set.
4. Restore PVC data, database backups, permissions and volume mappings before
   allowing their applications to write. Keep database and image versions compatible.
5. Restore host networking/trust configuration with console access, adapting addresses
   deliberately. Do not blindly overwrite the recovery machine's active network config.
6. Resume controllers, then identity, routing, application databases, applications
   and model runtimes. Review errors before reconnecting users or Mesh peers.

The signed license export alone does not restore its installation binding. Restore
the original installation identity with its state, or arrange a properly reissued
license. Never copy the manufacturer's signing key onto an appliance.

## 4. Accept the recovery

Record the backup ID, source revision, environment and results of:

- local administrator login and independent recovery access;
- user/group permissions and application sharing;
- application data reads and writes;
- API key behavior and a real inference request for each required engine;
- GPU readiness, routes, certificates and DNS;
- Private Mesh membership and intended model sharing, when used;
- license binding and optional Federated SSO, without losing local login.

A green Pod or successful archive extraction is not a successful recovery drill.
Keep restore results as dated operational evidence, separate from this current runbook.
