# Magic Stick Dashboard

The Magic Stick Dashboard is the user interface for the Appliance control
plane. It is a client of the Kubernetes API and the `Appliance` CR. It does
not directly install workloads.

```text
Dashboard UI
  -> Dashboard Backend API
  -> Kubernetes API
  -> Appliance CR
  -> Magic Stick Operator
  -> Flux Kustomizations and specialized operator CRs
```

## Role

The dashboard may:

- read the default `Appliance/local` resource
- read `ConfigMap/magicstick-module-catalog`
- read status from `Appliance.status`, Flux Kustomizations, Pods, Services,
  Ingresses, ConfigMaps, and Events
- patch or update the `Appliance` CR when a user enables modules or creates
  instances

The dashboard must not replace the Magic Stick Operator, Flux, OpenClaw,
Hermes, Paperclip, or KubeOpenCode. Workload lifecycle remains owned by those
controllers.

## MVP Pages

| Page | Purpose |
|---|---|
| Overview | Shows `Appliance.status.phase`, enabled module count, requested instance count, and current conditions. |
| Modules | Enables or disables modules by patching `spec.modules.<module>.enabled`. |
| Instances | Creates example OpenClaw and KubeOpenCode instance requests by patching `spec.instances`. |
| Models | Shows model-catalog state and offers LiteLLM/model-catalog enable actions. |
| System Status | Shows Flux Kustomization readiness, Pod phase summary, and ingress hosts. |

The existing ingress discovery dashboard remains available on the same page.

## Backend API

The dashboard Deployment runs an API sidecar from
`ConfigMap/ai-appliance-dashboard-api`. nginx proxies `/api/*` to the sidecar.

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/appliance` | Returns `Appliance/local`. |
| `PATCH` | `/api/appliance` | Applies a Kubernetes JSON merge patch to `Appliance/local`. |
| `GET` | `/api/modules` | Returns module catalog YAML plus current module spec/status. |
| `POST` | `/api/modules/{name}/enable` | Sets the module's `enabled` flag to `true`. |
| `POST` | `/api/modules/{name}/disable` | Sets the module's `enabled` flag to `false`. |
| `GET` | `/api/instances` | Returns requested instances and instance status. |
| `POST` | `/api/instances/openclaw` | Adds or replaces an OpenClaw instance request. |
| `POST` | `/api/instances/hermes` | Adds or replaces a Hermes instance request. |
| `POST` | `/api/instances/paperclip` | Adds or replaces a Paperclip instance request. |
| `POST` | `/api/instances/kubeopencode` | Adds or replaces a KubeOpenCode instance request. |
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

- `get`, `list`, `watch`, `patch`, `update` on
  `appliances.appliance.magicstick.dev`
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
