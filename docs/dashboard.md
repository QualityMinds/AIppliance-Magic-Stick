# Magic Stick Dashboard

The Magic Stick Dashboard is the user interface for the Appliance control
plane. It is a client of the Kubernetes API, the `Appliance` status surface,
and the runtime `ModuleActivation` and `AppInstance` CRs. It does not directly
install workloads.

```text
Dashboard UI
  -> Dashboard Backend API
  -> Kubernetes API
  -> ModuleActivation and AppInstance CRs
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
| Instances | Creates example OpenClaw and KubeOpenCode requests by creating or patching `AppInstance` CRs. |
| Models | Shows model-catalog state and offers LiteLLM/model-catalog enable actions. |
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

## RBAC

The dashboard ServiceAccount is `dashboard/ai-appliance-dashboard`. Its
ClusterRole is intentionally limited:

- `get`, `list`, `watch`, `create`, `patch`, `update` on
  `moduleactivations.appliance.magicstick.dev` and
  `appinstances.appliance.magicstick.dev`
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
- `Appliance.status.conditions`
- Flux Kustomization `Ready` conditions
- Pod phase summaries
- service and ingress discovery data
- ingress URLs from `spec.rules[].host`

If the API cannot read the Appliance CR, the UI reports the API error and
leaves workload reconciliation to the Operator and Flux.

## Public-Safe Values

Examples use only `example.local`, `example.com`, `CHANGEME`, and documented
variables. Real domains, model names, private repository paths, credentials,
kubeconfigs, and customer values belong in private overlays.
