# Magic Stick Dashboard

The Magic Stick Dashboard is the user interface for the Appliance control
plane. It is a client of the Kubernetes API, the `Appliance` status surface,
and the runtime `ModuleActivation`, `AppInstance`, and `ModelActivation` CRs.
It does not directly install workloads.

```text
Dashboard UI
  -> Dashboard Backend API
  -> Kubernetes API
  -> ModuleActivation, AppInstance, and ModelActivation CRs
  -> Magic Stick Operator
  -> Flux Kustomizations and specialized operator CRs
```

## Role

The dashboard may:

- read the default `Appliance/local` resource
- read `ConfigMap/magicstick-module-catalog`
- create or patch `ModuleActivation` CRs when a user enables or disables a
  module
- create or patch `AppInstance` CRs when a user requests an app or agent
  instance
- create or delete `ModelActivation` CRs when a user adds or removes a local
  KubeAI model or external LiteLLM-backed provider model
- create Dashboard-managed provider API key Secrets in namespace `ai`
- read status from `Appliance.status`, Flux Kustomizations, Pods, Services,
  Ingresses, ConfigMaps, and Events

The dashboard must not replace the Magic Stick Operator, Flux, OpenClaw,
Hermes, Paperclip, or KubeOpenCode. Workload lifecycle remains owned by those
controllers.

## MVP Pages

| Page | Purpose |
|---|---|
| Overview | Shows `Appliance.status.phase`, enabled module count, requested instance count, and current conditions. |
| Modules | Enables or disables modules by creating or patching `ModuleActivation` CRs. |
| Instances | Creates example OpenClaw, Hermes, Paperclip, and KubeOpenCode requests by creating or patching `AppInstance` CRs. |
| Models | Adds/removes local and external models, shows VRAM, and controls the model stack including AnythingLLM. |
| System Status | Shows Flux Kustomization readiness, Pod phase summary, and ingress hosts. |

The existing ingress discovery dashboard remains available on the same page.

## Backend API

The dashboard Deployment runs an API sidecar from
`ConfigMap/ai-appliance-dashboard-api`. nginx proxies `/api/*` to the sidecar.

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/appliance` | Returns `Appliance/local`. |
| `PATCH` | `/api/appliance` | Returns `405`; `Appliance/local.spec` is Git-owned. |
| `GET` | `/api/modules` | Returns module catalog plus current `ModuleActivation` spec/status. |
| `POST` | `/api/modules/{name}/enable` | Creates or patches `ModuleActivation/<name>` with `spec.enabled: true`. |
| `POST` | `/api/modules/{name}/disable` | Creates or patches `ModuleActivation/<name>` with `spec.enabled: false`; the Magic Stick Operator removes the generated Flux `Kustomization`. |
| `GET` | `/api/instances` | Returns `AppInstance` resources and status. |
| `POST` | `/api/instances/openclaw` | Adds or replaces an OpenClaw `AppInstance`. |
| `POST` | `/api/instances/hermes` | Adds or replaces a Hermes `AppInstance`. |
| `POST` | `/api/instances/paperclip` | Adds or replaces a Paperclip `AppInstance`. |
| `POST` | `/api/instances/kubeopencode` | Adds or replaces a KubeOpenCode `AppInstance`. |
| `GET` | `/api/models` | Returns model catalog entries, `ModelActivation` resources, model presets, AnythingLLM status, and VRAM summary. |
| `POST` | `/api/models/local` | Adds or replaces a local KubeAI-backed `ModelActivation`. |
| `POST` | `/api/models/external` | Adds or replaces an external LiteLLM provider `ModelActivation`; UI-entered API keys are stored as Secrets. |
| `DELETE` | `/api/models/{name}` | Deletes the `ModelActivation` and a Dashboard-created provider Secret when present. |
| `GET` | `/api/status` | Returns Appliance, Flux, Pod, Service, and Ingress status summaries. |
| `GET` | `/api/events` | Returns core and `events.k8s.io` event summaries. |

## Example UI Flows

Enable LiteLLM:

```http
POST /api/modules/litellm/enable
```

Enable OpenClaw Operator:

```http
POST /api/modules/openclaw-operator/enable
```

Create OpenClaw:

```http
POST /api/instances/openclaw
Content-Type: application/json

{
  "name": "default",
  "enabled": true,
  "namespace": "ai",
  "model": "CHANGEME_MODEL",
  "storage": {
    "size": "20Gi"
  },
  "ingress": {
    "enabled": true,
    "host": "openclaw.example.local"
  }
}
```

Create Hermes:

```http
POST /api/instances/hermes
Content-Type: application/json

{
  "name": "default",
  "enabled": true,
  "namespace": "ai",
  "model": "qwen3635b",
  "storage": {
    "size": "10Gi"
  },
  "ingress": {
    "enabled": true,
    "host": "hermes.example.local"
  }
}
```

Additional Hermes instances can be requested by choosing a different `name`
and `ingress.host`. The Magic Stick Operator renders each request as an
operator-managed `HermesInstance` and configures it from the LiteLLM-backed
model catalog.

Create Paperclip:

```http
POST /api/instances/paperclip
Content-Type: application/json

{
  "name": "default",
  "enabled": true,
  "namespace": "ai",
  "storage": {
    "size": "5Gi"
  },
  "database": {
    "managed": {
      "storageSize": "10Gi"
    }
  },
  "ingress": {
    "enabled": true,
    "host": "paperclip.example.local"
  }
}
```

Enable KubeOpenCode:

```http
POST /api/modules/kubeopencode/enable
```

Create KubeOpenCode:

```http
POST /api/instances/kubeopencode
Content-Type: application/json

{
  "name": "default",
  "enabled": true,
  "namespace": "ai",
  "model": "CHANGEME_MODEL",
  "server": {
    "enabled": true,
    "ingress": {
      "enabled": true,
      "host": "kubeopencode.example.local"
    }
  },
  "agentTemplates": [
    {
      "name": "default-coder",
      "description": "Default coding agent template"
    }
  ]
}
```

For KubeOpenCode, the Dashboard still creates only an
`AppInstance/kubeopencode-*`. The Magic Stick Operator renders that request
into an `AgentTemplate` plus an `Agent` that references the template. The
requested `model` is treated as a preference: if it is not present in
`ConfigMap/ai-model-catalog`, the generated template falls back to
`catalog.defaultChatModel`, then to the first catalog chat model. Task Pods are
created later by KubeOpenCode when a task is started against the Agent.

Add a local preset model:

```http
POST /api/models/local
Content-Type: application/json

{
  "name": "qwen359b",
  "enabled": true,
  "targetNamespace": "ai",
  "local": {
    "preset": "qwen359b",
    "vram": "16Gi",
    "contextWindow": 8192,
    "maxNumSeqs": 32
  }
}
```

Add an external provider model:

```http
POST /api/models/external
Content-Type: application/json

{
  "name": "example-openai-gpt-4o-mini",
  "enabled": true,
  "targetNamespace": "ai",
  "external": {
    "model": "openai/gpt-4o-mini",
    "apiBase": "https://api.openai.com/v1",
    "modelType": "chat",
    "contextWindow": 128000,
    "apiKeySecretRef": {
      "name": "external-openai-api-key",
      "key": "api-key"
    }
  }
}
```

## RBAC

The dashboard ServiceAccount is `dashboard/ai-appliance-dashboard`. Its
ClusterRole is intentionally limited:

- `get`, `list`, `watch`, `create`, `patch`, `update` on
  `moduleactivations.appliance.magicstick.dev` and
  `appinstances.appliance.magicstick.dev`
- `get`, `list`, `watch`, `create`, `patch`, `update`, `delete` on
  `modelactivations.appliance.magicstick.dev`
- namespaced `get`, `create`, `patch`, `update`, `delete` on Secrets in
  namespace `ai` for Dashboard-created provider credentials
- `get` on the DCGM exporter service proxy for live VRAM metrics
- `get`, `list`, `watch` on `appliances.appliance.magicstick.dev`
- `get`, `list`, `watch` on Flux Kustomizations
- `get`, `list`, `watch` on Pods, Services, Ingresses, ConfigMaps, and Events

It does not have cluster-admin and does not have permission to create
workloads directly.

## Status Mapping

The dashboard displays:

- `Appliance.status.phase`
- `Appliance.status.modules`
- `Appliance.status.instances`
- `Appliance.status.models`
- `Appliance.status.conditions`
- model-catalog `catalog.json`
- `ModelActivation.status`
- DCGM framebuffer memory metrics when available
- Flux Kustomization `Ready` conditions
- Pod phase summaries
- service and ingress discovery data
- ingress URLs from `spec.rules[].host`

If the API cannot read the Appliance CR, the UI reports the API error and
leaves workload reconciliation to the Operator and Flux.

## Public-Safe Values

Examples use only `example.local`, `example.com`, `CHANGEME`, and documented
variables or public model preset identifiers. Real domains, private repository
paths, credentials, kubeconfigs, and customer values belong in private overlays.
