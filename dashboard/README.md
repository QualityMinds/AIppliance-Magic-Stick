# Magic Stick Dashboard Workspace

This workspace contains the parallel React dashboard and framework-neutral code
that can later be reused by a terminal UI. The existing ConfigMap-rendered UI
stays active while this frontend is evaluated at
`https://dashboard2.magicstick.local/`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

The web app always calls relative `/api/*` paths. Vite proxies those paths to
`https://magicstick.local` during local development; set
`MAGICSTICK_API_PROXY` to use another test appliance. The production nginx image
proxies them to the existing in-cluster dashboard API.

`apps/web/src/FeatureParity.test.tsx` mirrors the current dashboard tab by tab.
It checks the important information and controls on Overview, Services, Models,
Settings, Users, API Access, Kubernetes Access, and System Status. Keep this
suite current whenever a feature is added to either frontend during the
migration; application-shell tests alone are not a parity check.

No Kubernetes token, OIDC client secret, or provider credential belongs in this
workspace or frontend image.
