# Private Mesh architecture

## Architecture and request paths

```text
Local app A ────────────────────────────────────────> LiteLLM A → Local runtime A
                                                        ^
                                                        | restricted share key
App B → LiteLLM B → Mesh B → Mesh A → loopback Export Bridge
Laptop C ──────────→ Mesh C ────┘

Dashboard → authenticated Dashboard API → MeshService
                                           ├── signed membership / invites
                                           ├── Model Sync → LiteLLM management API
                                           └── supervised MeshLLM + endpoint plugin
```

The bridge's only inference upstream is LiteLLM. vLLM and Ollama use
**Bridge → LiteLLM A → KubeAI → model runtime A**; FreeToken uses
**Bridge → LiteLLM A → the operator-managed FreeToken Service**. The bridge
never connects directly to an inference engine. The module's
NetworkPolicy permits LiteLLM but not direct model-runtime HTTP egress. A NetworkPolicy-
enforcing CNI is required; Kubernetes administrator and host-root privileges are
outside this application boundary.

| Model name | Meaning | Owner |
|---|---|---|
| `local/qwen` | Explicit local engine route | Mesh Model Sync |
| `share/stick-a/qwen` | Explicitly published alias of the same local backend | Mesh Model Sync; restricted export key only |
| `mesh/stick-a/qwen` | Imported remote route through Mesh | Mesh Model Sync |
| `qwen` | Logical group: ready local deployment at order 0, remote alternatives at order 1 | Existing catalog + scoped Mesh deployments |

LiteLLM's native order-based routing chooses local first and provides remote
fallback. Explicit aliases remain deterministic. Existing external-provider
groups are not taken over. Catalog output hides `share/` deployments and groups
multiple deployments under one public model name. Owned deployments use stable
IDs and fingerprints; repeated syncs do not duplicate them or restart LiteLLM.

Ready local `kubeai.org/Model` resources with an actual UID and engine VLLM or
OLlama are eligible. FreeToken is discovered from enabled, Ready local
`ModelActivation` resources with a UID and an operator-reported `/v1` Service
endpoint inside their target namespace. No extra model instance is started.
Deleting, stopping or losing readiness removes the active export; its saved
sharing settings remain for the next start. Discovery failure clears the local
allowlist instead of continuing to export stale backends. Conflicting local
names are not exported.

Mesh inventory and arbitrary LiteLLM names cannot establish local provenance.
External-provider routes and imported mesh models are never re-exported.
The engine-independent sharing path supports text chat, tool descriptions and
streaming chat. Embeddings, Responses API and multimodal requests remain outside
this interface; backend-specific feature limitations still apply.
