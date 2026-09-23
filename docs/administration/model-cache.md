# Model cache and storage

## Model cache cleanup

Use **System → Model cache** to inspect disk space and clear downloaded model
files after stopping local models. It preserves model definitions, credentials,
container images and application data. FreeToken's temporary cache is released
with its Pod when the model is stopped. See [scope, safety and rollout](model-cache.md).

Administrators open **System → Model cache** (`#/system/model-cache`). Each
managed computer reports system-disk capacity/free space and cached model sizes
for Hugging Face/vLLM, Ollama and FreeToken. This is **disk space**, not RAM or
VRAM. Help is behind information icons. Refresh reads the latest host report;
the host worker samples it on its normal inspection cycle.

**Clear model cache** requires the exact computer name in a confirmation dialog.
The button is disabled for empty caches, active local models, unavailable/stale
workers, Ubuntu maintenance or another host operation. The worker checks live
workloads again before deleting anything and before each cache entry. Stop models
through **Models** first; cleanup never stops them automatically. Unpinned model
activations and any remaining KubeAI Model resource conservatively protect caches
on every node, including scale-to-zero deployments. Existing terminating model
Pods must also disappear before cleanup.

## Scope

- Hugging Face: only `models--*` entries in `/root/.cache/huggingface/hub`.
- Ollama: only `blobs` and `manifests` in `/root/.ollama/models`.
- FreeToken: reports its current `runtime-cache` emptyDir. Stop the FreeToken
  model to release its Pod and temporary cache; this cleanup action never deletes
  a live Kubernetes volume.

Credentials, other user files, dataset/compiler caches, container images,
application databases and model configuration are not removed. Model files must
be downloaded again on the next start. Sizes are allocated filesystem blocks;
actual free-space recovery can differ with open files, snapshots or hard links.
The system-disk figure describes `/`; an administrator's custom cache mounts may
use a different filesystem. No storage is formatted or repartitioned.

## Execution and deployment

The existing administrator-only `POST /api/host-management/operations` accepts
`action: clear-model-cache`, the current cache `planId`, Node UID/boot ID, a unique
request ID and exact-host confirmation. It accepts no path, shell command or
engine-specific override. The immutable `HostOperation` uses the existing host
maintenance lock and status flow (`Preparing` → `Succeeded`/`Failed`). Interrupted
deletion is not replayed automatically; refresh and explicitly approve again.

The operator defers new local model runtime reconciliation while any cache
cleanup request is pending/active. Stop/removal and external models still work.
An enabled model appearing before local deletion causes a safe rejection instead
of deleting its shared cache. Arbitrary root/Kubernetes administrators remain
trusted; this is not protection from out-of-band host modifications.

The root worker uses fixed directories, descriptor-relative traversal without
following parent symlinks, and symlink-resistant deletion. Nested mounts and
incomplete or excessively large/slow scans fail closed. Home remains read-only
in its systemd sandbox except for the two named cache directories. The API stays
unprivileged and receives only a sanitized inventory.

Roll out the host worker/service, HostOperation CRD, controller/RBAC and dashboard
API/web together. Old workers show an unavailable message, not a misleading
enabled cleanup button. Normal host convergence installs the new helper; opening
the page never initiates cleanup or package installation.
