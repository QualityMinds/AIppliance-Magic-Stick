# Realtime troubleshooting

## Qwen3-Omni Realtime operation

Open **Models → Create → Location: Local → Inference Engine: (Experimental) vLLM-Omni**.
Location is not an engine selector and contains only Local and External.
Regular engines appear alphabetically above the experimental FreeToken and
vLLM-Omni options; the labels do not change saved model configurations.

Omni supports **Hugging Face search** and **Direct reference** just like the
regular model discovery workflow. Magic Stick does not reject quantized,
unknown-architecture or incomplete checkpoints and does not fetch config.json
to approve a direct reference. The selected runtime performs loading and reports
its own errors; inspect **Logs**, not an old compatibility allowlist. A valid
direct reference remains usable when Hub discovery is unavailable.

See [Realtime](../../reference/realtime.md) for the new Models create/edit form, immutable Omni
image, GPU allocation requirements and LiteLLM Playground test. Back up LiteLLM's
PostgreSQL database before the bundled 1.84.0 → 1.101.0 upgrade; verify database
migration, existing routes/keys, OIDC and Private Mesh on the test appliance.
Realtime Ready checks deployment generation and `/health`, not actual audio
quality. Live acceptance must include input/output audio, a second turn,
interruptions, authenticated Gateway WebSockets and lifecycle recovery.
Stop/Remove preserve the shared downloaded cache and other models.

The experimental AMD profile is a separate ROCm build of the same Omni revision.
It is no longer tied to Strix Halo, a specific GPU generation, driver inventory
or confirmed memory telemetry. CPU and Intel are also selectable experimental
targets, with a matching image supplied under **Advanced Settings**; an empty
catalog image is not evidence of hardware incompatibility. Default images are
digest-pinned, while per-model runtime overrides may use tags for experiments.
Actual runtime support and upstream parameter validation still apply.
One time-slicing/DRA slot is not two physical GPUs. Coordinate GPU budgets with
other models; RAM/headroom estimates are warnings rather than start blockers.
Do not stop other models or change sharing automatically. See
[experimental boundaries](../../user-guide/models/realtime.md#experimentation-boundary).

If a Realtime activation exists but no Pod appears, inspect its status and the
`magicstick-operator` logs. `RealtimePermissionDenied` (HTTP 401/403) means the
runtime resources cannot be managed by the operator. In particular, verify the
`ai/magicstick-realtime-runtime` Role/RoleBinding grants ConfigMap
get/create/patch/delete to `ai-system/magicstick-operator`; apply the matching
operator RBAC and controller together. The generated stage ConfigMap requires
server-side-apply `patch` permission even on first creation. API failures are
retried automatically; recreating the activation is not necessary. A custom
target namespace needs an equivalent namespaced binding, not cluster-wide
ConfigMap write access.

`no structured config owner: cpu_offload_gb` is a pinned Omni configuration
projection error, not an out-of-memory error. The operator's generated
bootstrap now omits zero offload and applies a source-hash-guarded compatibility
repair for positive offload. See the [repair and verification contract](../../reference/realtime.md#pinned-cpu-offload-compatibility-repair).
Roll out the matching controller; its bootstrap hash recreates the model Pod.
Do not disable upstream argument validation or increase RAM merely to hide
this parser error. Unknown source hashes require reviewing the pinned runtime.
