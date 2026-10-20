# Paperclip agent execution

Paperclip is the control plane for companies, agents, tasks, and runs. Agent
commands do not execute in the Paperclip server container. CLI-based agents run
in isolated Kubernetes sandboxes, while long-running gateway agents remain
separate services.

```text
Paperclip Instance
  -> Paperclip Kubernetes execution plugin
  -> Sandbox agents.x-k8s.io/v1alpha1
  -> isolated agent runtime Pod and workspace
  -> LiteLLM service on port 4000

Paperclip Instance
  -> OpenClaw or Hermes gateway Service
  -> LiteLLM service on port 4000
```

This layout keeps agent tools and dependencies out of the Paperclip image and
allows each runtime image to have its own release and security policy.

## Versions And Prerequisites

| Component | Pinned version |
|---|---|
| Paperclip application | `2026.1001.0`, multi-platform digest `sha256:08dbadebd4d40550eb336c25c3691f582322a88bae3f1cca101c5dd096bdc9d3` |
| Paperclip Operator chart/image | `0.19.1` / upstream `v0.19.1` |
| Kubernetes Agent Sandbox | `v0.5.1` |
| Paperclip Kubernetes plugin | `2026.1001.0`, with its matching plugin SDK |
| OpenCode sandbox runtime | OpenCode `1.18.21`; official Paperclip build `38d8f371722b315d2fb3bbaa512518742e33ce2f`, pinned by digest |

The Paperclip Operator requires Kubernetes 1.28 or newer. A Paperclip
`AppInstance` automatically requests these runtime modules:

- `paperclip-operator`
- `agent-sandbox`
- `litellm`
- `model-catalog`

The Agent Sandbox base is reusable and opt-in. It installs the upstream chart
from a Flux `GitRepository` pinned to tag `v0.5.1` and provides the
`sandboxes.agents.x-k8s.io` CRD.

The Paperclip application image contains the Kubernetes provider source but not
its compiled plugin artifact. On every Pod start, the authenticated loopback
gateway checks Paperclip's plugin registry. It installs the exact pinned npm
package through Paperclip's local API when the provider is missing, has a different
version or is incompatible/errored. It waits for the pinned version and state
`ready`, and only then exposes the application Service. The
installed package and plugin record persist with Paperclip, so ordinary offline
restarts do not contact npm again.

The upstream operator remains unmodified. Native `PAPERCLIP_BIND=loopback` and
`HOST=127.0.0.1` instance overrides are appended after its defaults; the existing
Pod-IP TCP proxy makes that private listener reachable through the SSO route.
Flux replaces the operator's CRDs during install and upgrade. Managed databases
remain on PostgreSQL 17; this change does not introduce a database major upgrade.

Pinned Paperclip built-in agents currently select the first adapter in their
own allowed list, even when that adapter is disabled. The same loopback helper
therefore reconciles only incomplete built-in agents that have a Paperclip
built-in marker, a disabled adapter, and no configured model. It assigns the
enabled `opencode_local` adapter and the appliance default model. The check runs
at startup and every 30 seconds so built-ins enabled later also work. Custom
agents and every agent with an explicit model remain untouched.

## AppInstance Contract

The dashboard writes the following runtime shape. The hostname is normally
derived by the dashboard from appliance settings.

```yaml
apiVersion: appliance.magicstick.dev/v1alpha1
kind: AppInstance
metadata:
  name: paperclip-default
  namespace: ai-system
spec:
  application: paperclip
  enabled: true
  targetNamespace: ai
  values:
    name: default
    model: qwen3635b
    storage:
      size: 5Gi
    database:
      managed:
        storageSize: 10Gi
    admin:
      email: admin@example.com
      name: Admin
    agentExecution:
      defaultModel: litellm/qwen3635b
      maxConcurrentAgents: 2
      openCode:
        enabled: true
      openClaw:
        enabled: false
        instanceRef: ""
      hermes:
        enabled: false
        instanceRef: ""
```

`maxConcurrentAgents` accepts values from 1 through 10 and defaults to 2. The
operator converts it into a per-tenant `ResourceQuota`. Each sandbox defaults to
a 500m CPU and 1 GiB memory request, with a maximum of 2 CPUs and 4 GiB memory.
The pinned plugin still contains larger built-in quota defaults, so the Magic
Stick Operator owns and continuously reapplies the selected quota and
`LimitRange` after every managed tenant namespace is created.

The resulting `paperclip.inc/v1alpha1` resource uses:

```yaml
spec:
  env:
    - name: PAPERCLIP_K8S_ADAPTER_TYPE
      value: opencode_local
  adapters:
    execution:
      mode: kubernetes
      kubernetes:
        backend: sandbox-cr
    registry:
      - adapterType: opencode_local
        runtimeImage: ghcr.io/paperclipai/agent-runtime-opencode@sha256:06b207047eb2efcede3f5c85d493fbe976ad653a7fafe41cf6df76dd02e12ae6
```

The `sandbox-cr` backend supports multiple commands in one isolated run
environment. The plugin currently creates one `Sandbox` with `emptyDir` volumes
per run and deletes that CR after the run. A server restart or forced
cancellation can interrupt the upstream release hook, so the loopback helper
also removes only Sandboxes whose exact run id is terminal in the owning
company for at least 60 seconds. Active, missing, and unknown runs are left
untouched. Paperclip copies the selected workspace back to its application PVC
and uploads it into the next Sandbox, so workspace files persist across runs
even though the Sandbox Pod itself does not. The simpler Kubernetes Job backend
is not used.

The generated Instance sets the native `PAPERCLIP_API_URL` to its internal
Service URL. Paperclip 2026.1001.0 preserves this explicit value when generating
agent environments; its sandbox callback bridge separately uses the local
listener, avoiding the browser SSO route. A server-bundle patch is unnecessary.

Paperclip `2026.1001.0` can request `/tmp` as the remote sandbox working
directory. The matching Kubernetes plugin also forwards `params.cwd` but does
not apply it to the Kubernetes exec process. The generated Paperclip `Instance`
therefore installs the pinned plugin with a guarded compatibility patch that
normalizes the `/tmp` fallback to `/workspace` and changes into the requested
working directory before each exec. Paperclip runtime state is kept separately
under `/tmp/.paperclip-runtime`; only `/workspace` is synchronized back to the
agent workspace. A ConfigMap-backed Node preloader checks the exact plugin
package version and SHA-256 of its compiled manifest and execution module before
applying these patches. It runs in the server and only the Kubernetes plugin's
isolated worker, preserving the worker's restricted environment. The npm release
reports an unchanged alpha manifest version; the preloader reports its verified
package version so a persisted older installation cannot bypass the upgrade.
Changed compatibility files fail startup/activation and require review. Updating
the preloader changes an instance environment revision and rolls the Pod.

## Runtime Types

### OpenCode And CLI Agents

OpenCode uses the immutable official Paperclip runtime
`ghcr.io/paperclipai/agent-runtime-opencode@sha256:06b207047eb2efcede3f5c85d493fbe976ad653a7fafe41cf6df76dd02e12ae6`.
It is built from Paperclip commit `38d8f371722b315d2fb3bbaa512518742e33ce2f`,
which puts `ripgrep` on `PATH` for OpenCode's skill-discovery tool. Magic Stick
does not build or maintain a derived agent image. This upstream build is
currently published for `linux/amd64`; Paperclip instances are unsupported on
ARM64 until upstream publishes a matching runtime. Additional CLI agents should
use an upstream runtime that contains:

- the agent CLI and its fixed runtime dependencies
- `/usr/local/bin/paperclip-agent-shim`
- only the tools required by that agent
- a non-root user and a writable workspace path

Register the image in `spec.adapters.registry` with a probe command and an
explicit list of allowed environment keys. Do not install agent CLIs in the
Paperclip server image and do not use Paperclip sidecars for per-run agents.

The instance reconciler attaches the `paperclipai/paperclip/paperclip` base
skill to every OpenCode agent and preserves any specialized skills already
selected for that agent. Sandbox runs receive a run-scoped callback URL and
token in `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY`. API requests must use the
exact runtime URL and the header `Authorization: Bearer $PAPERCLIP_API_KEY`; do
not hard-code the public Paperclip hostname or omit the `Bearer` scheme. Agent
instructions should repeat this contract because model-generated shell commands
can otherwise degrade a valid token into an invalid header.

Agents must work only in `PAPERCLIP_WORKSPACE_CWD`. They must never inspect,
move, or delete `.paperclip-runtime`, which contains the active callback bridge
and other runtime state, and must never print `PAPERCLIP_API_KEY`.

### OpenClaw And Hermes

OpenClaw and Hermes remain independent `AppInstance` resources. The Paperclip
form stores the chosen instance references; the current chart registers the
OpenCode Kubernetes adapter only. It does not automatically configure gateway
adapters, copy gateway credentials, create callback credentials, add a separate
Hermes API sidecar or widen gateway NetworkPolicies.

Configure a gateway agent manually in Paperclip using the upstream adapter and
its reachable service endpoint. Store gateway credentials as encrypted Company
Secrets (`apiKey` for Hermes or `authToken` for OpenClaw). Separately arrange a
Paperclip agent API key and permitted callback path for that runtime. The current
Hermes agent gateway listens on port 8443; OpenClaw uses Service port 18789.
These manual bindings require their own acceptance test. Selecting an instance
in the dashboard does not establish them.

For OpenClaw, the upstream invite/claim procedure provisions the callback key;
merely creating an `openclaw_gateway` agent does not perform that claim. Preserve
its claimed-key file on the OpenClaw persistent workspace. Never put credentials
in `AppInstance` values, ConfigMaps, Git manifests or logs.

## Model Catalog

`ConfigMap/ai-model-catalog` publishes:

| Key | Paperclip use |
|---|---|
| `paperclip-opencode-providers.json` | OpenCode provider configuration for the internal LiteLLM API, with Paperclip-safe context headroom. |
| `paperclip-adapter-models.json` | OpenCode model-picker entries exposed by Paperclip. |
| `AI_APPLIANCE_DEFAULT_OPENCODE_MODEL` | Default value in `litellm/<model-id>` form. |
| `chat-models.json` | Available chat models shown by Appliance Control. |

The generated OpenCode provider uses
`http://litellm.ai.svc.cluster.local:4000/v1`. Every chat model is exported as
`litellm/<model-id>` with explicit context and output limits required by the
OpenCode provider schema. Missing limits default to 8192 context tokens and
2048 output tokens before the Paperclip-specific limits are applied. The
runtime requests at most 4096 output tokens and no more than one quarter of its
advertised context. It also advertises up to 4096 fewer context tokens than the
model physically accepts, so compaction happens before the LiteLLM/vLLM hard
boundary. `OPENAI_API_KEY` is injected into Paperclip from
`Secret/ai/litellm-masterkey-secret`; no key value is stored in an
`AppInstance`, ConfigMap, or public manifest.

Paperclip `2026.1001.0` imposes a hard 15-minute ceiling on every plugin RPC.
Magic Stick retains that ceiling so an agent cannot hide a broken search loop
behind a longer transport timeout. A fail-closed, exact-source adapter patch
corrects the remote-agent instruction note so the model does not try to
read a control-plane-only `AGENTS.md` path from inside its sandbox. Pod startup
aborts if the pinned upstream source no longer matches. The same guarded patch
normalizes the Kubernetes execution target to `/workspace`: this Paperclip
version otherwise discards the path returned by `realizeWorkspace`, syncs the
workspace through its generic `/tmp` fallback, but executes the official image
in `/workspace`. Without normalization, generated files are not synchronized
back to the task workspace.

Assigning the upstream `paperclip` skill only makes it available to OpenCode; it
does not guarantee that a model loads it. Magic Stick therefore prepends a
small bootstrap directive to OpenCode agents, while leaving the upstream skill
unchanged. New sessions explicitly load that skill before work, use the
run-scoped callback address from `PAPERCLIP_API_URL` instead of inventing a
localhost port, use the Paperclip API for task documents, and leave a final task
disposition.

Changing the catalog default updates the generated ConfigMap and triggers the
existing model-catalog consumer restart path. Existing Paperclip agent settings
remain explicit until changed in Paperclip.

## Network Isolation

The Paperclip Kubernetes plugin creates one namespace per tenant and applies
its standard default-deny policies. The Magic Stick Operator adds a narrowly
scoped policy, `ResourceQuota`, and `LimitRange` as soon as it observes a new
managed namespace. Together the policies permit:

- cluster DNS
- the Paperclip callback Service
- LiteLLM on TCP port 4000

They do not permit the Kubernetes API, cloud metadata endpoints, or arbitrary
cluster services from sandbox Pods. The cluster network provider must enforce
Kubernetes `NetworkPolicy`; otherwise these declarations do not provide network
isolation.

The Paperclip control-plane Pod, unlike its sandbox Pods, needs the Kubernetes
API to create those tenant resources and LiteLLM to validate OpenCode during
onboarding and later adapter health checks. The instance chart adds TCP `6443`
to the operator's existing TCP `443` egress rule because K3s exposes the API
endpoint on `6443` and some CNIs evaluate NetworkPolicy after Service DNAT. A
second narrow rule permits TCP `4000` only to Pods labeled `app=litellm` in the
instance namespace; it does not allow arbitrary service egress. On
Rancher-managed clusters, the provider's restricted Pod Security Admission
labels are additionally validated through Rancher's `updatepsa` verb. A
dedicated ClusterRole grants the Paperclip ServiceAccount only that custom verb;
the rule has no effect when the Rancher API group is absent.

The Paperclip callback selector uses the owning `AppInstance`, not the pinned
plugin's hard-coded `paperclip` namespace. Tenant ownership is accepted only
when the managed namespace name exactly matches `<AppInstance>-<company-id>`;
an unrelated or disabled instance cannot widen sandbox egress.

## Credentials

Credential ownership is split by purpose:

| Credential | Storage |
|---|---|
| Paperclip auth secret | Generated `<appinstance>-auth` Kubernetes Secret with key `BETTER_AUTH_SECRET`; an existing Instance keeps its current reference during upgrades. |
| LiteLLM API key | Kubernetes Secret reference injected into the approved runtime environment. |
| OpenClaw gateway token | Paperclip Company Secret or a dedicated Kubernetes Secret reference. |
| Hermes API key | Explicitly configured gateway credential, then stored as a Paperclip Company Secret for a manual binding. |
| Git provider token or SSH key | Paperclip Company Secret or a dedicated per-agent Kubernetes Secret reference. |
| Paperclip first-admin password | Generated Kubernetes Secret exposed through the existing credentials endpoint. |

Never place secret values in the module catalog, `AppInstance.spec.values`,
adapter `defaultEnv`, or dashboard source.

Set `spec.values.authSecretName` only to reference an externally managed
Secret that already contains `BETTER_AUTH_SECRET`; the Magic Stick Operator does
not generate or delete an explicitly named auth Secret.

## Operations

Inspect the control plane and sandbox controller:

```bash
kubectl -n ai get instances.paperclip.inc
kubectl -n paperclip-operator-system get pods
kubectl -n agent-sandbox-system get pods
kubectl get sandboxes.agents.x-k8s.io -A
```

Inspect tenant namespaces and their isolation:

```bash
kubectl get namespaces -l paperclip.io/managed-by=paperclip-k8s-plugin
kubectl get networkpolicies -A -l paperclip.io/managed-by=paperclip-k8s-plugin
kubectl get resourcequotas,limitranges -A
```

If no Sandbox appears for a task, verify that both required CRDs exist, the
Paperclip `Instance` contains `backend: sandbox-cr`, and the selected agent uses
an enabled adapter with a runtime image. Also confirm that
`paperclip.kubernetes-sandbox-provider` is `ready`, the managed environment uses
`adapterType: opencode_local`, and the Paperclip control-plane Pod can reach the
Kubernetes API. On Rancher, an `Unauthorized` response from
`rancher.cattle.io.namespaces.create-non-kubesystem` means the instance-specific
`updatepsa` ClusterRole or binding is missing. If a sandbox starts but inference
fails, inspect `ai-model-catalog`, the LiteLLM Service, and the tenant namespace
NetworkPolicies before changing credentials.

If the onboarding environment check discovers models but ends with
`OpenCode hello probe timed out`, test TCP `4000` from the Paperclip server Pod
to `litellm.ai.svc.cluster.local`. Immediate connection failures followed by a
roughly one-minute warning indicate that the control-plane NetworkPolicy is
missing its LiteLLM rule; increasing the probe timeout does not fix that case.

If a task stops after `Sandbox run log streaming enabled for this run`, inspect
the generated tenant namespace. It must contain
`NetworkPolicy/magicstick-paperclip-runtime-egress`; its two rules permit only
the owning Paperclip server on TCP `3100` and LiteLLM Pods on TCP `4000`. Zero
OpenCode output together with an immediate connection refusal to either Service
means this policy has not yet been reconciled. Check the `magicstick-operator`
logs and RBAC instead of increasing the task timeout.

If a new run remains pending because `paperclip-quota` is already exhausted,
list the tenant Sandboxes and compare their `paperclip.io/run-id` labels with
the owning company's heartbeat runs. The instance helper deletes only known
terminal runs after a 60-second safety grace. Check its
`gateway-loopback-proxy` log when terminal Sandboxes remain longer; do not raise
the quota to hide leaked runtime Pods.

When an agent is repurposed after a failed or diagnostic task, reset its runtime
session before assigning unrelated work. The persistent workspace is preserved,
but the stale OpenCode conversation is cleared:

```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  -H "Origin: $PAPERCLIP_ORIGIN" \
  -b paperclip-cookies.txt \
  -d '{}' \
  "$PAPERCLIP_ORIGIN/api/agents/$AGENT_ID/runtime-state/reset-session"
```
