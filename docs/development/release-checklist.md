# Release checklist

Select the sections relevant to the requested publication. An ordinary source
push or documentation update needs its affected checks and public-safety review,
not unrelated live GPU or full-distribution acceptance. For a public release tag
or distributed appliance, record the applicable artifact and live acceptance
evidence. The strict license review below remains explicitly opt-in.

## License checks and advisory review

- Run `python tools/license_audit.py --check` for source consistency and
  `python tools/license_audit.py --review` to report open license reviews.
  Public image/client workflows use this advisory mode: real source errors
  fail, but missing manual approvals do not stop unrelated builds or uploads.
  Secret scanning, tests, mandatory license files and digest checks stay strict.
- For a versioned distribution, record `LICENSE-RELEASE.json` with the exact version and actual first public
  distribution date. The Change Date is exactly three years later. Do not use
  a guessed date or reset it when repackaging. An `unreleased` record remains a
  visible warning in normal CI, not an automatic approval or date extension.
- Keep open items in `licenses/release-review.json` honest. When an item is
  reviewed, record its reviewer, date and evidence. Do not fabricate approval
  to obtain a green workflow. Referenced-only services, redistributed images
  and fully preinstalled appliances have different review scopes.
- Review [the component/license audit](license-audit.md), full per-platform
  SBOMs, upstream notices, source offers, copied-source rights and proprietary
  terms. A passing source scan is not legal clearance.
- For kdns, run `python -m unittest tests/test_license_kdns.py`. Its image recipe
  accepts the verified README MIT declaration when the upstream `LICENSE` is
  empty or missing. Confirm the supplied evidence and warning are preserved
  under `/usr/share/licenses/kdns/`; the complete notice remains a follow-up,
  not an automatic build veto. Missing both evidence sources must still fail.
- Run the **License audit** workflow manually for the release commit. Its weekly
  schedule checks the default branch, but does not approve a release. Inspect
  every matrix job and archive its SPDX/CycloneDX/Syft and review artifacts
  beyond the 30-day CI retention period. The final summary reports remaining
  items without a global veto. For an explicit full-distribution review, select
  `strict_release_review` on manual dispatch or run
  `python tools/license_audit.py --release`; this opt-in check requires every
  approval and a complete date record. No workflow approves legal compliance.

## Structure

- This repository contains only reusable template files, public-safe defaults,
  and render-only examples.
- Real deployment values come from installer metadata, runtime settings, runtime
  CRs, Kubernetes Secrets, or optional external overlays.
- New deployments do not edit public bases directly for local-only values.
- Public documentation links from `README.md` and `docs/README.md` stay current.
- `CONTRIBUTING.md`, `SUPPORT.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
  `GOVERNANCE.md`, `MAINTAINERS.md`, `CHANGELOG.md`, `ROADMAP.md`, and
  `THIRD_PARTY_NOTICES.md` reflect the current public release posture.
- `docs/index.html`, `docs/legal-notice.html`, and `docs/privacy.html` are
  present when GitHub Pages is published from `docs/`.
- CI release checks are present under `.github/workflows/`.
- Runtime images and chart versions avoid mutable tags such as `latest` where practical.
- For FreeToken, do not enable the module from the public `promotionState: pending`
  descriptor. Build, attest, and review the dedicated digest-promotion PR first;
  then confirm `data.image` is a `@sha256:` reference and
  `imageDigest`/`imageRevision` are populated.
- Dashboard source publication is not appliance rollout: after a successful
  client-image workflow, promote the matching Web and API image-index digests
  and verify Flux, both Deployments and the changed browser screen. Follow
  [dashboard image promotion](image-promotion.md#dashboard-image-promotion).

## Value Scan

Search the repository for values that must not be released:

```bash
rg -n "Q[M]-Worker1|quality[m]inds|ai-box-[0]1|github.com/Quality[M]inds|19[2]\\.|1[0]\\.|17[2]\\.(1[6-9]|2[0-9]|3[0-1])\\." .
rg -n "ghp_|github_pat_|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|AKIA|password:|token:|api[_-]?key" .
```

Expected findings should be placeholders, generated-secret annotations, Kubernetes secret references, or safe `example.*` values only.

## Build Checks

```bash
ANSIBLE_ROLES_PATH=magic-host/roles \
  ansible-playbook --syntax-check magic-host/playbooks/local.yml

python3 -m unittest discover -s magic-host/roles/gpu-compatibility/tests
python3 -m unittest discover -s magic-host/roles/host-management/tests

kubectl kustomize magic-cluster/flux/entrypoints/base
kubectl kustomize magic-cluster/flux/entrypoints/single-node
kubectl kustomize magic-cluster/apps/dashboard
kubectl kustomize magic-cluster/platform/magicstick-operator
kubectl kustomize magic-cluster/platform/basis
kubectl kustomize magic-cluster/platform/first-run-setup
kubectl kustomize magic-cluster/platform/gateway/envoy-gateway
kubectl kustomize magic-cluster/platform/identity
kubectl kustomize magic-cluster/platform/gpu
kubectl kustomize magic-cluster/platform/ai/kubeai
kubectl kustomize magic-cluster/platform/ai/hermes-operator
kubectl kustomize magic-cluster/platform/ai/openclaw-operator
kubectl kustomize magic-cluster/platform/ai/paperclip-operator
kubectl kustomize magic-cluster/platform/ai/agent-sandbox
kubectl kustomize magic-cluster/apps/ai/litellm/base
kubectl kustomize magic-cluster/apps/ai/model-catalog
kubectl kustomize magic-cluster/apps/ai/anything-llm/base
kubectl kustomize magic-cluster/apps/ai/kubeopencode
kubectl kustomize examples/demo/infra-cluster/flux-bootstrap
```

## License Foundation Checks

For the license foundation, also run:

```bash
python3 -m pip install -r dashboard/apps/api/requirements.txt pyyaml
python3 -m unittest discover -s dashboard/apps/api
python3 dashboard/apps/api/check_license_trust.py --manifest \
  magic-cluster/apps/dashboard/license-official-trust.yaml
```

Verify the official public-key fingerprints against the approved issuer record.
The official bundle must not be empty or contain temporary test keys. The
optional local trust store stays empty in the base and preserves runtime keys.
No private issuer key enters Git, a build context or the API image. The deployed
API tag must match the verifier that reads both mounted stores. The
opt-in [Rancher test](license-issuer.md#release) must use a dedicated
namespace and synthetic identities; it is not full SSO acceptance.

For targeted instance sharing, also run the explicit isolated
[real Keycloak/Envoy test](sharing-validation.md#verification), check current
`accessGuardReady` rollout semantics, and verify the one API image includes the
core package and required license notices. Confirm Resource Sharing and Mesh
work without a license and still deny unauthorized users/peers. Missing, invalid,
tampered and expired entitlements must disable Federated SSO while preserving
its configuration, local login and recovery. Verify Free Registered and Commercial
files and optional installation binding. All editions use the same image.

For dashboard-managed federation, run an isolated real-Keycloak OIDC and SAML
acceptance pass following [the federation contract](../administration/federated-sso.md#dashboard-managed-federation).
Verify create, login, exact role mapping, update, disable, deletion and license
expiry and an unavailable license API while a local recovery administrator
remains usable. Confirm the broker HTTPRoute/SecurityPolicy is accepted and
denies requests on verification outages. Cover OIDC, SAML and social/custom
provider IDs. Confirm that API,
browser, logs and support bundles contain no upstream client secret, that
normal edits leave unmanaged providers/mappers untouched, that license
enforcement only disables external providers without deleting their config,
and that the dedicated service
account has only `manage-identity-providers`, `view-identity-providers` and
`view-realm`.

Check [licensing](../../LICENSING.md), unchanged canonical BSL terms,
`BUSL-1.1` owned-source metadata, offline dashboard notices and image license files.
Run `python3 tools/license_audit.py --review` and inspect the open items in
[the audit](license-audit.md), including per-version publication/change dates,
ownership and artifact-specific inventories. Normal CI reports these reviews;
strict full-distribution review is a separate opt-in check.

## Secret Checks

```bash
gitleaks detect --source . --config .gitleaks.toml --no-git --redact
gitleaks detect --source . --config .gitleaks.toml --redact
```

Do not commit generated Kubernetes Secrets, Flux bootstrap token secrets, private keys, kubeconfigs, Ansible Vault files, or filled installer tokens.

## Third-Party Review

- Review [../THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) for referenced
  runtime images and Helm charts.
- Confirm upstream artifact licenses and terms are acceptable for the intended release.
- Confirm brand and project names are used only to identify integrations.
- Confirm pinned images or digest references are still intentionally selected.
- Run `bash magic-cluster/platform/ai/freetoken/verify-runtime-descriptor.sh` if
  the FreeToken runtime is included. A pending descriptor is valid only before
  the feature is enabled; a release descriptor must be `verified` and digest-pinned.

### Realtime acceptance

- Use the dedicated **Build MagicStick Omni ROCm runtime image** workflow for AMD
  images. Confirm source-pin agreement, native AMD64 build, offline one-/two-device
  contract and final-image inventory before publishing. Its `GITHUB_TOKEN` upload
  requires source checks and emits the advisory license review. Review the recorded image digest and
  build attestation before a separate catalog promotion; no local personal token
  or manual tag is the source of the release artifact.
- Verify that the [Realtime](../reference/realtime.md) source commit and multi-platform image
  digest still match and are pullable; do not silently advance a nightly tag.
- Review the version-bound CPU-offload compatibility shim and run
  `controller/verify_realtime_image.py --bootstrap <generated-bootstrap.py>`
  from the operator source in a disposable pinned runtime container. Retain
  strict source-hash and argument-ownership checks. This is not an inference test.
- Back up LiteLLM's PostgreSQL database before upgrading to 1.101.0; verify the
  migration and existing keys, OIDC, chat/embedding routes and Private Mesh.
- Test actual Qwen3-Omni speech through LiteLLM Playground and the authenticated
  Gateway, including another turn, server VAD/barge-in and unauthorized access.
- Verify one- and two-GPU configurations separately where offered; do not
  equate unit tests or HTTP health with successful CUDA/audio inference.
- Treat open Omni model/hardware selection as an experiment, not acceptance.
  Check actual GPU assignment, kernels and audio for each claimed combination.
  Default images must be digest-pinned; custom images require separate review.
  Verify AWQ/FP8/unknown model references are no longer blocked by product
  allowlists while slot, claim identity and authorization checks still apply.
  CPU/XPU selection with a custom image is not proof of an implemented backend.
- Verify Stop/Start/Restart, route withdrawal, GPU release, logs and ordinary
  vLLM/Ollama regression requests. Keep untested combinations marked unverified.

### Ubuntu 26.04 GPU acceptance

- Recheck the pinned stable charts in the official Helm indexes: NVIDIA
  `v26.7.0` (driver `595.91.07`), AMD `v1.5.1`, and both Intel charts `0.36.0`.
- Verify the actual K3s and containerd versions on a fresh install. NVIDIA
  26.7 documents K3s 1.33–1.37 and containerd 2.0–2.3. An existing installation
  must not be assumed compatible just because Flux can update its HelmRelease.
- Check NVIDIA RuntimeClass/device-plugin operation and containerd configuration
  persistence across a computer restart. Do not silently switch to DRA or NRI.
- Verify the NVIDIA GPU generation against R595 support; Maxwell, Pascal and
  Volta require a separately reviewed older-driver/OS combination.
- Keep AMD host/inbox-driver mode, disabled KMM and explicit Strix Halo opt-in.
  Ubuntu 26.04 and Strix Halo are not made operator-certified by these pins.
- Validate Intel `i915`/`xe` device registration and the actual inference runtime
  on the selected GPU. A host kernel update alone is not user-mode validation.
- Confirm one shared NFD deployment, optional/manual engine validation, and a
  real model start on each GPU type claimed as supported. Record untested
  combinations rather than claiming whole-stack compatibility.

## GPU sharing acceptance

- Publish the pinned AMD CDI-recovery image before promoting the operator image
  reference. Verify checkpoint restoration across a reboot with a retained claim,
  including changed DRM numbers on mixed-GPU hosts. Missing/replaced hardware and
  unverified legacy claims must be quarantined without blocking kubelet cleanup.
  Do not clear checkpoints or force-delete shared claims to recover. See
  [the recovery contract](../administration/gpu-sharing.md#restart-recovery-and-legacy-migration).
- Confirm the runtime-owned diagnostic history preserves consumed requests and
  image evidence before Job TTL cleanup; deleting a Job must not repeat its test.
  API/history failures must block new diagnostics, not GPU driver reconciliation.
- Apply host runtime declarations before disabling NVIDIA Toolkit runtime
  restarts; verify no Toolkit SIGHUP restarts K3s on the next boot. Check
  terminal-model recovery and its five-attempt bound independently of readiness.
- Check native admission support on Kubernetes 1.36+, CDI injection, actual
  `ResourceSlices`, PCI identity and a shared claim with two simultaneous Pod
  consumers. Run real GPU computation and inference, not readiness alone.
- Verify model-slot limits, retained RAM requests, no CPU fallback without the
  admission adapter, and unchanged CPU/NVIDIA allocation.
- Exercise both allocation transitions, preserving model activations/downloads
  and waiting for claim release before stopping DRA. Confirm optional per-engine
  validation works with the shared claim.
- Check administrator/CSRF/revision/consent guards and hardware UI status.
  Do not describe cooperative sharing as hard memory or tenant isolation.
- For NVIDIA, verify inherited configuration is not automatically changed;
  exercise exclusive/shared and slot-count changes through the Hardware UI.
  Check actual device-plugin readiness, node configuration/replica labels and
  allocatable slots. Run two real inference workloads concurrently.
- Confirm NVIDIA transitions affect only NVIDIA models and preserve offloading
  RAM requests/limits; AMD transitions affect only AMD models. On mixed hosts,
  retain Strix Halo memory safety checks and leave NVIDIA VRAM management alone.
- Check external NVIDIA plugin configurations, MIG, multiple physical GPUs,
  node-identity changes and unmanaged workloads fail closed. Confirm physical
  GPU inventory does not multiply devices by the time-slicing replica count.

## Private Mesh release gates

- Verify module activation and inference without a license file. Reject forged,
  expired, reused and revoked invitations or membership leases. Preserve role
  checks, model allow-lists, loop prevention, recovery and local inference.
  Ship BSL and all upstream notices, with corresponding source where required.

- Run backend, API, dashboard and native transport tests, then the isolated real
  A/B/C acceptance fixture described in [Private Mesh](mesh-validation.md#versions-and-verification).
  Record mock/fixture boundaries; do not equate unit/render tests with deployment.
- Verify two real appliances and a companion, ordinary app keys, local-first
  fallback, streaming, cancellation, rate limits, node loss/reconnect, unshare,
  revocation, expired authority leases and no re-export/direct vLLM access.
- Verify NetworkPolicy enforcement and that native owner control, stage/worker
  and file-transfer surfaces are inaccessible to both untrusted and client peers.
- Test direct and forced-relay paths across networks. The creator HTTPS endpoint
  must remain reachable independently of the inference relay.
- Promote verified immutable Mesh, dashboard Web/API images and the matching
  LiteLLM callback. Roll model pods deliberately to enable the vLLM scheduler
  argument; do not restart user models implicitly during a module toggle.
- Build, launch-test and sign/notarize companion bundles on every advertised
  platform. Recompute the native checksum after nested executable signing and
  before signing the outer app. Publish verified downloads before advertising
  laptop onboarding. The build matrix includes macOS ARM64/Intel, Linux x64 and
  Windows x64. Windows test ZIPs are unsigned; customer distribution requires
  approved Authenticode signing and Windows client acceptance. Never disable
  endpoint security controls to work around unsigned-build warnings.
- Preserve upstream licenses and capture complete image/bundle dependency SBOMs.
- Permanent companion pre-release assets are test distribution, not customer
  release approval. Promote only successful main builds with all four platform
  archives, native packaged-launch evidence, source provenance and matching
  SHA-256 files (eight assets). The launch check uses disposable state and does
  not establish real mesh enrollment/inference. Upload into a draft,
  verify remote digests before publishing, and never replace old assets or tags.

## Review Questions

- Does every public hostname use `example.local`, `example.com`, or a documented placeholder?
- Are real domains, admin emails, storage sizes, and external Flux paths absent from this repository?
- Are catalog placeholders such as `AI_APPLIANCE_DEFAULT_CHAT_MODEL` and
  `AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL` documented and safe by default?
- Does the public `ai-external-models` ConfigMap contain only an empty example schema and no provider secrets?
- Are safe defaults clearly documented for runtime settings and optional overlays?
- Are optional modules, models, and app instances represented as runtime CRs
  instead of static public descriptors?
- Are render-only examples public-safe and limited to `example.local`,
  `example.com`, `CHANGEME`, or documented variables?
- Do module catalog paths point only to reusable public bases?
- Do example overlays still build after public base changes?
- Do module, model and instance changes use `ModuleActivation`,
  `ModelActivation`, and `AppInstance` CRs without direct workload install
  permissions? Do host actions use only bounded, immutable `HostOperation`
  requests without dashboard access to host execution or operation status writes?
- Do host preparation and power changes require explicit administrator consent,
  current host/plan identity and local replay protection? Does experiment mode
  remain limited to shipped profiles without implying general GPU support?
- Are new secrets generated at runtime instead of stored in Git?
- Are new public interfaces documented in `docs/configuration.md`,
  `docs/gitops-overlays.md`, `docs/operations.md`, or another focused page?
- Are issue templates and pull request checklists steering users away from
  posting deployment-specific values?
