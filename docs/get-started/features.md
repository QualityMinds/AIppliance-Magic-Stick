# Features and limitations

## What you can do

- Run local models with Ollama or vLLM on eligible CPU/GPU targets.
- Create and edit Ollama, vLLM and experimental vLLM-Omni in one local-model
  configuration form, with shared runtime/CPU controls and engine-specific
  source, hardware and memory options.
- Detect whether a local model provides Chat or Embedding from its metadata;
  choose its task manually only when it is unknown.
- Use NVIDIA GPUs on one node, including different GPU models and capacities, to
  [split one model or run independent copies](../administration/gpu-sharing.md#one-model-across-several-nvidia-gpus)
  behind one LiteLLM model name, with explicit per-card allocation through NVIDIA DRA.
- Experiment with Realtime by selecting the vLLM-Omni profile in that form.
- Connect external model providers and use a common LiteLLM API.
- Give every application instance its own LiteLLM inference key, with automatic
  creation, suspension, rotation and cleanup; application workloads receive no
  LiteLLM administrator key.
- Preserve known tool, image-input and reasoning capabilities through the
  [shared model catalog](../reference/model-catalog.md#model-capabilities) and
  native agent configurations, including explicit unsupported capabilities.
- Create applications from the service catalog and grant access to specific users or groups.
- Keep separate OpenClaw and KubeOpenCode model choices while sharing the common
  model catalog. Catalog updates preserve each instance's selection.
- Choose separate initial chat and embedding models for AnythingLLM in
  **Services → Configure**, or use the catalog defaults. Retain its own model
  preferences across restarts. Existing installations need the
  [one-time settings migration](../administration/updates-rollback.md#anythingllm-persistent-settings-migration).
- Create Hermes instances with an explicit LiteLLM model and open the current
  Hermes dashboard through the common SSO access controls, with persistent
  sessions and workspaces.
- Create [Paperclip](../reference/paperclip-agents.md) instances for companies,
  tasks and OpenCode agents, with isolated Kubernetes workspaces, LiteLLM models
  and the common SSO access controls. The current sandbox runtime requires AMD64.
- Run the optional [Pi Coding Agent](../user-guide/applications.md#pi-coding-agent)
  from **Services**, with a browser terminal, model selection, SSO access controls,
  and persistent workspaces and sessions.
- Share running local chat models through the opt-in Private Mesh module.
- Manage local users, GPU allocation, host networking, model cache and Ubuntu updates.
- Use the browser dashboard or authenticated CLI/TUI; advanced users can manage runtime resources.

## What is not automatic

A detected GPU is not proof that every engine or model will run. The dashboard
checks engine capabilities, driver readiness, allocation slots and memory data.
See the [compatibility matrix](../reference/compatibility.md).

GPU sharing permits more workloads to use a device; it does not multiply its
physical memory or provide isolated VRAM limits. Memory estimates do not prove
that a particular context length will fit. Downloading large checkpoints may
also need substantial disk space beyond their final size.

Multi-GPU placement requires NVIDIA cards on the same node and DRA with known
physical capacities. A split model divides its budget evenly: the smallest
selected card's unreserved budget bounds every share and therefore the total.
Each independent copy needs its own full memory budget. Engines, model formats
and quantizations must work on every selected card; mixed-vendor and multi-node
groups are unsupported. Physical multi-GPU inference and throughput still
require acceptance on the intended hardware.

vLLM-Omni has its own runtime boundaries. An OpenAI-compatible
chat endpoint does not automatically provide `/v1/realtime` or audio output.

Pi requires GitHub access when creating or recreating its runtime. Each instance
accepts one browser connection at a time, and its users share files and sessions.

Hermes 0.21.5 requires a chat model with at least 64,000 configured context tokens.
Unknown context metadata needs an administrator to declare the actual supported
limit before the instance can be installed or upgraded.

There is no appliance-wide one-click backup/restore or supported factory-reset
button. [Backup and recovery](../administration/backup-recovery.md) requires a
planned, separately tested procedure. A Flux update does not upgrade the Ubuntu release.

## Access and licensing

Local identity, model runtimes, GPU management, Resource Sharing and Private Mesh
do not require a license file. Federated SSO requires Free Registered or Commercial
activation. Technical activation and legal permission for production use are
different questions; [LICENSING.md](../../LICENSING.md) and [LICENSE](../../LICENSE)
are the authoritative terms.

See [license management](../administration/licenses.md) for the dashboard workflow.
