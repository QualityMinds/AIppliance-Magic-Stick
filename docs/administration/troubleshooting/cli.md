# CLI and terminal troubleshooting

### CLI and terminal UI

The same workspace produces a standalone Node.js CLI/TUI bundle. Build it and
inspect its offline help without an appliance connection:

```bash
cd dashboard
pnpm build
pnpm cli --version
pnpm cli --help
```

For a frontend-only terminal preview with no backend or login, run
`corepack pnpm tui:demo` in the built dashboard workspace, or use the standalone
`magicstick tui --demo`. All eight tabs contain synthetic sample data and show
an **OFFLINE DEMO** banner. Navigation and sample-data refresh work; live
actions, clipboard exports, and sign-out are disabled. No saved configuration
or credentials are read, no network requests are made, and the local session
is left untouched. Press `q` to exit. See the
[CLI workspace instructions](../../../dashboard/README.md#offline-terminal-preview)
for a CLI-only build.

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
Run `pnpm cli logout` to remove it. The CLI includes the operating system trust
store. If the appliance-local CA is not installed there, export its public
certificate and run the first login with
`pnpm cli --ca-file /path/to/magicstick-oidc-ca.crt login`; the CLI saves the
path for later calls. `MAGICSTICK_CA_FILE` and `NODE_EXTRA_CA_CERTS` are also
supported. On a disposable appliance in a trusted test network, `--insecure`
disables TLS verification for the current process only, emits a warning, and
is not persisted. Do not use it for production access.

The primary command groups are `service`, `instance`, `model`, `settings`,
`user`, `api-key`, and `kubernetes-access`. Destructive and configuration
operations retain the API's viewer/operator/admin checks. Model and instance
creation accept a JSON payload with `--file`, allowing the same complete API
contract as the React forms without a second set of client-side reconciliation
rules. User passwords are accepted only through `--password-file` or
`--password-stdin`.

Inside `magicstick tui`, left/right or `h`/`l` changes tabs and up/down or
`k`/`j` selects a row. The footer lists only the actions available on the
current role and tab. `a` enables or creates, `d` disables, removes, or revokes,
and `e`/Enter opens user or Kubernetes access management. TUI forms use Tab or
Enter to advance, arrow keys to change a choice, Ctrl+S to submit, Ctrl+U to
clear the active value, and Escape to cancel. Password fields are masked.
New API-key values are displayed only in the completion dialog and can be
copied with `c`; Kubernetes kubeconfigs use `c` directly on the selected user.
Clipboard transfer uses OSC 52 and therefore depends on terminal support.

The seven-line borderless banner puts the **AIppliance** / **Magic Stick**
branding on the rounded USB spacecraft itself. There is no caption row.
More stars fill all seven background rows, including dim gray ones, while the
foreground artwork masks them. Most stay still; a small minority drift one
column every 24 seconds, with gentle twinkling.
Nacelles replace sharp fins; there are no flame effects. The connector
disappears inside the PC containing its graphics card, with no USB or GPU text labels.
The card has three large animated fans enclosed in a gray shroud and a finned
heatsink. Orange powered accents stay inside the case, with no external sparks.
The slightly wider, still compact case has a light-gray readout beside the fans:
**IDLE**, **SPIN**, or **READY**, artificial usage %, and **TPS** (tokens per
second). These slowly changing values are decorative in both live and demo
modes; use the dashboard's actual resource/status views for operational data.
Docking plays once at startup; the stick
stays inserted and the PC stays on, even after data refresh or terminal resize.
The connected pair is centered across the full terminal width. Gray/orange
easter eggs and a golden laptop recur in clear side stages on wide screens or
a lower lane on smaller screens. The laptop has an outlined screen, keyboard,
and touchpad, with a full open screen and base on wide terminals and a three-row
version on smaller ones. After startup, visits last about 18 seconds and
start roughly every two minutes, separated by long quiet gaps; no purple
accents are used. The subsequent boot-up and fan acceleration are decorative:
they do not report appliance power or status. Session information remains below
the banner, without a duplicate brand heading. Animation runs continuously,
including during dialogs, with no pause/resume control. Resizing below 19
terminal rows hides the banner but does not stop its clock; enlarging the
terminal restores its current frame. `--no-color` removes colors, not motion. Startup travel runs at
half speed, with only the banner rows redrawn at eight frames per second.
It makes no network requests and stops its timer when the TUI exits.

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
