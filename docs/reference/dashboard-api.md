# Dashboard API and authorization

The Magic Stick Dashboard is the user interface for the Appliance control plane.
It reads Kubernetes status and writes runtime intent resources. It does not
directly install workloads, create Flux Kustomizations, or manage app resources
itself.

For the step-by-step end-user workflow after first-run setup, see
[installation/after-installation-dashboard.md](../get-started/first-model.md).

```text
React browser dashboard
  -> Envoy Gateway OIDC login and forwarded access token
Terminal client (CLI or TUI)
  -> Keycloak Device Authorization Flow
  -> Envoy Gateway JWT validation on api.<mDNS-domain>
Both
  -> Dashboard Backend API
     -> Kubernetes API
        -> ModuleActivation, AppInstance, and ModelActivation CRs
        -> Magic Stick Operator
        -> Flux Kustomizations, HelmReleases, and native KubeAI Model resources
     -> dedicated Keycloak user-administration client
        -> Keycloak Admin REST API
     -> dedicated Keycloak federation-administration client
        -> managed OIDC/SAML providers and fixed role mappers
     -> LiteLLM key-management API
        -> named virtual API keys in LiteLLM PostgreSQL
     -> Keycloak Kubernetes access groups
        -> OIDC-authenticated Kubernetes API and RBAC
```

## Role

The dashboard may:

- read `Appliance/local`
- read `ConfigMap/magicstick-module-catalog`
- read `ConfigMap/magicstick-app-catalog`
- read model presets and the generated `ConfigMap/ai-model-catalog`
- read Flux, Pod, Service, Ingress, ConfigMap, Event, and GPU metric status
- read and patch the runtime settings `ConfigMap/ai-appliance-settings`
- create or patch `ModuleActivation` resources for catalog-driven modules
- create or delete `AppInstance` resources for supported instance types
- create or delete `ModelActivation` resources for local and external models
- create Dashboard-managed provider API key Secrets in namespace `ai`
- read the generated LiteLLM UI password and API master key when an operator or
  administrator explicitly opens the module credential panel
- read OpenClaw instance credentials when the generated instance exposes them
- list and administer human Keycloak users when the signed-in actor has
  `magicstick-admin`
- create, list, and revoke Dashboard-managed named LiteLLM virtual keys when
  the signed-in actor has `magicstick-admin`
- assign SSO-bound Kubernetes access to existing Keycloak users and generate
  token-free OIDC kubeconfigs when the signed-in actor has `magicstick-admin`
- validate, create, update, disable, and delete dashboard-owned upstream OIDC or
  SAML providers and exact claim/attribute-to-role mappings when both a live
  administrator and the `federated-sso` entitlement permit it

The dashboard must not replace the Magic Stick Operator, Flux, OpenClaw, Hermes,
Paperclip, KubeOpenCode, KubeAI, LiteLLM, or direct app instance reconcilers.

## Backend API

### Software channel operations

`GET /api/host-management` includes each managed host's sanitized `software`
status: desired branch/tag/commit, host revision, source/applied Flux revision,
critical running image IDs, last operation, preview and previous revision.
Local repository paths, metadata, process IDs and credentials are not exposed.

Administrators use the existing host-operation endpoint with
`action: check-software-channel` or `apply-software-channel`. Requests carry the
normal node UID, boot ID, unique request ID, node-name confirmation and current
software `planId`, plus `softwareChannel: {kind, value}`. Apply additionally
requires `softwarePreviewId` from an unexpired check of that exact selection.
Other roles, arbitrary repository URLs, shell expressions, shortened commits,
extra fields and stale plans/previews are rejected before any write. A moved
branch is rechecked on the host and cannot silently replace the approved commit.

The API writes a bounded `HostOperation`; the root-owned worker serializes it with
other maintenance and starts `magicstick-software-channel.service`. The browser
does not patch Flux or execute Ansible. The operation remains observable across
dashboard restarts; completed request IDs are not replayed. External-GitOps
installations report the feature unavailable. See
[software channels](../administration/updates-rollback.md) for recovery and limits.

### Other control-plane operations

Administrators configure **System → Settings → Mesh** through the opt-in
core `private-mesh` module. No license file is required.
The typed `/api/mesh` status reports runtime availability, and `/api/mesh/<action>`
commands enforce administrator authorization and browser CSRF checks. The
backend supplies creator identity and appliance TLS trust; the browser cannot
choose upstream service credentials. See [Private Mesh](../user-guide/private-mesh.md) for
device roles, invitations, sharing limits, relay reachability and release gates.
Mesh's **Local model sharing** lists ready local chat models from vLLM, Ollama
and FreeToken; the overview reports **Local models** rather than an individual
engine. Sharing uses the existing backend through LiteLLM, never a second copy.
**Join Mesh** remains visible in the Mesh view before and after setup.
Its dialog enables the module if needed, then accepts a device name and a
single-use invitation. Existing membership must be explicitly left before
joining another mesh; opening the dialog does not change anything. Invitation
tokens are cleared on close/success and are not persisted in browser storage.

The single browser frontend Deployment is presentation-only and does not receive
a Kubernetes ServiceAccount token. Its image contains the pre-built React bundle
and nginx; no HTML renderer or frontend-code ConfigMap remains. nginx proxies
`/api/*` to the dedicated `identity-system/ai-appliance-dashboard-api` Service. That API runs in
its own single-replica Deployment and uses
`ConfigMap/ai-appliance-dashboard-api`. Envoy Gateway requires a Keycloak login
for both the local and public dashboard hostnames and forwards the access token.
The terminal API route requires a Keycloak Bearer token and validates its JWT at
the edge. The API then validates every browser or terminal token against
Keycloak, trusts only the browser and CLI client IDs, and applies its own role
checks.

## RBAC

Only the API Deployment uses the ServiceAccount
`identity-system/ai-appliance-dashboard-api`; the frontend Pod disables
automatic ServiceAccount-token mounting. The API permissions are intentionally
narrow:

- read `appliances.appliance.magicstick.dev`
- read, create, patch, and update `moduleactivations.appliance.magicstick.dev`
- read, create, patch, update, and delete `appinstances.appliance.magicstick.dev`
- read, create, patch, update, and delete `modelactivations.appliance.magicstick.dev`
- read OpenClaw instances for generated credential discovery
- read Flux Kustomizations
- read Nodes, Pods, Services, Ingresses, HTTPRoutes, ConfigMaps, and Events
- read the Kubelet node-summary memory value through `nodes/proxy`, with
  read-only `metrics.k8s.io/nodes` access as a fallback
- read the DCGM exporter service proxy for live VRAM metrics
- patch only `flux-system/ai-appliance-settings`
- manage only Dashboard-created provider credential Secrets in namespace `ai`
- read only `Secret/magicstick-user-admin-client` in `identity-system` for the
  dedicated Keycloak client-credentials flow
- read only `Secret/magicstick-federation-admin-client` in `identity-system` for
  the separately scoped Keycloak federation flow
- read the non-secret `ConfigMap/magicstick-kubernetes-access-info` and the
  ServiceAccount-mounted Kubernetes CA to assemble token-free kubeconfigs

The API ServiceAccount does not have cluster-admin and does not have permission
to create workloads directly. It cannot list identity Secrets and cannot read
the Keycloak bootstrap administrator or first-run setup client Secret. A
`Recreate` deployment strategy keeps exactly one mutating API process active so
the last-administrator guard cannot race across rolling replicas.

## Public-Safe Values

Examples use only `example.local`, `example.com`, `CHANGEME`, and documented
variables or public model preset identifiers. Real domains, external repository
paths, credentials, kubeconfigs, and customer values belong in runtime settings,
runtime Secrets, or optional external overlays.
