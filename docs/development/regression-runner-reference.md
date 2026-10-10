# Regression runner reference and historical setup

For normal operation, use the [short regression guide](regression-remaining-p0.md).
The interactive approval/proposal workflow below is the **legacy `setup --manual`
reference**, not the normal `setup` or `all` path. Dated acceptance evidence remains
historical; it does not certify the new automatic runner.

This guide extends the [regression concept](regression-test-concept.md) and
[stable case catalog](regression-test-catalog.md). Implementation and acceptance
are separate: adding these tests does **not** record live acceptance. Installation
tests and P1 cases remain outside these profiles. The user runs the live suite
and supplies its results; development uses short local checks instead of hours
of unattended appliance tests and downloads.

## Automatic lock lifecycle and interrupted-run recovery

On the registered disposable appliance, the runner renews its Lease every
15 seconds independently of model/status/browser waits. Lease operations are
serialized to prevent competing renewal/maintenance CAS writes. A reserved
physical outage suspends network renewal, but retains the bounded local expiry
fence. Losing ownership permanently prevents new mutations.

UI mutation waits use the configured request timeout (normally 15 seconds),
not the enclosing hour-long test timeout. A cancelled page proves a write was
not submitted only when its guarded route never forwarded it. Lost responses
after submission remain ambiguous. Normal interruption forwards the signal and
allows two minutes for teardown; cleanup itself has a ten-minute ceiling and
attempts independently owned resources even if a borrowed-setting restore fails.

The next `all` refresh uses the same persistent private run directory. It checks
the server marker, expired Lease plus a 60-second drain, parent liveness or a
completed legacy report, exact root/worker journals and every UID/generation.
Phase-2 auxiliary model journals are included only when their filename, recorded
owner and target agree inside that exact run directory.
Setup operations and separate lock contenders also persist their exact Lease
owner before acquisition, including when the acquisition reply is lost.
Only the recovery CAS winner may delete known model/app/key/user resources or
restore the recorded optional-module/GPU-sharing baseline. A pending request
is cleared only after independent absence or exact unchanged-state proof.
Private `automatic-recovery.json` records the result separately from historical
test reports. Fresh scoped credentials are used; no administrator deletion fallback.

An active runner, missing evidence, changed resource identity/revision or an
unsupported unfinished license/federation/physical transaction stays Blocked.
Do not erase journals or manually clear the Lease to bypass those differences.
The isolated heartbeat/deadline/recovery tests and the no-resource live Lease
drill are selected by `selftest`, fixture profiles and `locktest` respectively.
These targeted checks do not establish full campaign acceptance.

After a new live cleanup fence, a phase attempts one `campaign-recover` child.
It requires the original child to be finished, waits for real Lease expiry plus
the drain window and never edits `renewTime` to force acquisition. Proven
restoration clears only the current live-write fence, not historical failures.
If teardown already released the Lease, every durable journal must be restored
and independent resource absence must still be proved. Ambiguous ownership or
unfinished unsupported transactions keep subsequent live writes Blocked;
independent isolated tests continue. The report records the recovery attempt.

## JUnit steps and portable report archives

`junit.xml` contains three deliberately separate suites:

- `magicstick-selected-regression`: case × variant × layer evidence.
- `magicstick-executable-scenarios`: one result per executed Playwright scenario.
- `magicstick-test-steps`: observed nested steps, outcomes, durations and safe
  source locations; `parentStep` preserves nesting.

JUnit properties and `system-out` reference filtered trace JSON by relative path;
the conventional `[[ATTACHMENT|…]]` marker helps consumers that support it. JUnit
has no universal attachment format, so unsupported CI viewers can use the
property/path or open `summary.html`. Step counts are diagnostics, not additional
catalogue acceptance or a replacement for the scenario/evidence counts.

Each canonical phase, `all`, `selftest` and `phaseN-fast` / `phaseN-fixtures`
produces `report-artifacts.tar.gz`, including after a failed isolated check. It includes
only summaries, JUnit, its manifest and re-validated trace/component attachments.
The aggregate copies child attachments into its own archive, so extracting one
archive is sufficient; sibling private run directories are not required.

Filtered traces retain literal source-reviewed `test.step` labels, generic
browser-operation labels, outcome, duration, allowlisted reason/stage and source
line. Expected negative assertions that are handled by a passing scenario are
marked `handledError`, not a failing scenario. Each trace has a 2,000-step limit;
any excess is explicitly counted as `omittedSteps`, never advertised as complete.
Component failures retain the source-literal assertion name, original index,
category and source line when available, not the expected/received values.

Raw Playwright tracing, video and screenshots remain off. These JSON traces do
**not** work in the native Playwright trace viewer. Selectors, input values,
URLs, headers, response bodies, auth storage, journals, backups and browser-temp
files are never added to the archive. Files remain private (0600, directories
0700); review before publishing. CI should archive this generated file only,
never recursively upload `.regression/private` or `.regression/inputs`.

## Automatic private input preparation (Phases 0–8)

You no longer need to recreate JSON files before each run. The input assistant
reuses accepted credentials, model fixtures, application adapters and budgets.
Only external prerequisites that cannot safely be discovered need one-time
provisioning. Preparation is not a test run and never records `Passed` evidence.

### Runner image

The local runner uses digest-pinned, multi-platform `node:24-bookworm-slim` and
`golang:1.26.5-alpine3.24` bases. Playwright installs only the exact Chromium
headless shell and FFmpeg versions resolved by the frozen workspace lockfile.
The registered workflows launch headless Chromium; a future headed or other
browser workflow must explicitly extend the image installation.

BuildKit bind mounts provide the `.dockerignore`-filtered source, the existing AMD
patch and the compiled native recovery test. All selected source directories,
runtime dependencies, browser and built web bundle enter one runtime `RUN`
layer. Download/install caches are removed before that layer is committed.
The native binary remains built for `TARGETARCH` with `CGO_ENABLED=0`, the same
upstream revision and the existing patch; no native test is replaced by a mock.
The non-root, read-only Compose runner and its private mounts are unchanged.

Registry measurements on **2026-10-10**, for the pinned `linux/amd64` manifests:

| Base download | Previous base | Current base |
|---|---|---|
| Runner | Playwright Resolute: 956.11 MiB | Node Bookworm Slim: 77.08 MiB |
| Native-test builder | Go Bookworm: 283.03 MiB | Go Alpine: 68.07 MiB |

These are compressed base-layer download totals, not final runner sizes or peak
disk-space requirements. The current runner adds its selected browser and
dependencies. The previous runtime's 20 `COPY` instructions and three `RUN`
instructions become no `COPY` and one `RUN`; fewer committed filesystem layers
reduce the full-layer copies made by `vfs`. Actual build failures still come
directly from Docker; the launcher imposes no guessed disk-capacity threshold.

The `regression-image` job in
[Regression runner](../../.github/workflows/regression-runner.yml)
builds the actual runner on GitHub's `ubuntu-24.04` runner for relevant pushes
and pull requests. It then runs typecheck, harness selftests, Phase 4/8 fast
contracts (including native AMD recovery tests), and Phase 2/7 Chromium fixtures
inside the newly built, non-root, read-only Compose container. No lab setup or
appliance credentials are supplied. Only allowlisted report archives are uploaded.
The job also records actual image size and filesystem-layer count.

Use this CI job to verify a development image build instead of repeating the
Docker build in the agent workspace. The local `build` command remains available
for one-time lab setup. Verify the CI result against the exact source commit;
ordinary dashboard/CLI/API image builds do not validate the runner Dockerfile.

### 1. One-time setup

From the repository root:

```bash
bash tools/regression.sh build
bash tools/regression.sh setup
```

The normal wizard starts with **Dashboard HTTPS URL, admin username and hidden
password**. It follows verified login redirects to discover Identity, logs in
through the existing Keycloak browser flow, then reads the shared Dashboard APIs
to discover Inference and Kubernetes endpoints and the exact enabled account.
There is no need to download or author the three test kubeconfigs yourself.
This path uses the already-built Linux runner and a host `kubectl`; it does not
build, pull, publish or run a regression suite implicitly. Rebuild once after
updating the setup implementation. Saved credentials are reused without passwords
in arguments, environment variables, traces or reports.

The complete wizard then asks for phases (default **0–8**), typed confirmation of
the exact test Appliance UID and separate warned approvals. It covers every
selected phase's inputs, saving answers in private files instead of requiring you
to author JSON. Blank keeps a saved/default value; `SKIP` explicitly leaves an
optional section incomplete. Refusals stay refusals on repeated setup. Saved
approvals can be reused only after confirmation on the same Appliance/Node IDs.

After approval it can prepare a disabled optional-module intent and stop exactly
the discovered active local model UIDs/revisions. Definitions and model cache
remain; those models stay stopped for the regression baseline. It does not cancel
an existing host operation or steal a Lease. Interrupted writes leave private
receipts; rerun setup to review/reconcile them, never delete receipts to bypass a
conflict. No license is activated during setup.

At the end, setup automatically discovers technical inputs and prints each
phase's `Missing`/`Action` list. Type `ACCEPT` to accept the freshly rechecked
proposal. `SETUP READY` means all selected **inputs** are ready, not that tests
passed. Missing prerequisites produce `SETUP INCOMPLETE` and exit code 2, with
the runnable subset shown. Declining acceptance preserves existing accepted pins.

```bash
# After the complete setup has accepted all selected prerequisites:
bash tools/regression.sh all
# Or deliberately select a smaller complete campaign:
bash tools/regression.sh all --phases 0-4
```

`all` runs complete phase profiles sequentially and stops at the first failed or
blocked phase; it never continues destructive actions after failed recovery.
Its private `all-summary.txt` links the per-phase run IDs. To refresh only access
without the suite questions/acceptance, use `setup --minimal`. `setup --manual`
remains the advanced externally provisioned path.

The assistant downloads the selected account's **token-free OIDC kubeconfig**
through the existing Kubernetes Access API. The existing Kubernetes public client
uses authorization code + PKCE S256, reusing the Dashboard SSO login. The ID token
is verified against the configured realm's signing key, subject, audience, nonce,
short lifetime and Kubernetes admin group. A Dashboard/CLI access token is not
substituted, and no password grant or credential-plugin command is executed.
Automatic token validation supports the shipped Keycloak realm's RS256 signing
algorithm. A customized issuer, signing algorithm or callback configuration must
use the advanced manual path rather than bypassing validation.

If this Dashboard administrator does not have Kubernetes admin access yet, type
`GRANT` to approve a **temporary change to this exact account only**. The API signs
out its existing sessions. Setup logs in again and restores the previous access
level before making the transient bootstrap token available. Without approval,
setup stops without changing access. Protected accounts or an unavailable OIDC
integration cannot be bypassed. An interrupted grant is recorded privately;
ordinary test and preparation commands remain blocked until recovery:

```bash
bash tools/regression.sh setup --restore-kubernetes-access
```

Recovery checks the same account, appliance and endpoints, restores only its
recorded prior level, and does not apply lab manifests or change accepted pins.
An intervening different access level is a conflict requiring manual review.
After recovery, rerun ordinary setup. The existing API has no access-level CAS
revision, so do not concurrently edit this account's Kubernetes access during setup.

Setup cross-checks the Dashboard Appliance UID against Kubernetes, writes the
repository's reviewed `bootstrap-rbac.yaml`, and asks you to type the intended UID
before server-side dry run/application. It then generates separate short-lived
observer, Lease-locker, model-cleaner and app-cleaner kubeconfigs automatically.
They are mode-0600 files in the mode-0700 private inputs directory. The transient
administrator kubeconfig is removed on success, failure or normal interruption;
it is never retained as a runner fallback. If the host is forcibly killed before
cleanup, normal tests refuse to mount the retained bootstrap file: rerun setup.

The downloaded administrator OIDC kubeconfig is **not** an observer, locker or
cleaner credential. Do not import it for those roles. Use the opted-in bootstrap
to create distinct scoped service-account credentials; the runner
still verifies their actual live Kubernetes permissions before product actions.

Import the CA from a trusted source and compare its printed SHA-256 fingerprint.
Do not use an automatically downloaded, unverified certificate as trust. A blank
CA is only for a public WebPKI certificate, not an HTTPS-error bypass. Setup
does not alter the Mac's system trust store. Preparation validates CA validity
and imports it into a temporary runner browser trust store.
For `.local` names, setup first looks for a **public certificate already present
in the Mac keychain which verifies the Dashboard**. Approve its fingerprint with
`TRUST` before it is copied into private runner trust. If none is available, select
the trusted Appliance CA PEM once. An unverified certificate fetched from the
server is never trusted automatically; credentials are not sent before verified
HTTPS login discovery. A Mac browser's trust does not automatically transfer
into Docker. Public WebPKI certificates do not need a private CA import.

The manual no-Docker wizard remains available for advanced environments with
externally provisioned test roles:

```bash
bash tools/regression.sh setup --manual
```

It asks for all three origins and the separate credential paths. The explicit
selected-context bootstrap and CA-import options below also use this manual path.

If you downloaded an OIDC kubeconfig from **Kubernetes Access**, its public
identity CA can be extracted without manually creating a PEM file:

```bash
bash tools/regression.sh setup --ca-kubeconfig /path/to/private-lab-admin.kubeconfig
```

Only `kubectl config view` is used for this extraction: no credential plugin is
executed and no cluster connection or Secret read occurs. The OIDC issuer must
match the selected Identity origin. Verify the printed CA fingerprint against a
trusted source and type `TRUST` to import it. The Kubernetes **cluster** CA is not
substituted: it is a different certificate authority. This option does not turn
the downloaded admin file into a test-role credential.

For `.local` names, setup can resolve addresses on the Mac and write private
`compose.override.yaml` mappings for **setup, preparation and test** services. The wrapper uses
that file by default. Explicit `REGRESSION_COMPOSE_OVERRIDE` wins; it must cover
`setup-api`, `prepare` and `regression`. Rerun setup after an address change, or use
`--no-host-mapping` for externally managed DNS. TLS hostname checks and target
identity checks remain mandatory.
For approved per-instance application routes under this Appliance's `.local`
domain, setup can also write `browser-dns.json`. Chromium resolves only those
reviewed suffixes to the current lab IP; TLS/SNI and HTTP origins are unchanged.
Peer and controlled-IdP `.local` origins are included in private container
hostname mappings. No public DNS, Mac trust store or Docker daemon is modified.

As an advanced alternative to automatic API acquisition, bootstrap with a selected
administrator kubeconfig:

```bash
bash tools/regression.sh setup --provision-rbac --bootstrap-kubeconfig /path/to/private-lab-admin.kubeconfig
```

If no trusted PEM is configured, this command also offers to extract the public
identity CA from that selected downloaded kubeconfig, with the same explicit
fingerprint review. Leave the PEM-path prompt blank, accept the extraction offer,
then confirm `TRUST` only after verification. A host/root kubeconfig without an
OIDC issuer CA needs a separately obtained trusted PEM instead. OIDC bootstrap
authentication uses the Mac's installed `kubectl oidc-login` plugin; normal Linux
tests use the generated static scoped credentials, not that admin plugin.

Only an explicitly approved setup step uses an administrator context. It shows
the Appliance UID and saves `bootstrap-rbac.yaml` for review. Type the intended
UID to approve server-side dry run/application of the repository's lab grants:
read-only observer, one pre-created Lease, separate model/app intent cleaners.
It issues bounded 24-hour service-account tokens (the API server can shorten
their lifetime), records expiry metadata, and retains **no** administrator
kubeconfig or ambient-context fallback. Existing busy/foreign Leases are refused;
an existing idle matching Lease is left untouched. No product workload, model,
Secret or host operation is created by this RBAC-only step. Expired credentials require an explicitly
approved rerun, not hidden elevation during a test.

`--api-restart` additionally provisions the separate API-Pod restarter for the
license-persistence scenario. This is a distinct privilege; merely importing
licenses does not grant or approve an API restart.

Ordinary complete `setup` includes the five actual application UI adapters,
alternate AMD profile, optional module, OIDC/SAML form, peer import, advertised
Realtime fixtures, repetition budgets and destructive host recipes. The legacy
`--advanced` form remains available with the minimal/manual path.

It offers a pinned [kubelogin v1.36.4](https://github.com/int128/kubelogin/releases/tag/v1.36.4)
Linux download for the detected runner architecture, verifies the upstream archive
checksum and ELF architecture, and asks you to trust the resulting executable
SHA-256. You can instead import an already reviewed Linux binary.

With explicit license approval, setup generates a private disposable Ed25519 test
issuer and valid/expired/wrong-installation/tampered files bound to this installation.
Only its **public** key is added, after a separate UID/fingerprint warning, to the
optional local `magicstick-license-trust` ConfigMap. Official keys and other local
keys remain unchanged. No production signing key is requested. The private test
key stays mode 0600 in this lab; remove its public trust entry when retiring the
lab. You can instead supply externally signed fixtures.

The approved no-license baseline has a separate `license-resetter.kubeconfig`:
GET/PATCH of **only** `identity-system/Secret/magicstick-license`. Tests CAS-check
UID/resourceVersion/data, temporarily remove only `license.json`, and restore
the original bytes before activation/federation cases. They cannot delete Secrets
or modify installation identity/issuer trust. Observers retain no Secret access.
First activation is still separately approved and retained to support subsequent
federation tests. A short-lived license is minted just before expiry proof, not
hours earlier in setup.

### 2. Generate a proposal automatically

After building the updated runner once:

```bash
bash tools/regression.sh prepare --phases 0-8
```

`prepare` uses verified HTTPS, the existing real administrator SSO login and the
verified read-only observer. It reads Appliance/Node UIDs, current boot IDs,
host/kernel state, capability catalogs, GPU PCI identities, RAM/VRAM inventory,
the Ready Flux revision and independently observed Ready web/API image digests.
Existing critical image selections stay selected. Initial small CPU model
fixtures come from the advertised model preset catalog; reviewed model URLs,
memory budgets, context and discovery choices are retained on later runs.
Preparation checks current paged model discovery/artifact metadata and submits
only exact CPU-fixture requests to the existing **read-only** memory estimator
(`POST /api/models/estimate-memory`, no persisted intent). Initial CPU defaults
are rounded up to its recommended budget; existing reviewed budgets are retained
and flagged if invalid. Missing RAM telemetry/metadata is a blocker, not an
inferred unlimited capacity. Backend-advertised availability is not proof of
successful inference. No model download is performed by preparation.

For Phases 7/8 it also searches the fixed repository's GitHub workflows for fresh,
successful native-companion/security/publication runs at the **exact installed
commit**, with the required jobs/artifact names. A private `tokenFile` in an
existing profile may supply read-only GitHub access. API/network failures remain
missing prerequisites; old or other-commit CI success is not substituted.
Actual artifact/protocol verification still belongs to the tests.

No model, key, module, user, license, sharing setting or host operation is changed.
The separate preparation service can write **only private input files**. Normal
test services continue to mount `/inputs` read-only. The command creates:

```text
.regression/inputs/prepared/<proposal-id>/
  lab.json                 candidate identity/version/model pins
  remaining-p0.json        reused/generated domain prerequisites
  inventory.json           allowlisted private hardware/version inventory
  plan.json                pin-change groups, integrity checks and prerequisites
  readiness.txt            per-phase blockers, missing prerequisites, actions and acceptance command
  host-drills.json          only for an explicitly requested supported drill
```

`InputsReady` means that the evaluated input prerequisites are present, not that
the phase passed. `Blocked` lists approvals, adapters or infrastructure still
needed; cases stay in the full denominator. Each blocker now prints **Missing**
reasons and concrete **Action** steps. An approval command appears only when that
particular consent is missing, is scoped to the phase/operation, and is labelled
as a proposal-only command to run after review. The same measures are saved in
`readiness.txt` and structured `plan.json`; none is executed automatically.
The mixed-GPU blocker distinguishes missing hardware/selection, sharing consent,
fixtures and unsupported/over-capacity memory settings.
Private inventories contain no raw
API responses, user lists, license documents, invitations, cookies or Secrets.
Accepted files are never overwritten by discovery alone.
`setup --minimal` only saves access details. `lab.json` is created when a successful
proposal is explicitly accepted; it is not created after failed TLS/discovery.
Until then, live phases and `preflight` stop with prepare/accept guidance rather
than an ambiguous private-file error. A printed `Container ... Created` line is
not a successful preflight result; check its exit code and report.

During execution, each selected test prints its catalogue goal, layer/environment
and progress before running, then its outcome and duration. Static scenario names
distinguish repeated IDs, and failures include a safe explanation. The saved
reports include the same catalogue goals; see
[console progress and report descriptions](regression-test-concept.md#console-progress-and-report-descriptions).
Rebuild the local runner image after changing its source or catalogue; an existing
image does not automatically include those changes.

### Resolve blocked prerequisites

A preparation blocker is not a failed regression. Local `phaseN-fast` and
`phaseN-fixtures` checks do not need this live infrastructure and can be run
separately. They do not remove missing live cases from full-phase acceptance.
Use the printed reasons rather than granting every scope at once:

| Phase | Measures for complete live prerequisites |
|---|---|
| 3, 4; also GPU-dependent 6–8 | Use a Ready managed node with one AMD and one NVIDIA GPU, advertised Ollama/vLLM fixtures and current physical VRAM/system-RAM telemetry. Review the GPU proposal and approve sharing transitions with `prepare --phases 3-4 --approve gpu` only if allowed. Approval alone cannot repair missing metrics, insufficient memory or unsupported hardware. |
| 5: applications/modules | Answer ordinary setup's five actual UI adapter questions; select an advertised disabled non-critical optional module and alternate AMD profile. Approved setup prepares/verifies the disabled intent and creates the separate app cleaner. Actual application controls still need review. |
| 5: users/Kubernetes | Approve disposable users/grants and the verified architecture-specific Linux plugin download, or select a reviewed binary. The wizard saves its checksum and the private typed configuration. |
| 5: licenses/API restart | Approve generated test issuer/local public trust, document-only no-file baseline, replacement and separate API restart. Scoped credentials and signed rejection files are created automatically. First activation retention remains a separate answer. |
| 5: federation/key probe | Answer the controlled external IdP, OIDC/SAML and hidden narrow-client questions. A real IdP must already exist. Generated test signing supports just-in-time expiry; the actual disposable unmanaged key can be generated/cleaned automatically during its test after approval. |
| 6: physical operations | Approve installation-bound destructive use and independent recovery, then answer typed recipes/outcomes for every host case. Fresh same-host boot/plan IDs are derived before each action. A complete bundle supports sequential Phase 6; real update/failure fixtures and NET-07 console intervention remain necessary. See [the physical campaign](#phase-6-one-physical-drill-at-a-time). |
| 7: Mesh/companion/Realtime | Select a real second appliance's prepared private input directory; setup imports its referenced credentials/CA. Choose an advertised one-GPU Omni profile and bounded budgets; both Realtime modes are generated. Exact-commit four-platform companion CI must really succeed. |
| 8: current security evidence | Complete successful exact-installed-commit dependency-security and public-release-checks CI runs (at most eight days old), then rerun preparation. Keep repeat-cycle/growth budgets reviewed; existing or another commit's run IDs are not proof. |

Commands in the table are suffixes of `bash tools/regression.sh`; scopes can be
combined only after reviewing each operation. Preparation creates a proposal,
not test execution or automatic fixture provisioning. Complete `setup` performs
the approved local provisioning and wraps this proposal/acceptance flow. Real
external IdP credentials, second-appliance hardware and successful CI artifacts
cannot be invented from only a Dashboard URL and admin password.

If a reason is already satisfied, rerun preparation after the fix so it observes
the current state; do not edit `readiness.txt`, replace CI IDs with older ones or
disable gates. Rebuild the local runner once to include updated diagnostics.

### 3. Review and accept, then run tests

Inspect the proposal's private files and compare changed source/image pins with
the intended deployment. Do not merely trust that the currently installed
version must be the desired version. The console prints pin-change **categories**,
not credentials, private endpoints or raw diagnostics.

```bash
bash tools/regression.sh prepare --accept <proposal-id>
bash tools/regression.sh preflight
# Then run the selected phase commands as before.
```

Acceptance expires after 15 minutes and rechecks the live Appliance/Node/boot,
Flux revision and image digests. Changed original inputs, moved versions/boots,
edited proposals, a busy Lease/host or unrelated active local models prevent
acceptance. It never pauses unrelated models or acquires/resets a Lease. Old
files are backed up privately in the proposal. An interrupted multi-file
acceptance leaves a marker that blocks live launches until the lab owner reviews
and restores the private backup; it cannot run a partly updated profile.

Repeated runs reuse these accepted inputs. A reboot or deployment change outside
an independently proved, approved host drill needs another `prepare`/review/accept,
not manual UID/boot/digest editing. Replacing
the Appliance or Node resets inherited domain-operation approvals; review them
again for the new installation.

### Explicit future-operation approvals

Preparation can enable only named scopes explicitly selected by the lab owner:

```bash
bash tools/regression.sh prepare --phases 3-5 --approve gpu,identity,kubernetes
```

| Scope | Future test operation it approves |
|---|---|
| `gpu` | Managed AMD/NVIDIA sharing transitions; matching devices and current memory telemetry are still required |
| `identity`, `kubernetes` | Disposable actors and grants to those actors |
| `modules`, `amd-profile` | Previously reviewed disabled optional module / advertised alternate AMD profile |
| `license`, `api-restart`, `first-license` | License replacement, separate API-Pod restart, or retention after first activation; independently selected |
| `federation` | Previously supplied controlled test IdP/provider fixtures |
| `mesh`, `realtime` | Previously supplied second-appliance / exclusive-and-shared runtime fixtures and transitions |

These flags generate consent in a proposal; they do **not** execute the operation.
Unknown scopes and blanket `all` approval are rejected. If prerequisites are
missing, enabling a scope does not invent or waive them. Signatures cannot be
generated without the real issuer, native binaries cannot be validated by a
Linux-only mock, and one appliance cannot become two Mesh peers.

Only the uncomplicated current-boot `BOOT-02` reboot plan can be generated:

```bash
bash tools/regression.sh prepare --phases 6 --drill BOOT-02 --approve reboot --independent-recovery
# Review/accept the returned proposal before separately running the drill.
```

This requires the current mixed-GPU profile and explicit independent console
recovery. It expects one observed reboot and unchanged kernel. Other maintenance,
network, firmware and software-channel outcomes require individually reviewed
plans; the assistant does not guess desired addresses, future kernels, failure
oracles or unknown future boot IDs. Phase 6 remains a controlled physical
campaign, not an automatically approved all-maintenance batch.

## Scope and commands

| Phase | Implemented P0 workflows |
|---|---|
| 5 | Optional modules and preserved AMD profile/sharing settings; five app types, catalog/context, credentials and ACLs; disposable users and role changes; real OIDC kubeconfig/PKCE/RBAC; license persistence/rejection; controlled OIDC/SAML federation/expiry; authorization, keys and log permissions |
| 6 | Host/preparation and memory controls; network drafts/apply/rollback; Ubuntu policy/install operations; software-channel preview/apply/recovery; cache protection/clearing/creation race; reboot/driver/CDI recovery |
| 7 | Two-appliance Mesh invitations, membership, model export/inference, limits/relay/revocation; native companion evidence for four platforms; advertised Omni configuration/admission, Gateway/LiteLLM Realtime authentication and lifecycle |
| 8 | Authorization/RBAC/hostile-input guards; dependency/secret/TLS checks with fresh CI evidence; dirty/unchanged/reverted controls; repeated CPU-model lifecycle with object, memory and non-cache disk budgets |

The executable denominator is
[`profiles/remaining-p0.ts`](../../dashboard/apps/web/regression/profiles/remaining-p0.ts).
It requires exact **ID + variant + layer + environment** tuples. Grouped owning
tests execute once and attach their individual catalog/layer annotations. A
browser fixture cannot replace actual inference, OIDC, physical maintenance or
multi-appliance proof.

From the repository root, run local checks first:

```bash
bash tools/regression.sh build
bash tools/regression.sh typecheck
bash tools/regression.sh phase5-fast
bash tools/regression.sh phase5-fixtures
bash tools/regression.sh phase6-fast
bash tools/regression.sh phase6-fixtures
bash tools/regression.sh phase7-fast
bash tools/regression.sh phase7-fixtures
bash tools/regression.sh phase8-fast
bash tools/regression.sh phase8-fixtures
```

These selections do not load private lab credentials or mutate an appliance.
Use a network-disabled Compose override for enforced offline isolation. The
Linux image contains the actual web bundle, Chromium, pinned language runtimes
and worker tests. It has no privileged mode, Docker socket, host project write
mount or published ports. A dirty build reports source revision `unknown`.

After reviewing every prerequisite for the selected phase:

```bash
bash tools/regression.sh preflight
bash tools/regression.sh phase5
bash tools/regression.sh phase7
bash tools/regression.sh phase8
```

Canonical commands run `selftest`, owning tests, browser fixtures, pinned
preflight, installed workflows and final pinned clean preflight, sequentially
and fail-fast, without retries. A `phaseN-live` diagnostic runs only the installed
portion and is **not** full acceptance. Phase 6 needs the separate physical-drill
procedure below; do not start an unreviewed all-maintenance batch.

## Private inputs and least privilege

Inputs live in `.regression/inputs` (`0700`) with files `0600`; only the OIDC
plugin binary is executable (`0700`). The container mounts them read-only at
`/inputs`. Reports live in `.regression/private/runs/reg-…`. Never commit these
directories, private addresses, tokens, credentials, licenses or raw diagnostics.

Keep the existing pinned `lab.json`: trusted CA, Appliance UID, node UID/boot ID,
Flux revision, critical image digests, read-only observer, pre-created `lab-lock`,
separate model-cleanup credential and the smallest reviewed CPU smoke model.
GPU scenarios need the private `gpu` profile and sharing-transition approval.
No admin kubeconfig is substituted when an observer check fails.

Use the assistant above for ordinary setup and reuse. The
[`remaining-profile.example.json`](../../dashboard/apps/web/regression/remaining-profile.example.json)
remains a schema/reference for advanced external adapters, not a file that must
be recreated every run. Approval switches are **off**. Existing advanced bundles
must replace every `CHANGEME`; missing prerequisites are **Blocked**, never Passed
or silently removed from the full denominator.

The [administration RBAC example](../../dashboard/apps/web/regression/lab-rbac-administration.example.yaml)
adds read-only Helm/Gateway/RBAC observation, GET of the generated non-secret
catalog ConfigMap, namespaced AppInstance cleanup and a separate API-Pod restarter.
Normal test/preparation runs never apply it. The explicitly selected setup
bootstrap can review/apply the lab grants once and issue separate credentials.
Cleanup is UID/resourceVersion-fenced; no Secret
reads, workload creation or cluster-admin authority are required by observers.

### Phase 5 prerequisites

- `identity.approveDisposableUsers`: creates only run-prefixed actors. Real
  sessions check user/viewer/operator/admin, reset/disable/enable, old-session
  demotion and self-disable protection. The recovery/last admin is never demoted.
- `applications`: all five advertised app types must install. Review each HTTPS
  hostname template, accessible prompt/send controls and response selector for
  its shipped UI. Supply the narrow app cleaner. Tests create owned apps and a
  small CPU model, invoke the actual app UI, inspect catalog/context propagation,
  test selected-user and explicitly public access, then remove owned instances.
- `modules`: select a non-critical optional module with a pre-created **disabled**
  intent and exact parameters. UI enable/Ready/API disable restores that intent;
  dashboard, identity, inference, GPU and Mesh are never optional fixtures.
  `moduleProfile` separately permits an advertised alternate AMD runtime profile
  on an idle managed intent to prove sharing settings survive the profile write.
- `kubernetes`: approve grants for the disposable user only. Supply the correct
  Linux-architecture `kubectl-oidc_login` at the exact private path plus SHA-256.
  Tests execute PKCE login, Pod reads and SelfSubjectAccessReview. Operator CRUD
  uses disabled owned intents, not arbitrary Pods. Export/copy must contain
  trusted CA and typed exec config, never a password/token. Revocation is checked
  with a **fresh** token, not a promise of immediate invalidation of old JWTs.
- `license`: installation-bound signed valid, expired, wrong-installation and
  tampered files, replacement approval and narrow API-Pod-restart permission.
  The original document is privately backed up and revision-fenced on restore.
  Setup can generate the files with a disposable locally trusted TEST issuer.
  The separate document-only no-file baseline grant supports repeatable LIC-01
  and SSO-01 even when a registration license already exists, restoring its bytes.
  First activation has no delete API; retention needs `allowFirstActivation`.
  Do not ship a production signing key with the runner.
- `federation`: a separate controlled HTTPS Keycloak IdP supplies OIDC and SAML
  metadata/claim mapping plus narrow upstream-user and broker-cleanup clients.
  Existing production IdPs are not borrowed. Expiry proof needs a fresh signed
  10-second-to-five-minute installation-bound license and the exact valid original
  restore file. With the generated signer, the short-lived document is created
  just before the expiry case; externally issued fixtures must be prepared near
  execution. Unknown claims must not elevate roles; after expiry fresh
  broker login disappears while fresh local-admin login continues to work.
- `unmanagedKey`: approve automatic one-hour disposable fixture creation/cleanup
  through LiteLLM's key-management endpoints, or select a real reviewed SHA-256
  key ID. Actual record existence/ownership is checked before and after the
  rejected Dashboard deletion. Raw master/key material stays in memory; only
  identifiers enter receipts. Never use another application's key.

<a id="phase-6-one-physical-drill-at-a-time"></a>

## Phase 6: reviewed destructive test recipes

Local draft/contract checks are ordinary tests. Physical operations require both
explicit disruption/recovery approval and a typed expected outcome for each case.
Complete setup asks these questions and writes a version-2 recipe bundle bound
to the exact Appliance/Node IDs. It does not save guessed future boot or plan IDs.
Each recipe is compiled from a fresh same-host report immediately before use.
The legacy one-case [host-drills.example.json](../../dashboard/apps/web/regression/host-drills.example.json)
remains supported for individually reviewed diagnostics; its approvals are off.

Pin current node UID/boot ID, advertised immutable plan/preview ID, typed settings,
expected terminal state/kernel/boot changes and applicable memory/IP/source/image/
cache outcomes. Channel changes require **all** critical digest pins and exact
checked commit. Plans contain data, not SSH, shell commands, package lists,
arbitrary paths or forced operation-state changes.

| Cases | Approved action and oracle |
|---|---|
| HOST-04/05 | Reviewed preparation, kernel/boot/terminal outcome and separately reviewed idempotency run |
| GPUHOST-05/06/07 | Dynamic-only real UI change or reviewed fixed/dynamic change; exact memory and expected one/two observed boots; mixed-node NVIDIA registration/inference |
| NET-05 | Real UI temporary apply and Keep after addresses/route/health observation |
| NET-06/07 | Withhold Keep; observe natural rollback. NET-07 requires an operator out-of-band console reboot during the pending window |
| UPD-05/07 | Typed install scope or policy; a real eligible update in a bounded near maintenance window for automatic reboot |
| CHANNEL-06/07/08 | Current ready preview, reviewed change, controlled failure or return to stable source; exact post-operation Flux/images |
| CACHE-04/06 | Approved inactive-cache clear and creation race; advertised cache IDs, protection and no premature model Pod |
| BOOT-02/03/04 | One approved reboot; control inference plus NVIDIA persistence/CDI and AMD DRA recovery where required |

After independently reviewing a BOOT-02 plan:

```bash
REGRESSION_HOST_DRILLS=approved bash tools/regression.sh phase6-drill BOOT-02
```

After complete setup has accepted all version-2 host recipes and recovery consent:

```bash
bash tools/regression.sh phase6
# Or as part of the selected full campaign:
bash tools/regression.sh all
```

Saved typed consent supplies the host-drill launch approval; no additional
environment switch is needed for that bundle. The implementation uses only normal
Dashboard host APIs and fresh advertised plans. No shell/SSH commands, forced
operation status or guessed package versions are accepted as recipe parameters.

The runner reserves its existing Lease for at most 35 minutes of expected outage,
never steals/revives an expired or replaced holder, persists its request and
observes the actual HostOperation/status/inference. Ambiguous writes or lost
authority leave private recovery evidence and block further writes. Recovery
through the local console is a lab-owner task, not a test bypass.

After a successful independently observed drill, `post-drill-lab.json` records
its proved boot/source/image changes. The sequential runner uses this private
continuation only if installation identities, endpoints, credentials, model
fixtures, budgets and approvals are unchanged. Accepted `/inputs/lab.json` remains
read-only. An unexplained reboot or changed physical identity still blocks.
Keep per-drill reports; manually combining unrelated runs is not full-phase
acceptance. NET-07 needs real console intervention, UPD-07 a real eligible update,
and channel failure cases a reviewed actual fault target. Recipe presence alone
is not evidence that these external conditions or their outcomes exist.

## Phase 7 prerequisites

`mesh` needs **two distinct, pinned and leased appliances**, Mesh installed but
no existing membership, shared verified CA trust and reachable enrollment origin.
A one-node simulation is not remote inference. Tests join through UI, reject
revoked/reused invites, export CPU/Ollama, NVIDIA/vLLM one at a time,
infer remotely without a second model Pod, change limits/relay, revoke/unshare
and clean only owned membership and models.

`companion` consumes fresh native four-platform matrix evidence from the fixed
repository's `build-mesh-companion.yml`. Pin the current installed commit and run
ID; optional read-only API credentials stay in a token file. Archive acceptance
JSON binds source/hash/platform and is retained 30 days. A Linux container does
not execute Windows/macOS binaries. Launcher/loopback/authority proof expressly
reports `meshInferenceVerified: false`; inference is the separate Mesh workflow.

`realtime` needs two entries shaped as
`{"mode":"exclusive|shared","maxModels":2,"fixture":{...}}`: one exclusive
and one admitted shared configuration. Use a current advertised Omni profile,
backend-compatible image, `engine: VLLM`, exact supported HF URL, pinned node,
context 256–4096 and `maxNumSeqs: 1`. Put Omni memory/offload fields under
`realtime`; do not reuse ordinary engine settings. Shared consumes one slot, not
two physical-device stages. Tests save/reload an edit, reject invalid admission,
observe placement/health/catalog, open authenticated Gateway/LiteLLM
`/v1/realtime`, deny absent/revoked keys and perform UI Restart/Stop/Start/Remove
while ordinary CPU inference still works. Multi-turn audio, microphone quality,
interrupt behavior and full OpenAI protocol parity are **P1/manual**, not P0.

## Phase 8 prerequisites and output

`securityCi` requires successful `dependency-security.yml` (`advisories`) and
`public-release-checks.yml` (`release-checks`) runs for the **exact installed
commit**, updated within eight days. The dependency workflow runs weekly and on
dependency changes; registry/network failure fails closed. It checks current
high/critical advisories; publication runs real redacted tree/history secret scans.
Offline tests prove known pins/guards, not a current vulnerability audit.

`repeat` defines 3–10 CPU lifecycle cycles and reviewed memory/non-cache disk
growth budgets. Cache growth is accounted separately. Intent/Pod/claim/route/key
UID sets must return to baseline. These are appliance observations, not
per-process heap-leak proof or GPU benchmarks. Warm the small model cache first.

UX proof needs both GPU controls, supported AMD memory and configured Mesh. It
does not save global drafts. Unchanged/reverted Save must be disabled; valid
changed Save must be enabled. Product violations must remain failed tests.

Inspect `summary.txt`, `summary.json`, `junit.xml` and `steps.json` under the run
directory. Only canonical runs with every exact tuple, no failed/blocked/skipped/
flaky result, clean journals and final pinned preflight can set the corresponding
`fullPhaseNAccepted`. Diagnostic subsets always leave it false. Share allowlisted
summaries only, not raw errors, snapshots, license backups, tokens or invitations.

## Local implementation check — 2026-10-05

The dirty source tree was built into a local Linux regression image and checked
in a network-disabled, read-only container, without lab inputs. Its recorded
source revision is `unknown`; these results do not certify a published commit,
an installed appliance, GPU inference or any physical drill.

| Selection | Local result |
|---|---|
| `typecheck` | Passed |
| `selftest` | Passed |
| `phase5-fast`, `phase6-fast`, `phase7-fast`, `phase8-fast` | Passed |
| `phase5-fixtures`, `phase6-fixtures`, `phase7-fixtures` | Passed |
| `phase8-fixtures` | Failed: `UX-02`, unchanged Domains form |

The registry test compares all **99 Phase 5–8 P0 cases** and their required layers
with the Markdown catalog. There are 321 domain evidence tuples, plus one final
clean-preflight tuple per canonical phase. This is an implementation denominator,
not 321 completed live checks; shared owning suites are annotated against the
cases whose contracts they exercise.

`UX-02` reproduces a product defect: **Save Domains is enabled before any edit**.
The shipped [Domains form](../../dashboard/apps/web/src/pages/SettingsPage.tsx)
only disables the button while a save is pending. The test requires unchanged
and reverted drafts to be disabled and deliberately remains red; this test task
does not silently change the product or weaken the assertion. Canonical Phase 8
therefore cannot pass until the product behavior is corrected.

Live acceptance for Phases 5–8 remains open. Phase 5 needs reviewed application,
identity and license fixtures; Phase 6 needs operator-approved physical drills;
Phase 7 needs the second appliance, native companion CI and admitted Realtime
fixtures; Phase 8 needs current security CI evidence and a warmed CPU smoke model.
No live test, commit, push, image publication or rollout was performed for this
implementation check.

### Follow-up: input assistant — 2026-10-05

The setup/proposal/review workflow described above was added after that historical
check. Targeted generator/wizard/launcher tests and TypeScript/syntax checks are
local implementation checks only. They do not replace that run, certify a rebuilt
Linux image, or record live acceptance of any phase. Building and executing the
updated suite remains the lab owner's next step.

## Experimental engine test scope

FreeToken has been removed from the product and active regression profiles.
The retired IDs remain documented for historical report interpretation; removal
and legacy-model cleanup are covered by the owning lifecycle suites.

For a bounded check of only the two classic vLLM GPU lifecycles:

```bash
bash tools/regression.sh phase3-gpu vllm-lifecycle
```

This diagnostic subset cannot accept the complete Phase 3 gate. Stop timeouts
save `stop-<model>.json` in the private run directory before cleanup, separating
disabled intent, remaining Pods and remaining generated catalog routes.

To investigate the classic NVIDIA paths independently of AMD:

```bash
bash tools/regression.sh phase3-gpu nvidia-lifecycle
```

Rebuild the local runner after changing its source (`bash tools/regression.sh
build`). Test-only changes do not require an appliance rollout.

This selects three separate Ollama executions and three separate vLLM executions.
Each creates a small run-owned model, verifies real inference and browser logs,
stops it, checks route/Pod removal and slot release, starts the same saved model,
infers again and removes only its own definition. These are repetitions, not
retries: a failed execution stays failed. AMD sharing remains unchanged; NVIDIA
sharing is temporarily exclusive and then restored to its original configuration.
Image/model caches are retained. The existing five-minute Stop deadline is not
increased and no Pod is force-deleted. Successful as well as failed Stop checks
record timing and bounded Pod/container identity in private `stop-<model>.json`
files, for correlation with host-runtime diagnostics. Six successful executions
are a targeted result, not complete Phase 3 acceptance.

### Targeted diagnostic — 2026-10-06

The updated, uncommitted regression source was checked against the installed lab
using only the AMD/NVIDIA vLLM lifecycle subset with small model fixtures. AMD
passed inference, logs, Stop and Start. NVIDIA passed inference and logs, but Stop
failed the existing five-minute deadline; its dependent Start checks were blocked.
The report contains **one passed and one failed executable scenario**, represented
by 20 passed, two failed and two dependent-blocked evidence rows. This is not a
complete Phase 3 acceptance or evidence of a published runner image.

NVIDIA's saved intent and catalog route were already disabled. The server process
exited successfully, but containerd logged TaskExit handling timeouts and a closed
shim connection while retaining stale running-container state. The terminating
Pod was eventually removed without a forced deletion. This remaining host-runtime
failure is not marked fixed and the Stop assertion was not relaxed. Run-owned
models and the API key were removed, the lab lock was released, and the original
AMD DRA/NVIDIA time-slicing settings were restored.

### NVIDIA lifecycle follow-up — 2026-10-07

The `nvidia-lifecycle` diagnostic was run against the dedicated lab with the
updated, uncommitted source mounted read-only into the local Linux runner. Its
source revision is `unknown`; this does not certify a published image or commit.
Run `reg-1afd9981-ba41-4cbe-9317-e646acef1b49` completed **six passed executable
scenarios** (three Ollama and three vLLM), represented by 72 passed evidence rows,
zero failures and zero blocked checks. Complete Phase 3 acceptance remains false.

Every execution verified GPU-bound inference, browser logs, Stop, Pod and catalog
withdrawal, slot release, Start of the same saved configuration, and inference
again. Stop completed in 16–60 seconds with the unchanged five-minute deadline;
no Pod was force-deleted. All six owned models and the test API key were removed,
the lab lock was released, AMD sharing stayed unchanged, and NVIDIA time-slicing
was restored to its original five slots. Existing model definitions were retained.

The earlier containerd failure did **not** recur. Historical host logs also show
the same CRI violation for a CPU-only AnythingLLM Pod during the earlier failure,
so it is not established as a NVIDIA-only fault. No driver or host-runtime fix
was applied, and the underlying intermittent failure is **not marked resolved**.
The added timing and Pod/container identifiers make a recurrence diagnosable
without weakening lifecycle assertions. The private run directory retains the
summary and bounded Stop diagnostics; it is not published with the documentation.
