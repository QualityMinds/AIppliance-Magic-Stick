# Updates and rollback

## Release channels

Normal new installations resolve a verified stable product release once and stay
fixed to its Git tag and approved commit. `main` is the integration/development
trunk, not the stable version. Existing main/custom-branch/commit installations
keep their current selection until an administrator explicitly changes it.

Host convergence and Flux use the same approved commit; Flux never independently
follows a semver range or a moving latest tag. A new GitHub release is discoverable
but does not update existing version-pinned devices automatically. No stable
release, an offline catalog or an incompatible old release produces a clear
unavailable state, never a fallback to main or a prerelease. See the
[release process](../development/releases.md).

## Choose a software channel

On a standard managed host (`readonly-public`), open **System → Settings →
Updates → Magic Stick software** as an administrator.

| Selection | Behavior |
|---|---|
| Released version | Choose an immutable published product version; fixed Ansible/Flux commit |
| Development · main | Explicitly follows future integration commits, including host automation |
| Other branch (advanced) | Explicitly follows a trusted existing feature/custom branch |
| Other tag (advanced) | Exact reviewed tag; semantic product tags still require release verification |
| Exact commit (advanced) | Fixed full 40-character commit ID, including local recovery choices |

1. Choose **Released version**, then a version. Prereleases are hidden unless
   **Show prereleases** is enabled. Legacy releases without verified manifests
   remain visible but disabled; installer/mesh component downloads are not product
   versions. **Refresh versions** only reads metadata and preserves your draft.
2. Select **Check channel**. The host resolves the exact tag/commit and verifies
   the immutable release manifest, original license record, coordinated dashboard
   images, operator and runner pins. Critical images must be publicly available
   for the host architecture. Runtime/source mismatches are rejected; unchanged
   compatible images may be reused. This is not a model/GPU/upgrade acceptance test.
3. Review the resolved revision, release notes and per-version BUSL-1.1 publication/
   MIT Change Date. Third parties retain their licenses; installing software does
   not grant a commercial entitlement. Discovery/update requires no entitlement.
4. Select **Apply channel** and confirm the computer name. Existing identity,
   current-preview, idle/maintenance and recovery checks remain mandatory.
5. Verify host/cluster revisions and **Running software details** after success.
   The dashboard may reconnect while services restart.

A preview expires after 15 minutes. A moved tag, changed release proof or branch
advance invalidates it. Version-aware hosts additionally retain the approved
commit/tag identity permanently, so ordinary later convergence cannot silently
follow a moved product tag. Old host workers can retain their settings and use
compatible advanced refs but cannot pretend to support verified version selection.
Historical releases without the management contract need local recovery instead
of a dashboard downgrade. External GitOps remains owned by its deployment repo.

The root-owned `/etc/default/ai-appliance-repo` is the single durable desired
configuration. Version selection saves `MAGICSTICK_PUBLIC_REF`, `_REF_KIND`,
`_REF_COMMIT` and `_TAG_OBJECT`; domain, storage and other installation settings
are preserved. No second selection is stored in a dashboard ConfigMap. The host
runs Ansible and gives Flux the same commit after all checks. The existing
15-minute convergence timer does not authorize an update over active workloads.
Software rollback cannot undo database migrations or Ubuntu upgrades.

## Three separate update paths

| Layer | Managed through | Important boundary |
|---|---|---|
| Ubuntu packages | [System → Settings → Updates](ubuntu-updates.md) | Current Ubuntu release only; hardware packages have separate exclusions |
| Host configuration | The installed Ansible convergence service | Does not perform an Ubuntu release upgrade |
| Cluster configuration and images | The configured Flux source and reviewed image pins | Building or pushing an image alone does not change a pinned Deployment |

## Before an update

Record the current source revision, image digests, OS/kernel, K3s version and
installed model/application state. Make a [recoverable backup](backup-recovery.md),
review release notes and arrange a maintenance window. Do not assume every GPU
combination was tested because generic CI passed.

## Apply and verify

Use the installation's chosen source/ref rather than editing a temporary checked-out
file. On a managed host, `sudo /usr/local/sbin/ai-appliance-converge` invokes the
installed host workflow. Flux reconciles the commit selected by that workflow.
Follow [platform checks](troubleshooting/platform.md) and
[image promotion](../development/image-promotion.md) for diagnosis and release work.

Verify local login/recovery, routes, storage, GPU registration and one inference
request for every engine you depend on. A disconnected server can reconcile when
it returns only if its configured source includes the change; no offline rollout
is claimed until live state is checked.

## AnythingLLM persistent settings migration

The update to AnythingLLM 1.17.0 persists its native `/app/server/.env` file as
`anythingllm.env` on the existing storage PVC. Older Magic Stick deployments only
persisted `/app/server/storage`; global preferences changed in AnythingLLM were
still in the old container's filesystem. Before replacing that Pod, save those
preferences inside its storage volume:

```sh
kubectl -n ai exec deployment/anything-llm -- node -e '
const fs = require("node:fs");
const path = require("node:path");
const target = path.join(process.env.STORAGE_DIR, "anythingllm.env");
fs.copyFileSync("/app/server/.env", target, fs.constants.COPYFILE_EXCL);
fs.chmodSync(target, 0o600);
console.log("AnythingLLM settings saved on persistent storage");
'
```

The command copies directly within the Pod and does not display settings or
credentials. `COPYFILE_EXCL` refuses to overwrite an existing migration file;
if it already exists, preserve and review that file before proceeding. Back up
the whole volume, including the database, documents and this settings file,
using the [backup procedure](backup-recovery.md).

Apply the reviewed update through the normal source/channel path. Initialization
fills only missing preferences from the model catalog and mounts the saved file
for the native application. Check the selected chat model, context limit and
embedding model after startup, then test a chat and document search. Keep the
embedding model used for existing indexes unless intentionally reindexing them.

If the old Pod has already been replaced without this copy, the update cannot
recover its ephemeral global preferences. Restore them from a backup or re-enter
them in AnythingLLM. Persistent documents and workspace data remain on the PVC.
The new image runs upstream database migrations; an image downgrade alone is
not a database rollback. Restore a consistent pre-upgrade backup when needed.

## Rollback

Select a previously reviewed source revision/image set in the authoritative
configuration. Assess CRD, database and application data migrations first: rolling
back container images is not guaranteed to roll back data safely. Restore a
consistent backup when required, and test recovery in isolation before production.
Never recreate first-run setup as a rollback shortcut.

Before applying a channel, the worker saves the previous commit, metadata and
local recovery implementation. After an interrupted or failed apply, automatic
host convergence is paused. Review the reported failure, then check and apply a
corrected channel. **Select previous revision** prepares a commit draft for a
compatible prior version; it does not bypass checks or apply immediately.

If the dashboard is unavailable, use SSH or the local console:

```sh
sudo journalctl -u magicstick-software-channel.service --no-pager -n 100
sudo /usr/local/sbin/magicstick-software-recover
```

Recovery runs the saved host runner, restores the previous commit and leaves it
**commit-pinned**. Select a branch again after verifying the appliance. It does
not restore databases, models, application data, OS packages, firmware or K3s.
The recovery snapshot survives an apply retry and is replaced by the next new
successful-switch attempt. Do not delete maintenance state to force a retry.
