# CLI and TUI

## CLI and TUI

`dashboard/apps/cli` builds one self-contained Node.js executable named
`magicstick`. It provides human-readable tables by default and JSON with
`--json`. Read commands cover the appliance overview, services, instances,
models and model discovery, settings, users, API keys, Kubernetes access, and
system status. Explicit mutation commands cover module lifecycle, arbitrary
catalog-backed instance payloads, model estimation and lifecycle, settings,
the complete local-user lifecycle, named API keys, and Kubernetes access and
kubeconfig generation.

The interactive `magicstick tui` command exposes the same role-filtered areas
as the React application and refreshes the shared snapshot automatically. It is
also a lifecycle client: operators can enable or disable catalog services and
create or remove local and external models; administrators can perform the
local-user lifecycle, create and revoke named API keys, and assign or revoke
SSO-backed Kubernetes access. The TUI calls the same authenticated API client
as the explicit CLI commands, preserves API authorization checks, confirms
destructive actions, masks passwords, and shows API-key secrets only once.
Token-free kubeconfigs can be copied with the terminal's OSC 52 clipboard
protocol. Instance creation remains available in the browser or through the
complete JSON-payload CLI command.

The seven-line, borderless ASCII space banner carries **AIppliance** and
**Magic Stick** on two lines of a USB spacecraft, without a duplicate heading
below it. There is no caption row. The denser starfield includes dim gray stars
across all seven rows, behind the foreground artwork. Most are stationary and
only a small minority drift, one column every 24 seconds, with gentle twinkling.
The ship has a rounded hull and nacelles, without flame effects; its metal
connector disappears fully inside a slightly wider, compact PC containing
a graphics card with three large, multi-row fans enclosed
in a gray shroud and a finned heatsink, without USB or GPU text labels.
Beside the fans, a small light-gray readout shows decorative **IDLE** / **SPIN** /
**READY** status, artificial usage %, and **TPS** (tokens per second).
These slowly changing values are not live appliance metrics, even outside demo mode.
Startup inserts the stick once and triggers a decorative boot-up, accelerating
orange-accented fans only inside the case; there are no external power sparks.
The stick remains connected and the
PC stays on. The pair is centered across the terminal, including wide screens.
Gray/orange visitors and a golden floating laptop appear for about 18 seconds
roughly every two minutes, with long quiet gaps and no purple accents. The laptop
has an outlined screen, keyboard, and touchpad. Clear side stages show its full
screen and base where space permits; compact screens use a three-row lower lane.
Startup travel runs at half speed; the main docking sequence does not loop.
Animation runs continuously, including during dialogs; there is no pause/resume
control. Terminals shorter than 19 rows hide the banner to preserve working
space, without stopping the animation clock.
Animation is independent of API refreshes and works in live and offline modes,
including with `--no-color`. The standalone
[banner module](../../dashboard/apps/cli/src/banner.ts) owns the artwork and timing.

For a frontend-only preview, `magicstick tui --demo` (or `corepack pnpm tui:demo`
from the built dashboard workspace) displays all nine tabs with synthetic
sample data. The **OFFLINE DEMO** header distinguishes it from a real session.
This mode makes no network requests, reads no saved configuration or credentials,
and disables live actions, clipboard exports, and sign-out. It does not alter
the real client's role checks or supply runtime CR seeds. See the
[offline preview instructions](../../dashboard/README.md#offline-terminal-preview).

The default endpoints are:

- control-plane API: `https://api.magicstick.local`
- issuer: `https://id.magicstick.local/realms/magicstick`
- public OIDC client: `magicstick-cli`

`api.<mDNS-domain>` is an mDNS-published `HTTPRoute`. Its Envoy
`SecurityPolicy` validates Keycloak JWTs before forwarding the request. The
public CLI client enables only Device Authorization Flow: it has no secret,
redirect URI, password grant, implicit flow, or service account. The CLI opens
the verification page when possible and prints the URL and one-time user code,
so login also works in a remote shell. Access and refresh tokens are stored in a
mode-`0600` session file below the XDG configuration directory; `logout` removes
that local session. Password operations accept a protected file or stdin and
never a command-line password value.

Build and use the terminal client with:

```bash
cd dashboard
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm cli --help
pnpm cli login
pnpm tui
pnpm cli console
```

Use `MAGICSTICK_API_URL`, `MAGICSTICK_ISSUER`, and
`MAGICSTICK_CLIENT_ID` for a non-default deployment. A caller may provide an
existing short-lived token through `MAGICSTICK_ACCESS_TOKEN`; it is not cached.
The CLI also uses CAs trusted by the operating system. If the appliance-local
CA has not been installed there, pass its public certificate once with
`pnpm cli --ca-file /path/to/magicstick-oidc-ca.crt login`. The path is saved
in the private CLI configuration for later CLI and TUI calls. Alternatively,
set `MAGICSTICK_CA_FILE` or
`NODE_EXTRA_CA_CERTS=/path/to/magicstick-oidc-ca.crt`. For a disposable test
appliance on a trusted network, `--insecure` is an explicit escape hatch: it
disables TLS verification only for that CLI process, prints a warning, and is
never saved. Prefer the CA-based path for normal use.

### Physical appliance console

Bare-metal and Linux-host installations automatically display the TUI on the
attached monitor after first-run setup is complete. The setup claim page and
the operational TUI share virtual terminal 9 but never run concurrently:

1. `magicstick-setup-console.service` owns terminal 9 while the one-time claim
   exists.
2. Successful setup removes the claim and starts
   `magicstick-dashboard-console.service`.
3. The console requests a Keycloak device login if it has no usable cached SSO
   session, then starts `magicstick console`.

The terminal client is packaged into a dedicated Node.js CLI runtime image and
executed in a dedicated runtime Deployment with no Service, no ingress and no
Kubernetes service-account token. API and token polling traffic uses cluster-internal
transport while the token issuer and browser verification address remain the
canonical `id.<mDNS-domain>` URL. The persistent session directory is mounted
only into that runtime and stores mode-`0600` token data; no password or client
secret is provisioned. Press `x` in the TUI to remove the local session and
authorize a different user. Pressing `q` exits the current process, after which
the appliance service restores the TUI automatically.

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/session` | Returns the authenticated username and local realm roles. |
| `GET` | `/api/appliance` | Returns `Appliance/local`. |
| `PATCH` | `/api/appliance` | Returns `405`; `Appliance/local.spec` is Git-owned. |
| `GET` | `/api/settings` | Returns public domain, its derived dashboard host, mDNS domain, and derived mDNS name. |
| `PATCH` | `/api/settings` | Validates and patches `flux-system/ai-appliance-settings`, keeps the dashboard host synchronized with the public domain, and preserves unrelated keys. |
| `GET` | `/api/modules` | Returns catalog metadata plus current `ModuleActivation` spec/status. |
| `POST` | `/api/modules/{name}/enable` | Creates or patches a `ModuleActivation` with `spec.enabled: true`. |
| `POST` | `/api/modules/{name}/disable` | Creates or patches a `ModuleActivation` with `spec.enabled: false`. |
| `GET` | `/api/modules/{name}/credentials` | Returns credentials for an enabled catalog module with an explicitly supported provider, currently LiteLLM. |
| `GET` | `/api/instances` | Returns `AppInstance` resources and status. |
| `GET` | `/api/my-instances` | Minimal granted instance launchpad for any Magic Stick user. |
| `GET` | `/api/instance-principals` | Live admin: paginated user/group directory IDs and names. |
| `GET` / `PUT` | `/api/instances/{name}/access` | Live admin: inspect sharing; updates also require entitlement, ready guard, CSRF and expected resource revision. |
| `GET` | `/api/instances/{name}/credentials` | Returns supported generated credentials for an instance, currently OpenClaw. |
| `POST` | `/api/instances/{type}` | Adds or replaces an `AppInstance` for supported types such as `openclaw`, `hermes`, `odysseus`, `paperclip`, or `kubeopencode`. |
| `DELETE` | `/api/instances/{name}` | Deletes the `AppInstance`; its finalizer removes the generated HelmRelease and Helm cleans the application resources. |
| `GET` | `/api/models` | Returns model catalog entries, variant-aware presets, compute-target availability including FreeToken GPU capabilities, `ModelActivation` resources, AnythingLLM status, the estimator-compatible VRAM summary, and a `computeMemory.devices` list for the CPU and every discoverable GPU resource. |
| `GET` | `/api/models/{name}/logs?tailLines=` | Administrator-only bounded snapshot of current and, after restarts, previous output from Pods owned by the named local model. The API derives namespace, Pods, and containers from the activation and Kubernetes ownership; clients cannot select arbitrary Pods. |
| `GET` | `/api/models/compute-targets` | Returns CPU/NVIDIA/AMD/Intel availability, supported engines and KV-cache formats, resolved resource/profile, FreeToken's server-derived NVIDIA capability set, and a non-sensitive reason when a target or FreeToken GPU is unavailable. |
| `GET` | `/api/model-discovery/search?provider={huggingface,ollama}&engine={VLLM,OLlama,FreeToken}&q=&cursor=&limit=` | Searches public Hugging Face repositories or prefix-matching Ollama Library model names and returns bounded metadata plus a continuation cursor. FreeToken discovery applies its central supported-model policy rather than Hugging Face's vLLM app filter. |
| `GET` | `/api/model-discovery/popular?provider={huggingface,ollama}&engine={VLLM,OLlama,FreeToken}&limit=` | Returns Hugging Face trending models or Ollama's public popularity order, filtered for the selected model type, engine, compute target, and FreeToken policy where applicable. |
| `GET` | `/api/model-discovery/artifacts?provider={huggingface,ollama}&engine={VLLM,OLlama,FreeToken}&repo=&cursor=&limit=` | Resolves directly related Hugging Face quantizations or the selected Ollama model's locally runnable tags; FreeToken rejects a model outside its documented supported-model policy before configuration. |
| `GET` | `/api/status` | Returns runtime objects and the catalogued NVIDIA/AMD/Intel operator lifecycle from `Appliance.status.hardwareOperators`, including AMD `compatibility` profiles, host evidence and per-engine validation. |
| `POST` | `/api/models/estimate-memory` | Estimates minimum and recommended RAM or accelerator memory for every supported local engine/compute-target/KV-cache combination; an explicit NVIDIA `cpuOffloading: true` plus VRAM budget returns a separate `offloading` RAM/VRAM plan. |
| `POST` | `/api/models/{name}/estimate-memory` | Operator-only edit estimate for an existing local model. It merges editable runtime parameters with the deployed model identity and excludes that model's current reservation from available capacity. |
| `POST` | `/api/models/estimate-vram` | Backward-compatible alias for `/api/models/estimate-memory`. |
| `POST` | `/api/models/local` | Adds or replaces a local `ModelActivation`: KubeAI-backed for vLLM/Ollama and Magic Stick's direct runtime adapter for FreeToken. |
| `POST` | `/api/models/external` | Adds or replaces an external LiteLLM-backed `ModelActivation`; Dashboard-entered API keys are stored as Secrets. |
| `PUT` | `/api/models/{name}` | Operator-only, CSRF-protected update of editable runtime/provider parameters. The request is bound to `expectedRevision`; model source, local engine, hardware target, namespace, and name remain unchanged. |
| `POST` | `/api/models/{name}/start` | Re-enables a retained `ModelActivation` and lets its normal reconciler recreate the runtime. |
| `POST` | `/api/models/{name}/stop` | Disables a `ModelActivation`; its operator-managed local runtime is removed without deleting the saved configuration. |
| `POST` | `/api/models/{name}/restart` | Requests a safe rollout restart of a FreeToken runtime by changing an operator-owned nonce; vLLM/Ollama continue to use their existing reconciliation lifecycle. |
| `POST` | `/api/models/local-runtime/remove` | Removes model-created runtime activations after all local models have been removed; a hardware-detected GPU operator is preserved. |
| `DELETE` | `/api/models/{name}` | Deletes the `ModelActivation` and a Dashboard-created provider Secret when present. |
| `GET` | `/api/status` | Returns Appliance, Flux, Pod, Service, and Ingress status summaries. |
| `GET` | `/api/events` | Returns core and `events.k8s.io` event summaries. |
| `GET` | `/api/users?search=&first=&max=` | Searches human Keycloak users with bounded server-side pagination. |
| `GET` | `/api/users/{id}` | Returns one sanitized human-user representation. |
| `POST` | `/api/users` | Creates a local user with a temporary password and selected access level. |
| `PATCH` | `/api/users/{id}` | Updates locally managed profile fields. |
| `PUT` | `/api/users/{id}/roles` | Replaces only the direct MagicStick access roles and preserves unrelated roles. |
| `POST` | `/api/users/{id}/enable` | Enables the account. |
| `POST` | `/api/users/{id}/disable` | Disables the account and requests a Keycloak logout. |
| `PUT` | `/api/users/{id}/password` | Sets a temporary local password and requests a Keycloak logout. |
| `DELETE` | `/api/users/{id}` | Deletes an eligible local account. |
| `GET` | `/api/api-access` | Lists only named LiteLLM virtual keys created through this dashboard plus the local/public API bases; raw key values are never returned. |
| `POST` | `/api/api-access` | Creates a named LiteLLM virtual key and returns its raw value exactly once. |
| `DELETE` | `/api/api-access/{id}` | Verifies dashboard ownership and revokes one named LiteLLM virtual key. |
| `GET` | `/api/kubernetes-access?search=&first=&max=` | Lists human Keycloak users, their direct Kubernetes access group, and non-secret cluster OIDC readiness. |
| `PUT` | `/api/kubernetes-access/{id}` | Replaces only the user's direct Magic Stick Kubernetes group and requests a Keycloak logout. |
| `GET` | `/api/kubernetes-access/{id}/kubeconfig` | Returns a user-labelled kubeconfig with cluster/identity CAs and an OIDC exec plugin, but no token, password, or client secret. |
| `GET` | `/api/federated-sso` | Admin-only sanitized state for dashboard-managed providers, capability status, stable issuer and callback template. No provider secret or raw Keycloak representation is returned. |
| Internal | `/internal/federation-license` | Envoy-only entitlement decision for external Keycloak broker requests. No user authentication or identity data; exact `200` only for a verified active entitlement, otherwise deny. Local login/recovery do not use this route. |
| `POST` | `/api/federated-sso/validate` | Entitled live admin: validates allowlisted input and asks Keycloak to import OIDC discovery or SAML metadata without saving a provider. |
| `POST` | `/api/federated-sso/providers` | Entitled live admin: creates a provider disabled first, installs server-generated role mappers, then enables it only after the complete write succeeds. |
| `PUT` | `/api/federated-sso/providers/{alias}` | Entitled live admin: updates an immutable alias using the expected sanitized revision; OIDC updates require the client secret again. |
| `DELETE` | `/api/federated-sso/providers/{alias}` | Live admin: deletes a dashboard-owned provider after expected-revision confirmation. Deletion remains available without entitlement for recovery. |

All read endpoints require `magicstick-viewer`, `magicstick-operator`, or
`magicstick-admin`. Instance credential reads and runtime mutations require
operator or admin. Settings changes require admin. Envoy authentication alone
does not authorize a configuration change. All `/api/users` endpoints require
`magicstick-admin`, re-check that the actor is still enabled and still an
administrator in Keycloak, and return only sanitized fields and capability
flags. Mutations require the `X-MagicStick-CSRF` request marker. Browser
mutations additionally require valid same-origin metadata; a Bearer-authenticated
terminal client sends no browser `Origin` or `Sec-Fetch-Site` headers.
All `/api/api-access` endpoints require `magicstick-admin`; create and revoke
requests use the same same-origin and CSRF checks.
All `/api/kubernetes-access` endpoints require `magicstick-admin` and a live
Keycloak administrator check. Mutations use the same same-origin and CSRF
checks. Kubeconfig download additionally requires an enabled target user, a
non-empty grant, and a cluster-published OIDC readiness marker.
