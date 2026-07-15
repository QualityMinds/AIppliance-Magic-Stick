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

The Paperclip Operator requires Kubernetes 1.28 or newer. A Paperclip
`AppInstance` automatically requests these runtime modules:

- `paperclip-operator`
- `agent-sandbox`
- `litellm`
- `model-catalog`

The Agent Sandbox base is reusable and opt-in. It installs the upstream chart
from a Flux `GitRepository` pinned to tag `v0.5.1` and provides the
`sandboxes.agents.x-k8s.io` CRD.

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
  type: paperclip
  enabled: true
  targetNamespace: ai
  parameters:
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
  adapters:
    execution:
      mode: kubernetes
      kubernetes:
        backend: sandbox-cr
    registry:
      - adapterType: opencode_local
        runtimeImage: ghcr.io/paperclipai/agent-runtime-opencode:git-b18cbb0dd3d524d3d332f54143c84f00c694636c
```

The `sandbox-cr` backend supports multiple commands in one isolated run
environment. The plugin currently creates one `Sandbox` with `emptyDir` volumes
per run and deletes that CR after the run. Paperclip copies the selected
workspace back to its application PVC and uploads it into the next Sandbox, so
workspace files persist across runs even though the Sandbox Pod itself does not.
The simpler Kubernetes Job backend is not used.

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

OpenCode uses the immutable
`ghcr.io/paperclipai/agent-runtime-opencode:git-b18cbb0dd3d524d3d332f54143c84f00c694636c`
image. Additional CLI agents should use a small dedicated image that contains:

- the agent CLI and its fixed runtime dependencies
- `/usr/local/bin/paperclip-agent-shim`
- only the tools required by that agent
- a non-root user and a writable workspace path

Register the image in `spec.adapters.registry` with a probe command and an
explicit list of allowed environment keys. Do not install agent CLIs in the
Paperclip server image and do not use Paperclip sidecars for per-run agents.

Every OpenCode agent must install the `paperclipai/paperclip/paperclip` skill.
Sandbox runs receive a run-scoped callback URL and token in
`PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY`. API requests must use the exact
runtime URL and the header `Authorization: Bearer $PAPERCLIP_API_KEY`; do not
hard-code the public Paperclip hostname or omit the `Bearer` scheme. Agent
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
  parameters:
    paperclipAgentSecretRef:
      name: openclaw-default-paperclip-agent
      key: paperclip-claimed-api-key.json
```

The generated OpenClaw init container installs that Secret at the upstream
adapter's required path with mode `0600`. Never put the response or token in an
`AppInstance`, ConfigMap, Git manifest, shell history, or log. Restart the
OpenClaw instance after rotating the Secret so the init container copies the
new value.

Hermes receives its Paperclip agent key in each authenticated gateway run. The
automated `hermes-api` sidecar disables Tirith and starts with
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
| `opencode-providers.json` | OpenCode provider configuration for the internal LiteLLM API. |
| `paperclip-adapter-models.json` | OpenCode model-picker entries exposed by Paperclip. |
| `AI_APPLIANCE_DEFAULT_OPENCODE_MODEL` | Default value in `litellm/<model-id>` form. |
| `chat-models.json` | Available chat models shown by Appliance Control. |

The generated OpenCode provider uses
`http://litellm.ai.svc.cluster.local:4000/v1`. Every chat model is exported as
`litellm/<model-id>` with explicit context and output limits required by the
OpenCode provider schema. Missing limits default to 131072 context tokens and
8192 output tokens. `OPENAI_API_KEY` is injected into Paperclip from
`Secret/ai/litellm-masterkey-secret`; no key value is stored in an
`AppInstance`, ConfigMap, or public manifest.

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
- an explicitly configured gateway route where applicable

They do not permit the Kubernetes API, cloud metadata endpoints, or arbitrary
cluster services from sandbox Pods. The cluster network provider must enforce
Kubernetes `NetworkPolicy`; otherwise these declarations do not provide network
isolation.

The Paperclip callback selector uses the owning `AppInstance`, not the pinned
plugin's hard-coded `paperclip` namespace. OpenClaw and Hermes routes are added
only when the dashboard selection references a concrete existing instance.

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

Never place secret values in the module catalog, `AppInstance.spec.parameters`,
adapter `defaultEnv`, or dashboard source.

Set `spec.parameters.authSecretName` only to reference an externally managed
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
an enabled adapter with a runtime image. If a sandbox starts but inference
fails, inspect `ai-model-catalog`, the LiteLLM Service, and the tenant namespace
NetworkPolicies before changing credentials.

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
