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
```

Or copy the generated executable to a directory on `PATH`:

```bash
install -m 0755 apps/cli/dist/magicstick.js ~/.local/bin/magicstick
magicstick --help
```

The CLI uses `https://api.magicstick.local` by default. `magicstick login`
starts the Keycloak Device Authorization Flow, opens the verification page when
possible, and stores the resulting renewable session with file mode `0600`
below `$XDG_CONFIG_HOME/magicstick`, or `~/.config/magicstick` when that
variable is unset. It never accepts passwords as
ordinary command-line arguments. Set `MAGICSTICK_API_URL`,
`MAGICSTICK_ISSUER`, or `MAGICSTICK_CLIENT_ID` for a non-default appliance. For
non-persistent automation, `MAGICSTICK_ACCESS_TOKEN` supplies an existing
short-lived access token without writing it to disk.

The TUI is a read/monitor view with the same role-filtered areas as the browser:
Overview, Services, Models, Settings, Users, API Access, Kubernetes, and System.
Use arrow keys or `h`/`l` to change page, `r` to refresh, and `q` to quit. All
mutations are explicit CLI commands; run `magicstick --help` for the complete
surface and JSON payload commands.

The web app always calls relative `/api/*` paths. Vite proxies those paths to
`https://magicstick.local` during local development; set
`MAGICSTICK_API_PROXY` to use another test appliance. The production nginx image
proxies them to the existing in-cluster dashboard API.

`apps/web/src/FeatureParity.test.tsx` mirrors the current dashboard tab by tab.
CLI/TUI parsing, authentication, private session storage, rendering, and command
dispatch are covered below `apps/cli/src/*.test.ts`.

No Kubernetes token, OIDC client secret, provider credential, or user password
belongs in this workspace, frontend image, shell history, or committed fixture.
