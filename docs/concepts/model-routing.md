# Inference engines and model routing

The AI model catalog is the central model registry for the AI Appliance. It
turns selected KubeAI `Model` resources, Magic Stick-managed FreeToken
runtimes, and optional external model entries into LiteLLM deployments, then
publishes a generated `ai-model-catalog` ConfigMap for apps that need a stable
source of model metadata.

The catalog is accelerator-neutral. External models work with LiteLLM alone.
Local `ModelActivation` resources use vLLM or Ollama through KubeAI on an
explicit `cpu`, `nvidia-gpu`, `amd-gpu`, or `intel-gpu` compute target.
FreeToken uses the same `ModelActivation` contract but its own direct runtime
adapter on its supported NVIDIA target. KubeAI is installed for the former
engines; the matching vendor provider is required only for an accelerator
target.

## Responsibilities

The optional [Private Mesh service](../user-guide/private-mesh.md) separately owns `local/`,
`share/`, `mesh/` aliases and remote logical fallbacks. The catalog does not
replace those deployments, hides export-only routes and deduplicates logical
model names. Its ready local vLLM routes carry order 0 and trusted scheduler
metadata; Mesh fallbacks carry order 1. Aliases do not create new KubeAI models.

- Watch KubeAI `Model` resources and FreeToken runtime Deployments, publishing
  only a ready, healthy local model.
- Read optional external model definitions from `ConfigMap/ai-external-models`.
- Read external runtime model requests from `ModelActivation` resources in
  namespace `ai-system`.
- Create, update, and remove AI Appliance managed models in LiteLLM.
- Publish generated catalog files in `ConfigMap/ai-model-catalog`.
- Update KubeOpenCode `AgentTemplate` resources when available.
- Restart known model-catalog consumer pods after catalog changes.

The base lives at `magic-cluster/apps/ai/model-catalog` and is included by the
public `magic-cluster/apps/ai` base.

## Resources

| Resource | Purpose |
|---|---|
| `Deployment/ai-model-catalog-controller` | Runs the Python reconciliation loop. |
| `ConfigMap/ai-external-models` | Optional user-provided model definitions. The public base is empty. |
| `ConfigMap/ai-model-catalog` | Generated catalog consumed by apps. Starts as a bootstrap placeholder. |
| `ServiceAccount/ai-model-catalog-controller` | Runtime identity for the controller. |
| `Role/ai-model-catalog-controller` | Allows reading models, configmaps, secrets, pods, and AgentTemplates. |

## Reconciliation Flow

1. The controller lists KubeAI `Model` resources when the KubeAI CRD exists
   and selects only resources with `status.replicas.ready` greater than zero.
   It also reads a FreeToken activation's generated runtime endpoint only after
   its Deployment is Ready and the engine's `/health` endpoint reports success.
2. It reads `ai-external-models.data["models.json"]` when present.
3. It reads enabled external `ModelActivation` resources when present.
4. It builds the desired LiteLLM model set and marks those models with
   `ai_appliance_managed=true`.
5. It calls LiteLLM `/model/new` or `/model/update` for desired models.
6. It deletes stale LiteLLM models only when they were previously marked as AI
   Appliance managed.
7. It writes generated catalog data to `ConfigMap/ai-model-catalog`.
8. It updates configured KubeOpenCode AgentTemplates with the generated chat
   model list.
9. If the catalog hash changed, it deletes known consumer pods so their owning
   controllers recreate them with the new catalog.
