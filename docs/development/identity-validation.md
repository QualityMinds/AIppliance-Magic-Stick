# Identity validation

## Run the Pilot

Wait until both Flux waves are ready:

```bash
kubectl -n flux-system get kustomizations envoy-gateway identity-pilot
kubectl -n envoy-gateway-system get helmrelease envoy-gateway
kubectl -n identity-system get pods,gateway,httproute,securitypolicy
```

Read the address of the generated Envoy service:

```bash
kubectl -n envoy-gateway-system get service \
  -l gateway.envoyproxy.io/owning-gateway-namespace=identity-system,gateway.envoyproxy.io/owning-gateway-name=identity-pilot \
  -o wide
```

Resolve the configured identity, pilot and dashboard names to the reported
LoadBalancer address with local DNS or temporary hosts-file entries. Replace
`<GATEWAY_IP>` and the example names below with your test environment's values:

```text
<GATEWAY_IP> id.example.local auth-pilot.example.local example.local
```

For a new installation, complete the physical-console claim flow described in
[first-run-setup.md](../installation/first-run-setup.md). There is no Kubernetes Secret that
contains the first administrator's password.

Open the configured auth-pilot URL. Verify the expected certificate/CA through an
independent trusted channel and install its public trust material in the isolated
test client. Do not use bypassed certificate validation as a passing trust test.
The request must redirect to Keycloak and return to the protected success page
after login. See [certificate handling](../administration/certificates.md).

Open the configured dashboard URL to validate the real dashboard route. After
login, the administrator created during first-run setup can use all dashboard
operations. `/logout` clears the Envoy browser session.

On a host-local K3s appliance, Gateway-aware kdns publishes the annotated local
routes automatically. Rancher Desktop keeps multicast inside its Linux VM; use
`magic-cluster/platform/basis/kdns/publish-rancher-desktop-mdns.sh` on macOS
while testing so the same accepted routes are published through the host mDNS
responder.

## Session policy and Remember me

Run the owning import/migration counterexamples first. The complete file also
requires the Flux CLI pinned by Public release checks (currently 2.9.2):

```sh
python3 -m unittest discover -s magic-cluster/platform/identity/tests -p test_remember_me.py
```

Phase 1 `smoke-fast` also selects that suite under AUTH-01's
`remember-me-policy-contract`. It rejects the old defaults, checks idempotency,
preserves custom policies, and covers missing bootstrap authority, read/write
failure, lost write acknowledgements and verified readback. It does not extend
the setup or Dashboard service accounts' realm permissions.

The in-Appliance selection runs `RememberMePolicyTests`, including the scoped
ConfigMap annotation contract, without adding a Flux CLI dependency to the
runner. Public release checks additionally discover `RememberMeFluxBuildTests`.
Those tests run the actual identity graph through `flux build kustomization`
with `--dry-run --strict-substitute`: the mounted migration script must remain
byte-for-byte unchanged, while the other identity host variables are replaced.
Removing the script ConfigMap's `kustomize.toolkit.fluxcd.io/substitute: disabled`
annotation must reproduce the missing `before` variable error. A missing variable
in another ConfigMap must still fail; do not disable strict substitution globally.
These are isolated deployment-contract checks, not installed login acceptance.

On a developer/CI host with Docker, Python with PyYAML, the locked Dashboard
workspace and Playwright Chromium installed, run the explicit protocol profile:

```sh
cd dashboard
REGRESSION_MODE=auth-sessions pnpm --filter @magicstick/dashboard-web exec playwright test \
  --config regression/playwright.config.ts --reporter=line
```

This starts isolated Keycloak 26.6.3 and Envoy Proxy 1.38.7 containers, matching
the appliance versions. It imports the real policy with synthetic credentials,
runs the real migration/CLI, and shortens session limits only inside that
disposable realm. Chromium checks normal idle expiry, remembered access after a
real browser restart and inactivity, refresh without another login, both absolute
maximum lifetimes despite activity, and logout followed by rejected old session data.
An idle probe accounts for Keycloak's possible two-minute grace window; normal
maximum remains later, so maximum expiry cannot masquerade as idle expiry.

The stack binds only to loopback and uses HTTP with synthetic identities; it is
not TLS/certificate acceptance and does not alter appliance TLS policy. No lab
profile, Docker socket mount, host network or privileged container is used.
Only the randomly named owned containers/network and private temporary files
are removed. Raw cookies, tokens and credentials are not reported. The
`identity-sessions` browser CI job runs this separate gate. Installed Kubernetes
phases do not launch Docker or claim this local B/protocol evidence as installed
A/E acceptance.

For installed acceptance, wait for any regression run/maintenance to finish,
verify the migration result and unchanged normal limits, then **sign out and
sign in again with Remember me**. Confirm a later return and browser restart do
not prompt prematurely; explicit logout must return to login. Do not use an older
login as acceptance evidence: its cookies may retain the former expiry.
Preserve custom settings; investigate a migration
error in Keycloak's startup logs rather than granting `manage-realm` to a
Dashboard service account or bypassing authentication.
