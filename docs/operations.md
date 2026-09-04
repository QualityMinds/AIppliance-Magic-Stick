# Operations

This page collects common day-2 checks for a running appliance.

## Host Checks

On the appliance host:

```bash
sudo systemctl status k3s
sudo journalctl -u k3s -n 200 --no-pager
sudo /usr/local/sbin/ai-appliance-converge
```

Check the host metadata that drives the converge runner:

```bash
sudo sed -n '1,160p' /etc/default/ai-appliance-repo
```

Do not paste secret values from that file into issues or public logs.

## Kubernetes Checks

With host-local K3s:

```bash
sudo k3s kubectl get nodes -o wide
sudo k3s kubectl get namespaces
sudo k3s kubectl -A get pods
```

With any configured kubeconfig:

```bash
kubectl get nodes -o wide
kubectl -A get pods
```

## Flux Checks

```bash
kubectl -n flux-system get gitrepositories
kubectl -n flux-system get kustomizations
kubectl -n flux-system get helmreleases
```

Inspect a failing reconciliation:

```bash
kubectl -n flux-system describe kustomization flux-system
kubectl -n flux-system describe kustomization magicstick-operator
kubectl -n ai-system get moduleactivations,appinstances
```

Trigger reconciliation after pushing a fix:

```bash
flux -n flux-system reconcile source git flux-system
flux -n flux-system reconcile kustomization flux-system --with-source
flux -n flux-system reconcile kustomization magicstick-operator --with-source
```

If the Flux CLI is not available locally, annotate the resource:

```bash
kubectl -n flux-system annotate gitrepository flux-system \
  reconcile.fluxcd.io/requestedAt="$(date +%s)" --overwrite
kubectl -n flux-system annotate kustomization magicstick-operator \
  reconcile.fluxcd.io/requestedAt="$(date +%s)" --overwrite
```

## App Checks

```bash
kubectl -n ai get pods
kubectl -n ai get svc,ingress
kubectl -n dashboard get pods,service,referencegrant
kubectl -n identity-system get httproute,securitypolicy
kubectl -n identity-system get httproutes,securitypolicies
```

The dashboard's **Services** tab combines the former Modules and Instances
views. Application instances appear below their parent application, shared AI
runtime modules have their own compact section, and technical platform modules
are collapsed by default. Each application's nested instances also start
collapsed and can be expanded independently without changing runtime state.
These are presentation groups only: module actions still reconcile
`ModuleActivation` resources and instance actions still reconcile `AppInstance`
resources. When an entry appears in the wrong group, inspect the module catalog
and application `requiredModules` before changing a runtime resource.
Hardware-backed entries use the appliance hardware-provider state, not merely
the Flux apply result. NVIDIA therefore remains `Installing` until both an
allocatable `nvidia.com/gpu` resource and readable DCGM telemetry are available.

## Identity Pilot Checks

```bash
kubectl -n flux-system get kustomizations envoy-gateway identity-pilot
kubectl -n envoy-gateway-system get helmrelease,pods
kubectl -n identity-system get pods,pvc,gateway,httproute,securitypolicy
kubectl -n identity-system logs deploy/keycloak
```

Envoy Gateway is the installed application gateway and exposes the HTTPS
listener through a `LoadBalancer` service. Follow
[authentication.md](authentication.md) for local name resolution, login
validation, and generated credential handling.

During a new installation, inspect first-run state without reading Secret
values:

```bash
sudo magicstick setup show
kubectl -n identity-system get appliancesetup local
kubectl -n identity-system get gateway,httproute,securitypolicy \
  -l app.kubernetes.io/managed-by=magicstick-setup
```

Temporary setup resources exist only in `Pending`, `Claimed`, `Applying`, or
`Failed`. They must be absent after `Completed` or `CompletedLegacy`. Use
`sudo magicstick setup reissue` before completion when a browser claim was
abandoned. See [first-run-setup.md](first-run-setup.md).

On appliance hosts, the physical first-run page is managed by
`magicstick-setup-console.service`. It starts only after `cloud-final.service`,
switches the display to dedicated virtual console 9, shows one primary private
LAN address in a centered, color-coded appliance panel, and refreshes
periodically. Boot and login output remains on virtual console 1. When the
service stops it returns the physical display to console 1. Inspect the service
without printing the claim into a remote log:

```bash
sudo systemctl status magicstick-setup-console.service --no-pager
```

Use `sudo magicstick setup show` only in a trusted local or SSH session because
it prints the active claim before setup completion.

Common public hostnames use `AI_APPLIANCE_DOMAIN`:

| Service | Default public host pattern |
|---|---|
| Dashboard | `magicstick.example.com` |
| AnythingLLM | `anythingllm.magicstick.example.com` |
| LiteLLM | `litellm.magicstick.example.com` |
| KubeOpenCode | `kubeopencode.magicstick.example.com` |

AppInstance hostnames include the instance name:

| Instance type | Example public host | Example local host |
|---|---|---|
| OpenClaw | `default.openclaw.magicstick.example.com` | `default.openclaw.magicstick.local` |
| Hermes | `default.hermes.magicstick.example.com` | `default.hermes.magicstick.local` |
| Odysseus | `default.odysseus.magicstick.example.com` | `default.odysseus.magicstick.local` |
| Paperclip | `default.paperclip.magicstick.example.com` | `default.paperclip.magicstick.local` |
| KubeOpenCode | `default.kubeopencode.magicstick.example.com` | `default.kubeopencode.magicstick.local` |

Local mDNS hostnames use `AI_APPLIANCE_MDNS_DOMAIN`, for example
`magicstick.local` for the dashboard and `anythingllm.magicstick.local` for
AnythingLLM. Instance-local hostnames use the same instance-name pattern with
the mDNS domain. The terminal control-plane client uses
`api.<mDNS-domain>`, for example `api.magicstick.local`.

While the React migration is in preview, `dashboard2.<mDNS-domain>` is published
as an additional mDNS hostname. With the defaults, open
`https://dashboard2.magicstick.local/`. It has a separate Deployment, Service,
OIDC policy, and browser cookie but shares the current dashboard backend API.
The current dashboard at `https://magicstick.local/` remains available. Check
both frontends without reading credentials:

```bash
kubectl -n dashboard get deploy,service \
  ai-appliance-dashboard ai-appliance-dashboard-next
kubectl -n identity-system get httproute dashboard-local dashboard-next-local
kubectl -n identity-system get securitypolicy \
  dashboard-local-oidc dashboard-next-local-oidc
```

For a release acceptance pass, compare the current and React dashboards with
the same authenticated role and live appliance state:

1. **Overview:** compare counts and verify that every module and instance route
   can be opened and copied from its grouped resource row.
2. **Services:** exercise all three filters, expand an application and one
   instance, inspect progress/routes, open supported credentials, and verify
   that every application type exposes its complete create form.
3. **Models:** compare compute gauges, search Hugging Face and Ollama, select an
   artifact, verify context/download metadata and capacity markers, then inspect
   an existing activation and the guarded remove controls.
4. **Settings:** compare the loaded public and mDNS domains. Save only when a
   controlled domain mutation is part of the test.
5. **Users:** as an administrator, search and filter users, inspect effective
   versus direct access, and open every lifecycle dialog without changing a
   recovery or current account.
6. **API Access:** verify API bases and open the create dialog. A release test
   that creates a key must copy it from the one-time view and revoke it again.
7. **Kubernetes Access:** verify OIDC readiness, access explanations, user
   search, and that copy/download remain disabled until a user has a grant and
   the cluster reports ready.
8. **System Status:** compare operator, Flux, workload, and route summaries and
   verify that an applied GPU operator is not called ready before its resource
   and telemetry are active.

Run the automated counterpart before the browser pass:

```bash
cd dashboard
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

### CLI and terminal UI

The same workspace produces a standalone Node.js CLI/TUI bundle. Build it and
inspect its offline help without an appliance connection:

```bash
cd dashboard
pnpm build
pnpm cli --version
pnpm cli --help
```

On a machine that can resolve and reach the appliance, authenticate through the
Keycloak Device Authorization Flow and then start the terminal UI:

```bash
pnpm cli login
pnpm cli whoami
pnpm cli overview
pnpm tui
```

The login command opens Keycloak when possible and always prints a verification
URL and one-time code. It does not ask for the Keycloak password in the shell.
Configuration and the renewable session are stored below
`$XDG_CONFIG_HOME/magicstick`, or `~/.config/magicstick` when that variable is
unset; the session file is mode `0600`.
Run `pnpm cli logout` to remove it. If Node does not trust the appliance-local
CA, export that CA and run with
`NODE_EXTRA_CA_CERTS=/path/to/magicstick-ca.pem`; never use a TLS-disable flag.

The primary command groups are `service`, `instance`, `model`, `settings`,
`user`, `api-key`, and `kubernetes-access`. Destructive and configuration
operations retain the API's viewer/operator/admin checks. Model and instance
creation accept a JSON payload with `--file`, allowing the same complete API
contract as the React forms without a second set of client-side reconciliation
rules. User passwords are accepted only through `--password-file` or
`--password-stdin`.

Check the cluster-side terminal access path with:

```bash
kubectl -n identity-system get httproute dashboard-api-local
kubectl -n identity-system get securitypolicy dashboard-api-local-jwt
kubectl -n identity-system get certificate identity-pilot
kubectl -n identity-system get pods -l app=keycloak
```

The route must report `Accepted=True`, `api.<mDNS-domain>` must resolve to the
Gateway address, and Keycloak discovery must advertise a
`device_authorization_endpoint`. A release live pass should verify one viewer
read, one authorized operator mutation with cleanup, one denied mutation, an
admin-only list, token refresh, logout, and TUI quit/refresh behavior. These are
live acceptance checks and cannot be replaced by local unit tests while the
appliance is offline.

Gateway-backed names are published only when their `HTTPRoute` has
`lab42.io/mdns.enabled: "true"`, the selected parent reports `Accepted=True`,
and the referenced `Gateway` has an IP address. Check discovery with:

```bash
kubectl get gateway,httproute -A
kubectl -n kdns logs deploy/kdns-kdns
```

LiteLLM, AnythingLLM, and the KubeOpenCode server use static routes in
`identity-system` and narrowly scoped backend grants in their service
namespace. Inspect the complete contract with:

```bash
kubectl -n identity-system get httproutes,securitypolicies \
  -o custom-columns=KIND:.kind,NAME:.metadata.name
kubectl -n ai get referencegrants
```

All three static AI surfaces require `magicstick-user` or a higher role. Every
static policy uses an exact callback path on the shared dashboard host, so it
remains inside the redirect URI patterns of the single human gateway client.
LiteLLM is the exception to upstream OIDC token forwarding: Envoy authenticates
and authorizes the request at the edge but preserves LiteLLM's own
`Authorization: Bearer sk-...` header for UI and API calls. Its local and
public HTTPRoutes set `rules[].timeouts.request: "0s"`. AnythingLLM,
KubeOpenCode, and every catalogued AppInstance apply the same setting to their
application routes because streamed AI responses can legitimately exceed
Envoy's 15-second default request timeout. Exact OIDC callback routes retain
the bounded default. Envoy's stream-idle handling and the model backend's
generation limits still apply.

Rancher Desktop isolates Kubernetes multicast traffic inside its Linux VM. On
macOS, keep the host bridge running in a separate terminal while testing:

```bash
magic-cluster/platform/basis/kdns/publish-rancher-desktop-mdns.sh
```

Host-local K3s appliances do not need this development bridge.

## User Administration Checks

The dashboard **Users** tab is available only to `magicstick-admin` while local
Keycloak identity management is enabled. Opening the tab performs a live
Keycloak request; it is intentionally not included in the normal 30-second
dashboard refresh.

Check the dashboard API, dedicated Secret, and narrowly scoped Secret RBAC
without decoding any credentials:

```bash
kubectl -n dashboard get deploy ai-appliance-dashboard
kubectl -n identity-system get deploy,service ai-appliance-dashboard-api
kubectl -n identity-system get role,rolebinding ai-appliance-dashboard-user-admin-client
kubectl -n identity-system get secret magicstick-user-admin-client
kubectl -n identity-system logs deploy/ai-appliance-dashboard-api -c api --tail=200
```

The Role must grant `get` only for
`Secret/magicstick-user-admin-client`. It must not grant `list` or `watch`, and
the API ServiceAccount must not be able to read the bootstrap or setup client
Secrets. The frontend Deployment must keep
`automountServiceAccountToken: false`.

User mutations emit structured `magicstick.user-admin` audit lines containing
the request ID, actor, target, action, result, and status. They deliberately omit
passwords, request bodies, client secrets, and tokens. A `403` on the user API
can mean that the browser token lacks `magicstick-admin` or that a live
Keycloak check found the actor disabled or demoted. A `409` normally indicates
a duplicate identity, an unsupported action on an external or protected user,
or the last-local-administrator guard. A `503` indicates that Keycloak or the
dedicated client configuration is unavailable.

After disabling a user, changing direct access, or resetting a local password,
verify that a new Keycloak login reflects the change. Keycloak logout ends the
server-side session, but an already issued JWT may remain valid at Envoy until
its expiry. The user-administration API itself performs a live actor check and
therefore immediately denies a disabled or demoted administrator. Never
troubleshoot by printing or decoding the client Secret. If a deployment uses
the direct external-provider escape-hatch overlay instead of local Keycloak,
identity management is unavailable and the **Users** tab stays hidden.

## API Access Checks

The dashboard **API Access** tab is available only to `magicstick-admin`. It
uses LiteLLM's virtual-key API and the existing generated master key to create
multiple named client keys. The raw client key is shown once after creation;
only its name and hashed identifier remain visible later.

Check the participating services without decoding either the master key or any
client key:

```bash
kubectl -n identity-system get deploy,service ai-appliance-dashboard-api
kubectl -n ai get deploy,service litellm
kubectl -n ai get pods -l app=litellm
kubectl -n ai get secret litellm-masterkey-secret
kubectl -n identity-system logs deploy/ai-appliance-dashboard-api -c api --tail=200
kubectl -n ai logs deploy/litellm --tail=200
```

The dashboard list contains only keys marked as created by the Magic Stick
dashboard. Keys provisioned directly through LiteLLM or another automation are
intentionally neither listed nor revocable there. If a raw key was not saved,
create a replacement and revoke the old named access; do not attempt to recover
it from Kubernetes or logs. A `403` means the actor is not an administrator or
the same-origin mutation check failed. A `503` means the LiteLLM service,
master-key configuration, or PostgreSQL-backed key management is unavailable.

## Kubernetes SSO Access Checks

The dashboard **Kubernetes Access** tab is available only to a live
`magicstick-admin` session while local Keycloak identity management is enabled.
User assignment may be prepared before host OIDC is ready, but kubeconfig
download and clipboard copy stay disabled until the cluster publishes its
verified configuration.

Check the non-secret contract without decoding any client Secret:

```bash
kubectl -n identity-system get configmap magicstick-kubernetes-access-info -o yaml
kubectl -n identity-system get certificate identity-pilot-ca identity-pilot
kubectl get clusterrolebinding \
  magicstick-kubernetes-viewer \
  magicstick-kubernetes-operator-view \
  magicstick-kubernetes-admin
kubectl -n ai-system get rolebinding magicstick-kubernetes-operator-runtime
kubectl -n ai-system get role magicstick-kubernetes-operator -o yaml
kubectl -n identity-system logs deploy/ai-appliance-dashboard-api -c api --tail=200
```

On an appliance-owned K3s host, confirm the arguments without printing any
credentials:

```bash
sudo grep '^  - "oidc-' /etc/rancher/k3s/config.yaml
sudo test -r /etc/rancher/k3s/magicstick-oidc-ca.crt
sudo k3s kubectl get --raw=/readyz
```

On the administrator workstation, install
[`kubelogin`](https://github.com/int128/kubelogin). Download the kubeconfig or
copy it from the dashboard into a protected local file, then test it:

```bash
chmod 0600 ./magicstick-USER.kubeconfig
KUBECONFIG=./magicstick-USER.kubeconfig kubectl auth whoami
KUBECONFIG=./magicstick-USER.kubeconfig kubectl auth can-i list pods --all-namespaces
KUBECONFIG=./magicstick-USER.kubeconfig kubectl auth can-i get secrets --all-namespaces
```

The last command must return `no` for Viewer and Operator. Operator may mutate
only the three Magic Stick runtime CR kinds in `ai-system`. Every assignment and
kubeconfig retrieval, whether downloaded or copied, emits a
`magicstick.kubernetes-access` audit event without a token, password, kubeconfig
body, or client secret.

## AppInstance Gateway Access

The operator publishes enabled instances through Envoy Gateway and removes the
routes again when an instance is suspended or deleted. Inspect the generated
contract with:

```bash
kubectl -n ai-system get appinstances
kubectl -n identity-system get httproutes,securitypolicies \
  -l appliance.magicstick.dev/appinstance
kubectl -n ai get referencegrants
```

An SSO route must report `Accepted=True`, its SecurityPolicy must be accepted,
and its backend ReferenceGrant must name the application Service. `403` after a
successful login means the account does not have the minimum role selected in
`spec.access.role`. Each protected application route has a companion callback
route with an exact `/oauth2/callback/<route-name>` match on the shared local or
public dashboard host; both routes must be accepted by the same SecurityPolicy.

## Model Catalog

```bash
kubectl -n ai get configmap ai-model-catalog \
  -o jsonpath='{.data.AI_APPLIANCE_MODEL_CATALOG_READY}{"\n"}{.data.AI_APPLIANCE_MODEL_CATALOG_HASH}{"\n"}'

kubectl -n ai logs deploy/ai-model-catalog-controller
```

For schema details and model troubleshooting, see
[model-catalog.md](model-catalog.md).

## Local Inference And Hardware-Driven GPU Operators

KubeAI is installed only after a local model requests it. NFD is always present,
but a healthy CPU/external-only appliance has no NVIDIA, AMD, or Intel
`ModuleActivation` and no vendor operator workloads.

```bash
kubectl -n node-feature-discovery get pods
kubectl get nodes --show-labels
kubectl -n ai-system get appliance local \
  -o jsonpath='{.status.hardwareOperators}{"\n"}'
kubectl -n ai-system get moduleactivations
kubectl get nodes -o custom-columns='NODE:.metadata.name,NVIDIA:.status.allocatable.nvidia\.com/gpu,AMD:.status.allocatable.amd\.com/gpu,INTEL_I915:.status.allocatable.gpu\.intel\.com/i915,INTEL_XE:.status.allocatable.gpu\.intel\.com/xe'
kubectl -n gpu-operator get pods
kubectl -n amd-gpu-operator get pods
kubectl -n inteldeviceplugins-system get pods
kubectl -n ai get models.kubeai.org
kubectl -n ai get pods -l app.kubernetes.io/name=kubeai
```

For any local activation, inspect the resolved engine, target, profile, and
model-server logs:

```bash
kubectl -n ai-system get modelactivation qwen2505bcpu \
  -o jsonpath='{.status.engine}{" "}{.status.computeTarget}{" "}{.status.resolvedResourceProfile}{"\n"}'
kubectl -n ai get model qwen2505bcpu -o yaml
kubectl -n ai logs -l model=qwen2505bcpu --tail=200
```

If model pods fail to start, check:

- the provider phase and message in `status.hardwareOperators`
- the matching NFD detection label and, for AMD/Intel, the vendor support label
- vendor operator pods and node GPU allocatable resources
- KubeAI `Model` status
- vLLM or Ollama model pod logs
- model cache space under the host cache path

The bundled `qwen3827b` preset reserves `24062Mi` and targets a single 24
GB-class GPU. Its OpenCode output limit is 8192 tokens inside the 20000-token
vLLM context window. Paperclip uses a separate 4096-token cap and advertises a
15904-token context with a 3976-token output limit to OpenCode, retaining 4096
physical tokens as safety headroom for compaction and tool-turn overhead. If
the vLLM wrapper reports that this budget is larger than the physical GPU
memory, choose a smaller preset or create a custom activation with lower VRAM,
context, output, and concurrency values.

The portable `qwen2505bcpu` preset can also be created with `computeTarget`
`nvidia-gpu`, `amd-gpu`, or `intel-gpu`. Intel resolves to
`magicstick-intel-xe-gpu:1` or `magicstick-intel-i915-gpu:1` according to the
allocatable resource. If neither resource is present, the dashboard omits the
Intel target from the Create Model hardware dropdown and the API rejects a
forged request.
The same omission rule applies to unavailable CPU, NVIDIA, and AMD targets.

In the Dashboard, open **Models > Create Model**, choose `Local`, select the
engine, and then select one of the compute targets actually offered. A missing
target is an availability signal, not a stale disabled option: inspect the
hardware-operator state and allocatable resources above.

For vLLM, choose **Hugging Face search** to search a model name or prefix. Pick
the repository from the first full-width dropdown and then the original or
quantized artifact from the dropdown below it. The first shortcut row searches
stable model families; the second lists live Hugging Face trending models. Use
**More models** or **More quantizations** when the API reports another page.
Review the displayed publisher, format, revision,
trust, conditional download size, context, and compatibility note before
creation. The advertised model context is used as the initial **Context Size**;
reduce it when the corresponding memory estimate exceeds the selected target.
New models begin with **Max Num Seqs = 1**. Community quantizations
are discovery candidates rather than Magic Stick-tested presets. Use **Tested
preset** when a validated engine/target combination is required, or **Direct
Hugging Face URL** when the repository is already known.

For Ollama, choose **Ollama Library** to search a model-name prefix, use the
stable family shortcuts, or start from the live popular row. Select the model
and then its tag/quantization in the dropdown below. The dashboard copies the
tag's advertised download size and context into the form, starts with one
parallel sequence, and excludes cloud-only tags. Once selected, the registry
manifest refines the size and, where declared, quantization used by the memory
estimate. **Tested preset** and **Direct Ollama model reference** remain
available if public discovery is unavailable. This does not import arbitrary
Hugging Face GGUF artifacts into Ollama.

For accelerator models, 100 percent on the VRAM slider is the unreserved memory
(`total memory - active model reservations`), not the separate live free-memory
value. Gray minimum or recommended markers to the right of that limit mean the
model does not fit at that estimate; reduce model size, context, or concurrency
rather than treating the gray area as allocatable capacity.

After choosing a preset, use **Precision / Quantization** to select one of the
artifacts allowed for that exact engine and compute target. The selection
changes the checkpoint or Ollama tag and recalculates the memory plan; Magic
Stick does not quantize a full-precision checkpoint while the model starts.
For example, a Q4 Ollama artifact is a pinned GGUF registry tag, while a vLLM
AWQ, GPTQ, or FP8 entry points at a separately published Hugging Face artifact.
The selected artifact ID is stored in `spec.local.artifact` and appears in the
installed-model card and `ModelActivation.status`.

Do not copy artifact IDs between hardware targets. The operator checks the
artifact against the selected preset variant and rejects unknown combinations.
FP8 entries additionally require a GPU generation and runtime with FP8 support;
the presence of a vendor device alone does not prove this capability. If an FP8
model fails during loading, select the target's BF16 or supported integer
artifact, or use hardware with the required FP8 support.

For accelerator-backed vLLM models, the wrapper converts the selected MiB value
directly into `selected / physical GPU memory`. It does not impose a hidden
five-percent minimum; only the 98-percent upper safety cap remains. A very small
reservation can therefore still fail during model loading when weights,
activations, and the minimum KV cache do not fit, but it is never increased
silently.

For every supported local engine/target pair, the form calculates minimum and
recommended memory before creation. vLLM supports CPU, NVIDIA, AMD, and Intel;
Ollama supports CPU, NVIDIA, and AMD. The CPU RAM slider and accelerator VRAM
slider both end at the target's unreserved memory. Values beyond that capacity
remain visible only as minimum/recommended markers in the gray overflow area.
Displayed requirements and selections use 100 MiB planning increments. Values
round upward; the safe unreserved ceiling rounds downward so a selectable value
never exceeds planning capacity. The React dashboard breakdown separates weights, theoretical
or estimated KV cache, hybrid-allocator safety, compile/warm-up headroom,
multimodal processor cache, quantization working copy, generic engine reserve,
and recommendation headroom. Download size is shown as storage/network context
and is not added to the memory requirement. Ollama's registry manifest provides
exact model-layer bytes, while its KV-cache component remains a conservative
estimate because full GGUF dimensions are not present in the manifest.

For a CPU target, the selected value becomes the model pod's Kubernetes memory
request in 16 MiB units. Check the requested value after creation:

```bash
kubectl -n ai get pods -l app.kubernetes.io/name=kubeai \
  -o custom-columns='POD:.metadata.name,MEMORY-REQUEST:.spec.containers[*].resources.requests.memory'
```

If the reservation exceeds memory schedulable on any eligible node, Kubernetes
keeps the model pod Pending. Reduce the reservation or make capacity available;
do not remove the request because it protects other appliance workloads from an
unbounded inference process.

With `engine: OLlama`, portable presets use explicit registry tags such as
`ollama://qwen3.5:9b-q4_K_M`; CPU, NVIDIA, and AMD are supported. Intel remains
unavailable for Ollama until a validated image/profile is added. The server
images are pinned to the same upstream Ollama release for standard and ROCm
runtimes. Ollama model blobs persist below `/root/.ollama` on the appliance
host, so a model-pod restart does not normally download the complete model
again.

## Storage

```bash
kubectl get pvc -A
kubectl -n ai get pvc
```

Storage sizes in the public template default to small values. Private
deployments should patch or substitute production sizes before relying on the
appliance for persistent data.

## Logs

```bash
kubectl -n ai logs deploy/litellm
kubectl -n ai logs deploy/anything-llm
kubectl -n ai logs deploy/ai-model-catalog-controller
kubectl -n ai logs statefulset/paperclip
```

For operator-backed apps, also check the operator namespace:

```bash
kubectl -n hermes-operator-system logs deploy/hermes-operator-controller-manager
kubectl -n openclaw-operator-system logs deploy/openclaw-operator-controller-manager
kubectl -n paperclip-operator-system logs deploy/paperclip-operator-controller-manager
```

Deployment names can vary by chart version. Use `kubectl -n <namespace> get
deploy,pods` if a command does not match the running resource name.

## Common Failures

| Symptom | First checks |
|---|---|
| Flux Kustomization is `False` | `kubectl -n flux-system describe kustomization <name>` and render the same path locally with `kubectl kustomize`. |
| HelmRelease is not ready | `kubectl -n flux-system describe helmrelease <name>` and inspect chart values. |
| Custom legacy Ingress has no endpoint | The nginx controller is intentionally not installed. Bundled surfaces already use Envoy; migrate custom applications to an authenticated `HTTPRoute`. |
| App waits for model catalog | Check `ai-model-catalog-controller` logs and `AI_APPLIANCE_MODEL_CATALOG_READY`. |
| OpenClaw reports that auto-compaction cannot recover immediately in a new chat | Check that `openclaw.json` contains the generated `agents.defaults.compaction` policy and `tools.profile: coding`, then restart the OpenClaw instance so its operator-managed configuration is reapplied. Do not raise the reserve floor to the full context size of a small local model. |
| Hermes instance URL returns `404: Not Found` | The agent gateway on port `8443` has no root UI. Confirm the Hermes instance enables `HERMES_DASHBOARD=true`, its Service exposes port `9119`, and the generated `HTTPRoute` targets port `9119`. |
| LiteLLM Prisma reports `P1000` authentication failed | The PostgreSQL PVC may be older than `litellm-postgresql-secret`. Keep generated DB credentials prune-disabled and rotate the DB user password to match the current Secret. |
| LiteLLM Models shows `Virtual Key expected` with a token beginning `eyJ` | The Keycloak JWT replaced LiteLLM's own API key. Confirm both `static-litellm-*-sso` policies set `spec.oidc.forwardAccessToken: false`, reconcile `app-litellm`, and reload the LiteLLM UI. |
| An AI UI stops a longer answer with `TypeError: network error`, `Could not respond`, or `An error occurred while streaming response` | Check the Envoy access log for `response_code_details=response_timeout`, `response_flags=UT`, and a duration near 15000 ms. Confirm the application's local/public `HTTPRoute` sets `spec.rules[].timeouts.request: "0s"`. Reconcile the static module or `magicstick-operator` as appropriate. |
| Application shows a second login after SSO | Confirm Paperclip uses `deployment.mode: local_trusted` with `exposure: private`, the patched operator emits `PAPERCLIP_BIND=loopback`, and its `gateway-loopback-proxy` sidecar is ready; confirm Odysseus has `AUTH_ENABLED=false` and the application Service is exposed only through its authenticated Envoy route. |
| Paperclip task reports that provider `kubernetes` is not registered or creates no Sandbox | Check that plugin `paperclip.kubernetes-sandbox-provider` is `ready`, then check `sandboxes.agents.x-k8s.io`, the Agent Sandbox controller, `PAPERCLIP_K8S_ADAPTER_TYPE=opencode_local`, `spec.adapters.execution.kubernetes.backend`, and the selected adapter runtime image. For K3s, confirm control-plane egress TCP `6443`; for Rancher namespace admission failures, confirm the instance-specific `updatepsa` ClusterRoleBinding. |
| Paperclip onboarding discovers OpenCode models but the hello probe times out | Verify that the Paperclip server Pod can connect to `litellm.ai.svc.cluster.local:4000` and that its additive NetworkPolicy permits TCP `4000` only to Pods labeled `app=litellm`. OpenCode retries an immediate connection refusal with backoff, so this otherwise appears as a slow 60-second probe. |
| Paperclip task stops after `Sandbox run log streaming enabled` | Find the namespace labeled `paperclip.io/managed-by=paperclip-k8s-plugin` and verify `NetworkPolicy/magicstick-paperclip-runtime-egress` exists. The policy must select `paperclip.io/role=agent` and permit only the owning Paperclip server on TCP `3100` plus `app=litellm` on TCP `4000`. Check `magicstick-operator` logs and RBAC if it is absent. |
| Paperclip task repeatedly runs for minutes and LiteLLM reports `ContextWindowExceededError` | Check that `paperclip-opencode-providers.json` advertises a smaller context than the physical model limit. For the bundled 20000-token Qwen preset the Paperclip value is 15904 with output 3976. Reconcile the model catalog and restart the affected Paperclip run after the generated provider file changes. |
| Paperclip task spends most of its run searching instructions or reports `skill ripgrep execution failed` | Confirm the Sandbox uses the pinned official Paperclip OpenCode runtime and that `rg --version` succeeds in it. Confirm the Paperclip Pod mounted the guarded adapter patch and its source-validation init container completed. Runs still keep the upstream 15-minute transport ceiling; repeated searches are a runtime or instruction-contract failure, not a reason to raise that timeout. |
| Paperclip run succeeds but generated files are absent from the task workspace, or logs show `PAPERCLIP_WORKSPACE_CWD=/tmp` while tools write below `/workspace` | Confirm the guarded OpenCode adapter patch is mounted and the init container found its exact pinned source. Paperclip `v2026.707.0` drops the Kubernetes `realizeWorkspace` result before transport resolution; Magic Stick normalizes only the Kubernetes `/tmp` fallback to the runtime's `/workspace` mount. Restart the Paperclip Pod after updating the template and use a fresh run/session. |
| Paperclip run creates local files but neither task documents nor a final issue status | Confirm the agent has `paperclipai/paperclip/paperclip` in `paperclipSkillSync.desiredSkills` and its `bootstrapPromptTemplate` contains `[MagicStick Paperclip heartbeat v2]`. Availability alone does not force OpenCode to load a skill; the managed bootstrap directive makes the upstream Paperclip heartbeat procedure explicit without modifying the skill. |
| A sandboxed Paperclip agent reports that Paperclip is unavailable on `localhost:3020` or `localhost:3100` | Those literal ports are invalid inside the run sandbox. Paperclip injects a run-scoped callback bridge through `PAPERCLIP_API_URL`; the Magic Stick heartbeat bootstrap directive requires every agent API request to use that value. Reconcile the instance and start a fresh agent session so the current directive is applied. |
| Paperclip run stays pending and the tenant namespace reports `exceeded quota: paperclip-quota` | Compare each Sandbox `paperclip.io/run-id` with the Paperclip heartbeat run. The instance helper removes only terminal runs after a 60-second grace; inspect the `gateway-loopback-proxy` log if they remain. Confirm the instance-specific `sandbox-reconciler` ClusterRole adds only `list`; the operator-owned execution role already supplies Sandbox deletion. Do not increase the quota to mask orphaned runtime Pods. |
| Paperclip sandbox cannot call a model | Check `paperclip-opencode-providers.json`, `litellm-masterkey-secret`, LiteLLM on port 4000, and NetworkPolicies in the Paperclip tenant namespace. |
| Generated Secret missing | Check the secret generator HelmRelease and Secret annotations. |
| OIDC route does not redirect | Check the `SecurityPolicy` and `HTTPRoute` status, Keycloak readiness, the Envoy data-plane logs, and whether the identity and requested application hostnames resolve to the Envoy LoadBalancer address. |
| AppInstance route returns `403` after SSO | Compare `spec.access.role` with the user's `magicstick-user`, `magicstick-viewer`, `magicstick-operator`, or `magicstick-admin` realm roles. |
| Static AI route returns `403` after SSO | AI routes require at least `magicstick-user`. Check the user's realm roles and the corresponding static `SecurityPolicy`. |
| Dashboard returns `403` after login | Confirm the user has `magicstick-viewer`, `magicstick-operator`, or `magicstick-admin`; configuration changes need operator or admin as documented in `authentication.md`. |
| `magicstick login` cannot resolve `api.magicstick.local` | Confirm `dashboard-api-local` is accepted, carries `lab42.io/mdns.enabled: "true"`, the Gateway has an address, and kdns has published the route. Override `MAGICSTICK_API_URL` only for the actual appliance hostname. |
| `magicstick login` reports that no device endpoint is advertised | Confirm the `magicstick-cli` client exists in the `magicstick` realm with Device Authorization Grant enabled, and let the Keycloak post-start reconciliation complete. |
| CLI/TUI reports a local certificate verification error | Export and trust the Magic Stick local CA with `NODE_EXTRA_CA_CERTS`. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`. |
| CLI receives `401 access token client is not trusted` | Confirm the dashboard API Deployment uses `OIDC_EXPECTED_CLIENT_IDS=magicstick-human-gateway-local,magicstick-cli`, then log in again so the token has `azp=magicstick-cli`. |
| Users tab is missing for an administrator | Confirm the session contains `magicstick-admin` and the installation uses local Keycloak rather than the direct-external-provider escape hatch. Refresh the browser after role changes. |
| Users tab reports that Keycloak is unavailable | Check Keycloak readiness, the dashboard API logs, the existence of `magicstick-user-admin-client`, and its exact-name Secret Role. Do not decode the Secret. |
| User change returns `409` | Check whether the account is external, protected, the current actor, or the last enabled local administrator. Duplicate username or email also returns `409`. |
| API Access tab is missing | Confirm the current session contains `magicstick-admin`, then refresh after any role change. Unlike Users, this tab does not depend on local Keycloak user-administration mode. |
| API Access reports LiteLLM key management unavailable | Check the LiteLLM Pod and Service, PostgreSQL readiness, and the existence of `ai/litellm-masterkey-secret` without decoding it. Lost raw keys cannot be recovered; create a replacement and revoke the old named access. |
| Kubernetes Access tab is missing | Confirm the current session contains `magicstick-admin`, local Keycloak identity management is active, and refresh after any role change. |
| Kubernetes kubeconfig download is disabled | Check `identity-system/magicstick-kubernetes-access-info`. On appliance K3s, rerun the host converge so the identity CA is installed and the API server is restarted with OIDC. On an existing cluster, complete the platform-specific API-server configuration and publish the marker as documented. |
| `kubectl oidc-login` cannot open or complete login | Install the kubelogin plugin, verify `id.<mdns-domain>` resolves from the workstation, trust only the CA embedded in the kubeconfig, and ensure loopback ports `8000` or `18000` are available. |
| OpenLens reports `lookup <appliance>.local ... no such host` | Download the kubeconfig again. Appliance kubeconfigs use the current private control-plane IP for the Kubernetes API because the OpenLens proxy may bypass mDNS. If DHCP changed the address again, rerun host convergence or wait for the Ready node address to be visible, then download a fresh file. Keep the OIDC issuer on `id.<mdns-domain>`. |
| Kubernetes login succeeds but RBAC is denied | Confirm the user has exactly one direct `magicstick-kubernetes-*` group, obtain a fresh token after the group change, and inspect the `oidc:` Group subjects in the ClusterRoleBindings. |
| GPU model never starts | Check the vendor GPU operator, allocatable GPU resources, KubeAI model status, and the selected vLLM/Ollama server logs. |
| GPU hardware is present but provider is `Unsupported` | Confirm node architecture/Kubernetes preflight first. For AMD or Intel, the broad PCI vendor label can exist while the vendor `NodeFeatureRule` rejects that product; use the operator's supported-hardware documentation instead of adding a Magic Stick PCI allow-list. |
| Provider is `Conflict` | A vendor CRD already existed without a Magic Stick `ModuleActivation`. Decide which installation owns the operator; do not run a second copy. |
| Provider remains `Installing` with zero resources | The controller chart is installed but driver/device-plugin readiness is incomplete. Inspect the vendor namespace and the node's allocatable extended resources. AMD's baseline expects a working host/inbox `amdgpu` driver. |
| NVIDIA remains `Installing` although `nvidia.com/gpu` is allocatable | The driver and device plugin are active, but the dashboard cannot read DCGM telemetry yet. Check the `nvidia-dcgm-exporter` Pod, Service, endpoints, and the dashboard API ServiceAccount's `services/proxy` permission. |
| Provider changes to `Unknown` after reboot | NFD has temporarily lost the PCI signal. Magic Stick intentionally retains the existing operator; wait for the next 60-second NFD pass and inspect the node before taking action. |
| Local model stays in `WaitingForGPU` | The optional runtime is installed but Kubernetes reports no allocatable `nvidia.com/gpu`; verify supported hardware, driver pods, and node capacity. |
| Accelerator target is disabled in the dashboard | The matching vendor module must be `Ready` and a Ready schedulable node must expose `nvidia.com/gpu`, `amd.com/gpu`, `gpu.intel.com/i915`, or `gpu.intel.com/xe`. CPU remains available independently. |
| A Compute memory gauge shows `metrics unavailable` | CPU first checks the Kubelet node summary and then `metrics.k8s.io`; verify the dashboard API ServiceAccount can read `nodes/proxy` and node metrics. NVIDIA requires the DCGM exporter. AMD and Intel are still listed but intentionally show no percentage until a compatible vendor memory exporter is installed. |
| Intel model stays in `WaitingForGPU` | Confirm whether the node publishes `gpu.intel.com/xe` or `gpu.intel.com/i915`; the resolved profile in `ModelActivation.status` must match that resource. |
| A GPU appears in Compute memory but not in the model hardware selector | Confirm the vendor module is enabled and inspect the node's allocatable resource (`nvidia.com/gpu`, `amd.com/gpu`, `gpu.intel.com/xe`, or `gpu.intel.com/i915`). A transient Flux `Reconciling` phase no longer blocks selection once that resource exists; without it, the driver or device plugin is not ready. |
| CPU model stays in `Starting` | Check the CPU model Pod for image-pull, RAM, CPU, model-download, or vLLM startup failures; no NVIDIA checks should appear. |
| CPU vLLM reports insufficient memory for KV cache | Recreate the model through the current dashboard so `spec.local.kvCacheMemoryBytes` is derived from model architecture, context, and maximum sequences. Older or directly created resources without that field retain the 512 MiB compatibility fallback. Reduce context or concurrency when the derived minimum exceeds unreserved RAM; do not bypass the server-side minimum check. |
| CPU vLLM is OOM-killed while loading or warming a quantized or multimodal model | The current estimator includes checkpoint bytes, a possible runtime working-weight copy, compile/warm-up headroom, the multimodal processor cache, and a conservative hybrid-cache factor. Confirm that the `ModelActivation` contains both `memoryRequiredMi` and `kvCacheMemoryBytes`, then compare the Pod limit and cgroup peak. If the recommendation is larger than the node, reduce context or choose a smaller model instead of raising only the timeout. |
| Hugging Face model search is unavailable or rate-limited | Retry after the short-lived discovery cache can refresh, narrow a broad prefix, and inspect the dashboard API log without printing credentials. Model discovery uses only the public Hugging Face API. Tested presets and direct `hf://` references remain available and do not depend on the search endpoint. |
| Ollama Library search or tag lookup is unavailable | Retry after the short-lived discovery cache can refresh and inspect the dashboard API log. Discovery reads only bounded public `ollama.com` pages because Ollama does not document a remote catalog API. Tested presets and direct `ollama://` references remain available; model creation is not coupled to Library discovery. |
| A selected Hugging Face quantization fails during model loading | Treat dynamic community artifacts as experimental. Confirm the repository format and quantization are supported by the selected vLLM image and CPU/GPU generation, compare the memory estimate with the actual node, and try the original repository or a tested preset. Magic Stick discovers artifacts; it does not convert or validate every third-party quantization. |
| Local model stays in `Starting` | Compare `kubectl -n ai get model <name> -o jsonpath='{.status.replicas}'` with the model pod readiness and selected engine logs. The model is intentionally absent from LiteLLM until at least one replica is ready. |
| Ollama model stays in `Starting` with `WaitingForOllamaAlias` | The source tag is still downloading, the model API is unreachable, or the KubeAI-name alias is absent. Check `ollama list` in the model pod and the `ModelActivation.status.message`. The operator creates the alias automatically as soon as the source tag is complete; do not publish a manual LiteLLM route around this guard. |
| LiteLLM returns `404 model '<name>' not found` for an Ollama model | Confirm the `ModelActivation` is `Ready` under the current operator revision. Older revisions trusted KubeAI replica readiness before the Ollama alias existed. Reconcile or restart the Magic Stick Operator after updating; it verifies the alias through `/api/tags` and repairs it through `/api/copy`. |
