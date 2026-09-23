# Features and limitations

## What you can do

- Run local models with Ollama or vLLM on eligible CPU/GPU targets.
- Use FreeToken's dedicated configuration on its supported NVIDIA hardware.
- Experiment with Realtime through the separate vLLM-Omni profile.
- Connect external model providers and use a common LiteLLM API.
- Create applications from the service catalog and grant access to specific users or groups.
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

FreeToken and vLLM-Omni have their own runtime boundaries. An OpenAI-compatible
chat endpoint does not automatically provide `/v1/realtime` or audio output.

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
