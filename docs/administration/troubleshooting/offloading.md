# CPU offloading diagnostics

### CPU offloading checks

NVIDIA vLLM/Ollama models can opt into **Use additional system RAM** in the web
form or TUI. The non-interactive CLI accepts the same API fields through
`model create-local --file`. This is same-node weight/layer offloading, not
distributed RAM, swap, or vLLM KV offloading. See [the model contract](../../reference/compute-targets.md#explicit-cpu-offloading-for-nvidia-models).

After creation, inspect the `ModelActivation` and its generated KubeAI Model:

```bash
kubectl -n ai-system get modelactivation example-hybrid -o yaml
kubectl -n ai get model example-hybrid -o yaml
kubectl -n flux-system get helmrelease kubeai
kubectl -n ai get pods -l model=example-hybrid -o yaml
```

For cache configuration, compare requested and effective status and inspect the
generated runtime settings:

```bash
kubectl -n ai-system get modelactivation example-hybrid \
  -o jsonpath='{.status.requestedKvCacheType}{" -> "}{.status.effectiveKvCacheType}{"\n"}'
kubectl -n ai get model example-hybrid \
  -o jsonpath='{.spec.args}{"\n"}{.spec.env}{"\n"}'
```

vLLM must contain exactly one `--kv-cache-dtype=auto` or
`--kv-cache-dtype=fp8`; FP8 also contains `--calculate-kv-scales`. Ollama must
contain `OLLAMA_KV_CACHE_TYPE=f16|q8_0|q4_0` and
`OLLAMA_FLASH_ATTENTION=1`. An empty effective value while requested is present
means the configured runtime has not become Ready; inspect model-pod current and
previous logs instead of assuming fallback.

Confirm that the Pod requests **one** `nvidia.com/gpu` and the selected host RAM,
with `limits.memory` matching the host budget. It must not request more GPUs
when more RAM is selected. The generated profile is read from the optional
`magicstick-offloading-profiles` ConfigMap in `flux-system`. Flux creates its
bootstrap object with SSA `IfNotPresent` and an empty `resourceProfiles` map,
leaving later `data.values.json` changes to the runtime operator; no broad
ConfigMap-create grant is needed. The valid initial values key prevents a Helm
failure when no offloading model has been created yet.
The watch label
requests prompt Flux reconciliation. A new RAM/profile combination updates
KubeAI's configuration and may briefly roll its controller, not existing model
Pods. `Starting`/unknown-profile messages can occur until that rollout completes.
If it remains stuck, inspect HelmRelease conditions and KubeAI controller logs.
Do not remove or overwrite the generated ConfigMap while its profiles are in
use. Profiles are reused; the store is bounded at 750,000 serialized bytes.
Administrator cleanup of unused entries is required if that bound is reached.

For vLLM, logs show `MAGICSTICK_CPU_OFFLOAD_MI` converted to `--cpu-offload-gb`;
the existing VRAM utilization wrapper remains active. KV stays on GPU. For
Ollama CPU offloading, verify `LLAMA_ARG_FIT=on` and the absence of a fixed
`LLAMA_ARG_N_GPU_LAYERS`, then inspect the runtime's `offloaded N/M layers` log
and `/api/ps` after loading. GPU-first auto-fit uses actual free memory, while
the dashboard split remains a proportional preflight estimate. Source-model/runtime
compatibility must be checked on the chosen artifact; estimates cannot make
layers equal in size. Engine-reported RAM/VRAM buffers in the dashboard are distinct from Pod
working set/RSS and startup peak. A warning indicates reported buffers above
the planning budget. If the Pod is OOM-killed, increase host RAM within available
capacity, reduce context, or use a smaller/quantized artifact; never remove the
request/limit to make a failing plan appear successful.

Host capacity uses the maximum on an eligible GPU node after workload requests,
not the sum of memory across nodes. Pending requests are deducted conservatively.
This remains a preflight estimate: concurrent scheduling and GPU selection can
change availability. Kubernetes is the final scheduler, and exact device/node
placement remains a separate feature. AMD/Intel offloading and multiple replicas
are rejected. Legacy models with no `cpuOffloading` field remain unchanged.

The opt-in check below creates a temporary namespace in the explicit
`rancher-desktop` context, verifies the named ConfigMap permissions and
initial store and API permissions, then deletes only that test namespace:

```bash
python3 magic-cluster/platform/magicstick-operator/controller/check_offloading_profile_rbac.py
```

The browser-only smoke test runs against a loopback Vite server with synthetic
API responses, including desktop/mobile overflow, separate budgets, and form
closure after creation. It does not create live model workloads:

```bash
# With the web development server running on 127.0.0.1:5179 and Playwright available:
MAGICSTICK_TEST_URL=http://127.0.0.1:5179 node dashboard/apps/web/offloading_smoke.cjs
```
