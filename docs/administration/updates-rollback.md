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

Older Linux-wrapper installations may still be commit-pinned. They are not
silently migrated. To opt in, back up `/etc/default/ai-appliance-repo`, change
only `MAGICSTICK_PUBLIC_REF=main` and `MAGICSTICK_PUBLIC_REF_KIND=branch`, then
run the existing convergence command below and check the Flux source/applied
revision. Preserve every other local value and do not rerun initial setup.

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
installed host workflow. Flux separately reconciles its configured source.
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
