# Identity diagnostics

## Identity Pilot Checks

```bash
kubectl -n flux-system get kustomizations envoy-gateway identity-pilot
kubectl -n envoy-gateway-system get helmrelease,pods
kubectl -n identity-system get pods,pvc,gateway,httproute,securitypolicy
kubectl -n identity-system logs deploy/keycloak
```

Envoy Gateway is the installed application gateway and exposes the HTTPS
listener through a `LoadBalancer` service. Follow
[authentication.md](../../concepts/identity.md) for local name resolution, login
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
abandoned. See [first-run-setup.md](../../installation/first-run-setup.md).

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

After the first-run state becomes `Completed`, the cleanup service removes the
claim and hands the same virtual terminal to the operational TUI:

```bash
sudo systemctl status magicstick-dashboard-console.service --no-pager
sudo k3s kubectl -n identity-system get deployment,pod \
  -l app.kubernetes.io/name=magicstick-dashboard-console
```

The monitor shows a one-time Keycloak device-login code when no usable console
session exists. Authorize it from a browser on the local network; the TUI then
loads automatically. The console stores only the resulting SSO token state in
`/var/lib/magicstick/dashboard-console` with private permissions. It does not
store the user's password. `Ctrl+Alt+F1` opens the normal system console and
`Ctrl+Alt+F9` returns to Magic Stick. Inside the TUI, `x` signs out and starts a
new device login; `q` exits the current TUI process, which the service starts
again after a short delay.

If terminal 9 remains on the setup page after completion, inspect both handoff
units and trigger the idempotent cleanup once:

```bash
sudo systemctl start magicstick-setup-cleanup.service
sudo systemctl restart magicstick-dashboard-console.service
```

If the waiting page reports that the runtime is not ready, verify that the
current CLI runtime image contains `/usr/local/bin/magicstick-dashboard`. The
runtime liveness probe restarts an outdated container so `imagePullPolicy:
Always` can pick up the current image without exposing the runtime on the
network.

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

The React dashboard is the standard UI at `https://magicstick.local/` and the
configured public-domain root. It uses the existing primary routes and OIDC
cookies; there is only one frontend Deployment. Check it without reading
credentials:

```bash
kubectl -n dashboard get deploy,service ai-appliance-dashboard
kubectl -n identity-system get httproute dashboard-local dashboard-public
kubectl -n identity-system get securitypolicy \
  dashboard-local-oidc dashboard-public-oidc
```

For Federated SSO, first confirm the `keycloak-federation` HTTPRoute and
`keycloak-federation-license` SecurityPolicy are accepted/programmed in
`identity-system`. Test expiry and an unavailable license API: external broker
login/callback requests must fail closed while local login, password recovery,
and ordinary component OIDC remain available. Do not treat a rendered policy as
proof of live enforcement. The periodic provider check additionally disables
external brokers without deleting their configuration.

For a release acceptance pass, verify the standard dashboard against the live
appliance state with each supported authenticated role:

1. **Overview:** compare counts and verify that every module and instance route
   can be opened and copied from its grouped resource row.
2. **Services:** exercise all three filters, expand an application and one
   instance, inspect progress/routes, open supported credentials, and verify
   that every application type exposes its complete create form.
3. **Models:** compare compute gauges, search Hugging Face and Ollama, select an
   artifact, verify context/download metadata and capacity markers, then inspect
   an existing activation. Open **Edit**, confirm **Save changes** is initially
   disabled, change one runtime parameter, verify the recalculated memory plan,
   save, and confirm the activation is reconciled without changing its local
   model source, engine, or compute target. Also verify the guarded remove
   controls. As an administrator,
   open **Logs** for a local model, confirm that the Pod/container identity is
   correct, refresh the bounded output, and check previous output when a
   container has restarted.
4. **System:** exercise all role-visible category tabs. Under **Settings**,
   compare the loaded public and mDNS domains and save only when a controlled
   domain mutation is part of the test. Under **Users**, as an administrator,
   search and filter users, inspect effective versus direct access, and open
   every lifecycle dialog without changing a recovery or current account.
   Under **License**, verify the current entitlement summary without replacing
   the installed file. Under **System Status**, compare operator, Flux, workload,
   and route summaries and verify that an applied GPU operator is not called
   ready before its resource and telemetry are active.
5. **API Access:** verify API bases and open the create dialog. A release test
   that creates a key must copy it from the one-time view and revoke it again.
6. **Kubernetes Access:** verify OIDC readiness, access explanations, user
   search, and that copy/download remain disabled until a user has a grant and
   the cluster reports ready.

Run the automated counterpart before the browser pass:

```bash
cd dashboard
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```
