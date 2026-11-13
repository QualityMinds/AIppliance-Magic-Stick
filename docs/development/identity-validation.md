# Identity validation

## Isolated multi-host HTTPS session check

After installing the locked Dashboard dependencies, run
`bash magic-cluster/platform/identity/tests/test_multihost_browser.sh` on a
Docker-enabled host. This uses synthetic credentials and a temporary Linux
Chromium NSS trust database. It first checks that an untrusted synthetic CA is
rejected, then imports that CA only into the disposable browser container.
The pinned Keycloak and Envoy images and the actual Dashboard API guard exercise
login across distinct HTTPS hosts, host-only token cookies and cross-host logout.
It also checks that a service configured like LiteLLM preserves its own
synthetic Authorization header while the guard checks the gateway session.
An actual Envoy ext_proc filter calls the product gRPC callback gate before
OAuth; a **synthetic** readiness service supplies stale, additive and ready
decisions. The browser checks fail-closed behavior on stale status and a stopped
processor, then verifies recovery after a processor restart. These checks do not
validate the real Identity service's callback status or its Kubernetes reads.
The fixture uses handwritten Envoy filter configuration: it does **not** validate
Envoy Gateway controller translation, actual Gateway API policy acceptance,
real appliance routing or live hardware. Those remain separate acceptance gates.

On 13 November 2026 this isolated profile passed with its synthetic readiness
service and verified container/network cleanup. This is not an installed-system
acceptance result.

The public release checks also run `test_callback_keycloak_load_runtime.py`
against a disposable, pinned Keycloak. It exercises the actual Identity
readiness and singleflight functions with synthetic Kubernetes objects: 64
same-host requests coalesce; 64 distinct occupied checks cause a 65th to return
503, which recovers to 204 after release. A controlled barrier creates the
overload; this is not an appliance throughput or latency benchmark.

The callback gate's Envoy Backend carries its CA reference, SNI and TLS
settings in the Backend itself, rather than relying on an optional attached
policy. Enabling this Gateway extension increases the cluster-wide attack
surface. The intended admission guard permits only the immutable callback
Backend and rejects separate Backend TLS overrides; the Gateway Flux wave
depends on the guard wave. The Setup and operator identities receive no Backend
write permission. Manifest ordering and `Ready` alone do not prove that
admission is active: a fresh install or upgrade must also verify an actual deny
canary and the live controller's translated TLS/SAN behavior before enabling
or trusting the feature. This native bootstrap barrier remains an acceptance
requirement and is not established by the unit tests or the Envoy-only fixture.
The initial Helm value is disabled. After the controller CRDs exist, a restricted
bootstrap Job checks compiled policy/binding revisions and submits real dry-run
deny canaries. RBAC, schema and transport failures do not qualify as admission
proof. Only a successful, unchanged-revision proof enables the watched Helm
values override. Identity waits for that Job; failed verification leaves the
extension disabled. The probe has no Secret permissions or workload controls.

The HTTPS Gateway has both a callback-gate fallback and an independent
default-deny SecurityPolicy. Losing a route's gate still invokes the Gateway
gate; losing its authentication policy denies access. Admission prohibits
removing the baselines, empty/unsafe overrides, skipped request headers and
moving callback processing after OAuth. New identity routes require both
baseline resources through admission parameters. Native identity login and the
exact Mesh enrollment route have explicit native-auth exceptions; a public
AppInstance retains its UID-bound API guard. Cluster administration and the
GitOps controller remain trusted: these rules do not protect against an
administrator removing admission itself.

`Public release checks / gateway-security` creates its own disposable Kind
cluster and runs `tests/gateway_policy_contract.py` with an explicit kubeconfig
and identity check. It verifies actual TLS/gRPC Gateway translation, policy
deletion fallback, rejected unsafe overrides, pre-OAuth ordering and recovery.
It uses a synthetic readiness service and backend, not human credentials or
appliance data. This is separate from the real Keycloak multi-host browser test
and installed-server acceptance. The caller always removes only its own cluster.

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

## Hostname and callback reconciliation

The setup reconciler derives an exact callback set from configured hosts and
UID-validated instance intent. The operator waits for a fresh matching
readback acknowledgement before advertising a protected instance route as
ready. The startup hook verifies a bounded snapshot or the exact bootstrap
set; callback or origin wildcards are not accepted. Keycloak client updates
must not run while secret rotation metadata is present, since Keycloak removes
rotation metadata on a client PUT. An already matching configuration needs no
write. Native multi-host and static-route readiness checks remain separate
acceptance gates; neither a rendered manifest nor this contract is proof of a
working installation.

Run the owning callback and whole-startup counterexamples:

```sh
python3 -m unittest discover -s magic-cluster/platform/identity/tests -p test_callback_policy.py
```

These tests execute the mounted shell helper and actual deployment hook with a
synthetic CLI. They cover renamed hosts, replacement of old callback sets,
idempotency, native set ordering/deduplication, preserved client state, denied
or failed writes, changed identity, stale readback and malformed projections.
They also require the hook to wait for completion, propagate all client-helper
failures and return nonzero on exhaustion. The protected ConfigMap must preserve
both shell scripts byte-for-byte through strict Flux substitution; the full
identity suite includes that build check. Public release checks discovers these
owning tests. No new installed campaign registration is implied.

The same suite executes the real user-administration and federation helper
bodies, not only hook stubs. An already correct direct role set must succeed
even when redundant role writes are refused. Missing/extra roles exercise only
their differences in synthetic state; denied changes, failed reads and stale
readback fail. These fixtures do not prove a particular native write returned
403 and do not authorize a manual role assignment on an appliance.

For authorized native acceptance, first confirm idle state and the installed
Git/Flux revision. After regular convergence, confirm the new Keycloak Pod is
Ready and read only the existing human gateway client's identity, redirect URIs
and web origins using its scoped administration path. They must match the
configured hosts; readiness alone does not certify the browser workflow. Use
the trusted appliance CA for protocol requests: the current dashboard callback
must reach the login form, while an unrelated host must still be rejected.
Finally open a fresh dashboard URL and complete human login. Never publish
authorization state, credentials or full client exports. A certificate warning
requires independently verified trust, not a validation bypass.

The foreground hook avoids `/proc/1/fd` redirection, which can be denied for
stacked AppArmor exec labels. Do not broaden ptrace policy, add callback host
wildcards, reset the database or grant new service-account roles as a workaround.
Synthetic checks are not physical installation or authenticated native login
acceptance; record each result separately.

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
