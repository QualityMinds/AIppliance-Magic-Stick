# Updates and rollback

## Release channels

All installation paths follow `main` by default. It is the release channel;
only reviewed release changes belong there. Development builds use `develop`
and must be selected explicitly (for example `--ref develop` in the Linux and
Kubernetes installers, or the public-ref option in the USB builder). The branch
must exist in the selected repository. A version tag or full commit remains an
explicit fixed-version option, not the default.

Branch followers receive changes through the existing host-convergence timer and
Flux reconciliation. They do not poll GitHub Release objects: merging to `main`
already makes that configuration eligible for rollout. A tag alone does not
promote new image digests. Development image builds and digest promotions must
stay on `develop` until release review. See [release process](../development/releases.md).

Older installations may still be commit-pinned. They are not silently migrated.
Once a channel-capable version is installed, use the dashboard to opt in. Do not
rerun initial setup to change channels.

## Choose a software channel

On a standard managed host (`readonly-public`), open **System → Settings →
Updates → Magic Stick software** as an administrator.

| Selection | Behavior |
|---|---|
| Stable · main | Follows reviewed changes on `main`; the installation default |
| Development · develop | Follows development changes, including host automation |
| Other branch | Follows an existing branch such as `feature/my-change` |
| Fixed tag | Uses an existing tag; version tags must never be moved |
| Fixed commit | Pins the exact 40-character commit ID |

1. Select the channel and, when requested, enter its exact name.
2. Select **Check channel**. The host resolves the ref and checks that the
   dashboard, API, console and operator runtime images are published, digest-pinned
   and available for its Linux architecture. The dashboard/API/console pins must
   refer to one build. This is not a GPU, model or every-optional-image acceptance test.
3. Review the resolved revision. Select **Apply channel** and confirm the computer
   name. Services and the dashboard may reconnect during the change.
4. Wait for success, then inspect the host and cluster revisions. Running image
   identifiers are available under **Running software details**.

A check expires after 15 minutes. If the branch/tag moves after review, application
is rejected and a new check is required. A channel without compatible software
management (`magic-host/software-channel.json`) is rejected before changing the
host. Historical releases without that contract need local recovery instead of
a dashboard downgrade. External GitOps installations remain owned by their
deployment repository and do not expose this switch.

The root-owned `/etc/default/ai-appliance-repo` remains the single durable desired
configuration, not a historical leftover. The host saves only the selected ref
and ref kind; domain, storage and other installation settings are preserved.
There is no second channel stored in a dashboard ConfigMap. On each normal
15-minute convergence cycle the host resolves the selected branch, checks its
critical image pins and runs Ansible from that commit. Flux is then given that
same **commit**, preventing its branch watcher from advancing ahead of Ansible.
There is no need to rebuild an unchanged container: the selected Git revision
can reuse an existing published digest. Image builds alone do not deploy images.

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
