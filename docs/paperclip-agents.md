# Paperclip Agent Execution

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
| Paperclip application | `v2026.707.0` (`sha-df0e5bd` container build) |
| Paperclip Operator chart | `0.18.0` |
| Kubernetes Agent Sandbox | `v0.5.1` |
| Paperclip Kubernetes plugin | `2026.707.0` |
| OpenCode sandbox runtime | Official Paperclip image pinned by digest (`4f539625f7b63541d1beae1341220702638b7677`) |

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
package through Paperclip's local API only when the provider is missing, waits
for plugin state `ready`, and only then exposes the application Service. The
installed package and plugin record persist with Paperclip, so ordinary offline
restarts do not contact npm again.

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
        runtimeImage: ghcr.io/paperclipai/agent-runtime-opencode@sha256:1511797b21856fb3ce4b6b1ce5b0209a0a1c55ef227a21d4024bf4681a0fa49d
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

Paperclip's authenticated public mode derives its browser-facing auth URL from
`spec.deployment.publicURL`. That hostname is not necessarily resolvable from
inside the cluster. Paperclip `v2026.707.0` also overwrites a preconfigured
`PAPERCLIP_RUNTIME_API_URL` with that public URL during startup, which breaks the
sandbox callback bridge. The generated Instance therefore sets the internal
Service URL and installs a guarded server compatibility patch that preserves
the configured value. A small ConfigMap-backed Node preloader applies the patch
inside each container before the server bundle is imported. The preloader fails
when the pinned upstream bundle no longer matches, so a future Paperclip upgrade
cannot silently restore the external callback route.

Paperclip `v2026.707.0` can request `/tmp` as the remote sandbox working
directory. The matching Kubernetes plugin also forwards `params.cwd` but does
not apply it to the Kubernetes exec process. The generated Paperclip `Instance`
therefore installs the pinned plugin with a guarded compatibility patch that
normalizes the `/tmp` fallback to `/workspace` and changes into the requested
working directory before each exec. Paperclip runtime state is kept separately
under `/tmp/.paperclip-runtime`; only `/workspace` is synchronized back to the
agent workspace. The init container fails if the pinned upstream bundle no
longer matches.

## Runtime Types

### OpenCode And CLI Agents

OpenCode uses the immutable official Paperclip runtime
`ghcr.io/paperclipai/agent-runtime-opencode@sha256:1511797b21856fb3ce4b6b1ce5b0209a0a1c55ef227a21d4024bf4681a0fa49d`.
It is built from Paperclip commit `4f539625f7b63541d1beae1341220702638b7677`,
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

OpenClaw and Hermes remain independent `AppInstance` resources. Selecting one
in Appliance Control enables its Paperclip adapter and allows only the selected
gateway port from the Paperclip Pod. Hermes exposes its authenticated API from
the generated `hermes-api` sidecar on port 8642. All Hermes containers use UID
and GID `1000` so the dashboard, catalog init, and API gateway can share the
same persistent home directory. OpenClaw uses its gateway on
Service port 18789; policies also admit its operator-managed Pod target port
18790 so the route works regardless of where the CNI enforces egress relative
to Service DNAT. Both gateway NetworkPolicies permit outbound Paperclip
callbacks only to Pods labeled `app.kubernetes.io/name=paperclip` on TCP 3100.

Paperclip companies and employee agents are intentionally not created by the
Appliance dashboard. After the first-admin onboarding, create the company and
agent in Paperclip, then store the selected gateway URL and token as Paperclip
Company Secrets. The dashboard selection does not copy gateway credentials into
the Paperclip Pod. Use `apiKey` for Hermes and `authToken` for OpenClaw; both
fields are normalized to encrypted Company Secret references before Paperclip
persists the agent configuration.

An OpenClaw gateway also needs its own Paperclip agent API key for callbacks.
The recommended onboarding path is Paperclip's OpenClaw invite prompt: OpenClaw
submits the join request, the board approves it, and OpenClaw claims and saves
the one-time key at
`~/.openclaw/workspace/paperclip-claimed-api-key.json`. Merely creating an
`openclaw_gateway` agent in the Paperclip form does not perform this claim.

For an agent that was created manually, create a standard key once with
`POST /api/agents/{agentId}/keys`, store the complete one-time JSON response in
a Kubernetes Secret, and reference it from the OpenClaw `AppInstance`:

```yaml
spec:
  values:
    paperclipAgentSecretRef:
      name: openclaw-default-paperclip-agent
      key: paperclip-claimed-api-key.json
```

The generated OpenClaw init container installs that Secret at the upstream
adapter's required path with mode `0600`. Never put the response or token in an
`AppInstance`, ConfigMap, Git manifest, shell history, or log. Restart the
OpenClaw instance after rotating the Secret so the init container copies the
new value.

Paperclip authenticates to the Hermes gateway with `API_SERVER_KEY`, but this
gateway credential is not the Paperclip agent credential. For callbacks, store
the `token` from `POST /api/agents/{agentId}/keys` in a Kubernetes Secret and
bind it to the Hermes `AppInstance` together with the reachable Paperclip URL:

```yaml
spec:
  values:
    paperclipApiUrl: http://paperclip-default.ai.svc.cluster.local:3100
    paperclipAgentSecretRef:
      name: hermes-default-paperclip-agent
      key: PAPERCLIP_API_KEY
```

Only the automated `hermes-api` sidecar receives `PAPERCLIP_API_KEY` and
`PAPERCLIP_API_URL`; the interactive dashboard does not. The API sidecar also
disables Tirith and starts with
`HERMES_YOLO_MODE=1` because there is no interactive terminal attached to
answer command approval prompts; otherwise an internal Paperclip callback can
remain pending until the run times out. This exception applies only to that API
sidecar. Its Kubernetes NetworkPolicy still limits reachable services, while
the interactive Hermes dashboard and CLI keep their normal approval and
Tirith protection.

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
OpenCode provider schema. Missing limits default to 131072 context tokens and
8192 output tokens before the Paperclip-specific limits are applied. The
runtime requests at most 4096 output tokens and no more than one quarter of its
advertised context. It also advertises up to 4096 fewer context tokens than the
model physically accepts, so compaction happens before the LiteLLM/vLLM hard
boundary. `OPENAI_API_KEY` is injected into Paperclip from
`Secret/ai/litellm-masterkey-secret`; no key value is stored in an
`AppInstance`, ConfigMap, or public manifest.

Paperclip `v2026.707.0` imposes a hard 15-minute ceiling on every plugin RPC.
Magic Stick retains that ceiling so an agent cannot hide a broken search loop
behind a longer transport timeout. A fail-closed, exact-source adapter patch
changes only the remote-agent instruction note so the model does not try to
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
| Hermes API key | Generated Kubernetes Secret, then bound as a Paperclip Company Secret or Secret reference. |
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
