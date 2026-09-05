# Magic Stick Dashboard Clients

This workspace contains the parallel React dashboard, the `magicstick` command
line client, its interactive terminal UI, and framework-neutral packages shared
by all three interfaces. The existing ConfigMap-rendered UI stays active while
the React frontend is evaluated at `https://dashboard2.magicstick.local/`.

```text
apps/web              React browser application and nginx image
apps/cli              standalone CLI and interactive TUI
packages/contracts    typed control-plane API contracts
packages/api-client   authenticated HTTP transport
packages/core         role, formatting, catalog, and selection rules
```

## Build and test

Node.js 24 and the pinned pnpm version are required.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

The build creates the browser bundle and the standalone executable
`apps/cli/dist/magicstick.js`. Run it through the workspace scripts:

```bash
pnpm cli --help
pnpm cli login
pnpm tui
pnpm cli console
```

Or copy the generated executable to a directory on `PATH`:

```bash
install -m 0755 apps/cli/dist/magicstick.js ~/.local/bin/magicstick
magicstick --help
```

### Offline terminal preview

To explore just the terminal frontend without an appliance, DNS, or login,
use Node.js 24+ and run from this directory:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @magicstick/dashboard-cli build
corepack pnpm tui:demo
```

The standalone equivalent is `magicstick tui --demo`. The preview shows all
eight tabs using synthetic sample data, clearly labeled **OFFLINE DEMO**.
Arrow keys (or `h/j/k/l`) navigate, `r` reloads the sample data, and `q` quits.
Live actions, clipboard exports, and sign-out are disabled. It never contacts
an API or login service, reads saved configuration or credentials, or changes
the local session. The sample catalog and resource values are not deployment
defaults. Omit `--demo` to use the normal authenticated appliance client.

The CLI uses `https://api.magicstick.local` by default. `magicstick login`
starts the Keycloak Device Authorization Flow, opens the verification page when
possible, and stores the resulting renewable session with file mode `0600`
below `$XDG_CONFIG_HOME/magicstick`, or `~/.config/magicstick` when that
variable is unset. It never accepts passwords as
ordinary command-line arguments. Set `MAGICSTICK_API_URL`,
`MAGICSTICK_ISSUER`, or `MAGICSTICK_CLIENT_ID` for a non-default appliance. For
non-persistent automation, `MAGICSTICK_ACCESS_TOKEN` supplies an existing
short-lived access token without writing it to disk.

The CLI includes the operating-system CA store. If the appliance CA is not
trusted there, use `--ca-file /path/to/magicstick-oidc-ca.crt` for the first
login; that public CA path is saved for later calls. On a disposable appliance
in a trusted test network, `--insecure` bypasses certificate verification only
for the current process, prints a warning, and is never persisted.

The TUI has the same role-filtered areas as the browser: Overview, Services,
Models, Settings, Users, API Access, Kubernetes, and System. Use left/right or
`h`/`l` to change page, up/down or `k`/`j` to select an item, `r` to refresh,
and `q` to quit. Operators can enable and disable catalog services and add or
remove local and external models. Administrators can additionally create,
edit, enable, disable, reset, and delete local users; create and revoke named
API keys; assign and revoke Kubernetes roles; and copy token-free kubeconfigs
through OSC 52 when the terminal supports it. Every destructive operation is
confirmed, passwords are masked, and a newly created API-key secret remains on
screen only until its result dialog is closed. The explicit CLI commands remain
available for scripts and complete JSON instance payloads.

`magicstick console` is the persistent appliance-monitor entry point. It checks
the cached SSO session, renders a Keycloak device-login code when authentication
is required, and opens the same interactive TUI. It never stores a password.
The host installer runs this mode automatically on virtual terminal 9 after the
first-run claim has been completed. Press `x` to remove the local session and
authorize another user.

The web app always calls relative `/api/*` paths. Vite proxies those paths to
`https://magicstick.local` during local development; set
`MAGICSTICK_API_PROXY` to use another test appliance. The production nginx image
proxies them to the existing in-cluster dashboard API.

`apps/web/src/FeatureParity.test.tsx` mirrors the current dashboard tab by tab.
CLI/TUI parsing, authentication, private session storage, rendering, and command
dispatch are covered below `apps/cli/src/*.test.ts`.

No Kubernetes token, OIDC client secret, provider credential, or user password
belongs in this workspace, frontend image, shell history, or committed fixture.
