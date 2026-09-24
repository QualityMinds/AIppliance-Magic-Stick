# Changelog

Notable public changes to AIppliance-Magic-Stick should be recorded here.

Versioned entries contain curated release scope, installation links and known
limitations. Detailed pre-versioned notes are retained separately below. See the
[release procedure](docs/development/releases.md) for channels and publication.

## Unreleased

### Fixed

- Keep the dashboard lockfile byte-identical on Windows checkouts and check the
  companion's source inventory before expensive compilation/packaging.
- Guard the pinned Omni CUDA-only shutdown repair on HIP/CPU builds, and check
  real ROCm/Omni imports before exporting an image. Unknown upstream source fails
  closed; actual GPU/audio acceptance remains separate.
- Replace the large pre-test GitHub Actions cache export with a final-layer,
  branch-scoped registry cache written only after runtime and source checks.

## v0.1.0 - 2026-09-24

Magic Stick's first versioned **Early Access** release brings installation,
local AI inference and day-to-day administration together in one dashboard.
This is a baseline for evaluation on your own infrastructure, not a promise of
universal GPU/model compatibility or production acceptance for every feature.

### Highlights

- **Install without a local build.** Download the existing Ubuntu 26.04.1 AMD64
  online USB installer, verify its checksum and write it with a raw-image USB
  writer. The installer includes network/mirror configuration and protected
  first-administrator setup; no shared dashboard password is supplied.
- **Manage models in one place.** Ollama, vLLM and FreeToken use the common model
  workflow on eligible hardware, with engine-specific configuration, resource
  planning, Start/Stop/Restart, editing and pod logs. LiteLLM provides the shared
  OpenAI-compatible inference entry point.
- **Understand and manage the hardware.** View CPU/GPU memory and allocation
  slots, configure supported AMD DRA or NVIDIA time-slicing modes, and use
  optional engine validation. Strix Halo preparation and shared-memory controls
  remain an explicit hardware-specific path.
- **Operate the appliance.** Manage local users, groups, applications, API access,
  network settings, model caches, host preparation and power actions. Native
  Ubuntu security maintenance has a configurable policy; automatic computer
  restarts are not enabled by default.
- **Connect users and devices.** Resource Sharing and opt-in Private Mesh are
  core features. Federated SSO requires a valid license activation; the canonical
  license terms determine production-use eligibility.
- **Follow one handbook.** The English Markdown guides and searchable website
  share a source, with installation walkthroughs, reviewed dashboard screenshots,
  architecture diagrams and separate technical references.

### Download and install

- [USB installation guide](https://qualityminds.github.io/AIppliance-Magic-Stick/handbook/installation/bare-metal/)
- [Existing online installer and verification files](https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/tag/installer-main-ff5fe42eb807315ead9b6a25d7ed561447e23e620975c49f578c4d752cccfd89)
- [Download the AMD64 .img](https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/download/installer-main-ff5fe42eb807315ead9b6a25d7ed561447e23e620975c49f578c4d752cccfd89/magicstick-installer-main-amd64-online-ff5fe42eb807315e.img)
- [Download its SHA-256 file](https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/download/installer-main-ff5fe42eb807315ead9b6a25d7ed561447e23e620975c49f578c4d752cccfd89/magicstick-installer-main-amd64-online-ff5fe42eb807315e.img.sha256)

The image is **1,722,220,544 bytes (about 1.60 GiB)**. Its SHA-256 is
`b03edf5aa58600fa740d66a0c85efb6488058b8e9adc20c10a57ccd047f37636`.
It is reused unchanged, not rebuilt or renamed for this release. Its original
build manifest and integrity evidence remain on the linked installer release.

Internet access is required for packages, container images, charts and model
downloads. Back up the target computer before installation. The product tag
freezes the source snapshot; this installer bootstraps the **current `main`**
channel, not a fully frozen v0.1.0 appliance. See
[release channels and pinning](https://qualityminds.github.io/AIppliance-Magic-Stick/handbook/administration/updates-rollback/#release-channels).

### Validation and known limitations

- On 24 September 2026, the project owner reported a successful online
  installation and confirmed the release smoke test: dashboard login, model
  start, an API request, log viewing and model stop. These are owner-reported
  appliance results, not tests rerun by the release automation; no complete
  per-engine/per-GPU matrix or independent test logs were supplied.
  See the [acceptance record](https://github.com/QualityMinds/AIppliance-Magic-Stick/blob/v0.1.0/docs/development/reports/release-v0.1.0-2026-09-24.md).
- Source/release checks and browser tests use their documented scopes. Browser
  fixtures do not establish real GPU inference, identity-provider recovery or
  multi-appliance Mesh acceptance. The broader acceptance and artifact-review
  items remain visible in the
  [release checklist](https://github.com/QualityMinds/AIppliance-Magic-Stick/blob/v0.1.0/docs/development/release-checklist.md)
  and [audit](https://github.com/QualityMinds/AIppliance-Magic-Stick/blob/v0.1.0/docs/development/license-audit.md).
- Hardware and model compatibility depend on the selected engine, architecture,
  drivers and runtime. FreeToken uses its restricted NVIDIA capability policy
  and whole-GPU allocation; it does not use AMD GPUs or NVIDIA time-slicing
  slots. See the
  [versioned compatibility reference](https://github.com/QualityMinds/AIppliance-Magic-Stick/blob/v0.1.0/docs/reference/compatibility.md).
- GPU sharing does not add VRAM or provide hard per-model memory isolation.
  Memory estimates and reservations are not proof that every workload fits.
- Realtime is a separate experimental vLLM-Omni path. Chat API compatibility is
  not a claim of Realtime support in Ollama or FreeToken. Only the configured
  NVIDIA Realtime profile has a bundled runtime image in this baseline.
- There is no appliance-wide one-click backup/restore or factory reset. Platform
  reconciliation does not upgrade the Ubuntu release. Backups and hardware-
  specific recovery plans remain the administrator's responsibility.

### Release channels and licensing

`main` remains the default installation/release channel. `develop` starts from
the v0.1.0 source baseline for explicit development opt-in; existing appliances
are not switched. A source update on `main` is already eligible for Flux
reconciliation, independently of creating a GitHub Release. This release does
not perform a manual appliance rollout or promote new runtime image digests.

Magic Stick-owned source uses
[BSL 1.1 and its Additional Use Grant](https://github.com/QualityMinds/AIppliance-Magic-Stick/blob/v0.1.0/LICENSE).
The version's publication/Change Date is retained in
[LICENSE-RELEASE.json](https://github.com/QualityMinds/AIppliance-Magic-Stick/blob/v0.1.0/LICENSE-RELEASE.json).
Third-party components and models keep their own terms. Open legal, notice and
artifact reviews remain advisory review work, not fabricated approvals or a
blanket distribution clearance.

## Pre-versioned development

The following notes retain the development history before v0.1.0. They are not
pending changes or an acceptance checklist; versioned release notes above define
the reviewed release scope and its known limitations.

### Added

- Release preparation skill and local metadata helper, with immutable per-version
  date records, curated notes and an explicitly requested GitHub release draft.
- Real Chromium dashboard smoke tests for desktop/mobile navigation, roles,
  model start/stop, conflicts and logs, using isolated API fixtures.
- Weekly reviewed image-update proposals for Odysseus, Chroma and ntfy, targeting
  develop without automatic merges or appliance changes.

- Weekly and on-change license audit CI with hash-verified upstream evidence,
  dependency drift checks, source SBOMs, per-architecture dashboard image
  inventories and explicit release-readiness gates. kdns is recorded as
  MIT-declared with an incomplete upstream copyright/license notice.

- Opt-in Private Mesh implementation under System Settings: signed device
  enrollment, consume-only companion source, scoped LiteLLM model/key sync,
  loop-resistant local vLLM exports, remote limits and trusted queue priorities.
  Membership, signed rosters and model allow-lists protect shared inference.
  Consume-only laptops use signed invitations.
  End-to-end/network and platform-release gates are tracked in
  [Private Mesh](docs/private-mesh.md); source availability is not a rollout claim.

- Administrator-only **System → Updates** for per-computer Ubuntu update policy,
  daily UTC maintenance windows, manual checks/installations, held-package
  visibility and restart status. Ansible enables native unattended security
  updates by default, preserves saved policy, excludes the kernel/GPU stack and
  coordinates updates with other host maintenance. Automatic restarts remain
  disabled unless explicitly enabled.
- GPU compatibility diagnostics with an opt-in Strix Halo profile, separate
  Ollama/vLLM smoke-test gates, validated runtime-image pins and unified-memory
  accounting that does not count shared system RAM twice.
- One post-install, Ansible-backed host-preparation workflow for new and
  existing appliances, with reviewed package plans, explicit administrator
  consent, persistent progress and post-reboot verification.
- A bounded hardware experiment mode for unreviewed GPU combinations, plus
  administrator-only dashboard restart and shutdown actions with exact-host
  confirmation and replay protection. Mixed-GPU acceptance remains a separate
  hardware test, not an automatic support claim.
- Release-owned public license trust distribution alongside preserved local
  issuers, automatic support for upgrades from an empty legacy store,
  conflict/retirement checks and a nonempty-public-key release gate.
- BSL 1.1 source-available code with an Additional Use Grant, a group-wide
  EUR 2,000,000 annual-revenue threshold and MIT Change License after three years.
  Free, Free Registered and Commercial editions share one source tree and images.
- Offline Ed25519 license files, separate issuer tooling, admin-only React/CLI/TUI
  management, Kubernetes persistence and replacement conflict protection.
  Federated SSO is the only feature requiring a signed license file.
- Core instance sharing with stable user/group allow-lists, live authorization,
  fail-closed gateway guards, a basic-user launchpad and dashboard/CLI management.
- Dashboard-managed federation for multiple OIDC or SAML providers, metadata
  validation, exact claim/attribute-to-role mappings, redacted secret handling,
  local-login recovery and fail-closed entitlement enforcement.

- Fail-closed one-command installation wrappers for dedicated Ubuntu 24.04
  hosts and existing Kubernetes clusters from Bash or PowerShell 7, including
  read-only preflight modes and First-Run Setup initialization.
- A local-network-only first-run wizard with physical-console claim code,
  mDNS-independent IP access, and one-time administrator provisioning.
- `ApplianceSetup` lifecycle state and fail-closed legacy migration behavior.
- GitHub Pages landing page with legal notice and privacy policy.
- Public support, maintainer, and governance documentation.
- A Git-owned application catalog and per-application Helm charts for runtime
  `AppInstance` resources.
- An administrator-only dashboard user-management tab for local Keycloak users,
  including search, access-level assignment, enable/disable, temporary-password
  reset, and protected deletion.
- CPU-backed local vLLM inference with a target-aware dashboard selector,
  cross-architecture smoke preset, and an extensible compute-target catalog.
- Shared 60-second Node Feature Discovery plus hardware-triggered, pinned
  NVIDIA, AMD, and Intel GPU operators with preflight, conflict protection,
  retained restart state, allocatable-resource readiness, and dashboard status.
- AMD ROCm and Intel XPU vLLM targets with vendor-specific KubeAI profiles,
  automatic Intel `xe`/`i915` resolution, and availability-gated model controls.
- Ollama as a second KubeAI inference engine with engine-aware dashboard
  controls, CPU/NVIDIA/AMD profiles, a portable Qwen2.5 smoke preset, persistent
  model cache, and target compatibility enforcement.
- Portable, backend-optimized Qwen3.5, Qwen3.6, and Qwen3.8 model presets with
  pinned Ollama Q4/Q8 tags, supported vLLM BF16/FP8/GPTQ/AWQ artifacts, and a
  Qwen3.5 4B capacity tier between the 2B and 9B models.
- Catalog-controlled precision and quantization choices per inference engine
  and compute target. The dashboard selects only allowlisted artifacts, applies
  their checkpoint and memory plan, and reports the resolved artifact in model
  status and installed-model cards.
- Administrator-managed, SSO-bound Kubernetes access with Viewer, narrow
  Magic-Stick Operator, and explicit Cluster Administrator levels, plus
  token-free OIDC kubeconfig downloads for local or brokered Keycloak users.

### Changed

- Installation defaults consistently track main; the Linux wrapper preserves
  explicit branch selection instead of pinning every installation to a commit.
  Development builds use develop with separate image aliases. Existing fixed
  installations require an explicit channel switch.
- Odysseus application defaults and companion services now use an immutable
  image lock. Explicit application-image overrides remain supported.
- Current host-vault paths and local/private Docker-context exclusions are
  covered; Markdown-only dashboard edits and unrelated tool edits no longer
  trigger the affected image builds.
- Marketing collateral moved to AIMS-000 in Team-Innovation with preserved
  source files and checksums. Removed unused historical dashboard images and
  stopped shipping presentation packages in Pages; current handbook captures remain.

- Fresh USB installations now use checksum-pinned Ubuntu 26.04.1 with its
  native Generic kernel and interactive APT mirror selection (country-mirror
  suggestion with a manual URL override). Existing Ubuntu 24.04 installations
  are not upgraded in place.
- New K3s installs pin `v1.36.4+k3s1`; NVIDIA GPU Operator moves to `v26.7.0`
  with containerd 2.x runtime drop-ins and driver `595.91.07`. Pre-Turing NVIDIA
  hardware requires a separate legacy-driver plan. AMD `v1.5.1` and Intel
  `0.36.0` remain the current stable pins. Ubuntu 26.04 Strix Halo preparation
  is a separate experimental profile; hardware acceptance remains outstanding.

- The browser dashboard now groups Settings, License, Users, and System Status
  under one primary **System** navigation item, with role-aware category tabs
  and redirects for the former direct hashes.
- The React frontend is now the standard dashboard at the existing local and
  public root URLs, using the original Service and OIDC routes. Shared API,
  CLI/TUI, first-run handoff and runtime resources remain unchanged.
- The pinned Ollama CPU/NVIDIA and ROCm server images now use release `0.33.2`
  so the bundled runtime can parse the Qwen3.5, Qwen3.6, and Qwen3.8 formats.
- Existing local `ModelActivation` resources remain compatible: when
  `spec.local.artifact` is absent, the selected preset variant resolves its
  declared `defaultArtifact`. Unknown artifact IDs fail closed.

- Instance creation in the dashboard now uses a two-step dialog that lists all
  catalogued types, explains missing modules for unavailable types, and then
  shows only the selected available instance configuration.
- The dashboard overview now lists complete local, public, and direct URLs for
  modules and app instances, including accepted Gateway API `HTTPRoute` hosts.
- Public documentation is being aligned with runtime CRs, catalog-driven modules,
  derived instance hostnames, and dashboard-managed settings.
- `AppInstance` now uses `spec.application` and `spec.values`; the Magic Stick
  Operator creates one Flux HelmRelease per instance instead of rendering app
  workloads in controller code.
- New appliances are accelerator-neutral. KubeAI is activated on demand by CPU
  or GPU local models, the NVIDIA GPU module only by NVIDIA targets, and
  external models run without a local inference runtime.

### Fixed

- Downloaded Kubernetes SSO kubeconfigs now use the appliance's current private
  control-plane IP instead of its mDNS name for the API endpoint, allowing
  OpenLens and other proxying GUI clients to connect without `.local` DNS
  support while preserving the stable Keycloak issuer.
- The bare-metal first-run code now appears on a dedicated, periodically
  refreshed virtual console after cloud-init has finished. A centered,
  color-coded appliance panel separates the access paths, claim code, TLS
  fingerprint, and next steps. Boot logs remain on the first console, internal
  CNI and virtual-interface addresses are hidden, and completion clears the
  claim from the physical display.
- OpenClaw instances now consume the generated LiteLLM provider catalog and
  start with the catalogued local model instead of silently falling back to the
  built-in public OpenAI provider.
- Hermes instance URLs now open the bundled web dashboard on port `9119`
  instead of routing browsers to the API-only gateway root on port `8443`.
- Odysseus instances now register their selected model and the shared LiteLLM
  endpoint through the Odysseus API instead of relying on unsupported
  environment variables.
- Magic Stick-managed KubeOpenCode templates now receive model-specific context
  and output limits, preventing OpenCode from requesting 32000 output tokens
  from local vLLM models with a smaller total context window.
- Enabled modules are suspended instead of destructively pruned while their
  dependencies are temporarily unready during a source or operator rollout.
- Browser-streamed responses from LiteLLM, AnythingLLM, KubeOpenCode, and all
  catalogued application instances are no longer terminated by Envoy's default
  15-second request timeout.
- LiteLLM's SSO policy no longer replaces its `Bearer sk-...` virtual-key
  header with the Keycloak access token on UI and API requests.
- The enabled LiteLLM module again exposes its generated UI and API credentials
  to authorized operators and administrators from the dashboard Services tab.
- The Envoy Gateway now redirects appliance HTTP URLs, including LiteLLM UI
  paths, to the equivalent HTTPS URL instead of refusing port 80 connections.

### Removed

- The ConfigMap-rendered HTML/JavaScript dashboard, renderer sidecar, obsolete
  UI tests, and separate preview Deployment, Service, mDNS route and SSO entries.
- Human default passwords and the generated `keycloak-local-admin` Secret from
  new installations.
- Application-specific manifest builders, cleanup lists, and direct workload
  permissions from the Magic Stick Operator.

### Security

- Dashboard user administration uses a dedicated scoped Keycloak service
  account, exact-name Kubernetes Secret RBAC, live administrator checks,
  same-origin mutation protection, and last-local-administrator safeguards.
- Human Kubernetes access uses short-lived OIDC credentials, PKCE, direct
  Keycloak group membership, least-privilege RBAC, public CA material, and no
  static bearer token or password in generated kubeconfigs.
