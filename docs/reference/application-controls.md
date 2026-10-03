# Application configuration

## Services, Modules, And Instances

The **Services** screen replaces the former separate Modules and Instances
screens. It is catalog-driven and uses
`ConfigMap/magicstick-module-catalog.data["modules.json"]` for display names,
groups, activation mode, aliases, ordering, dependencies, and optional advanced
parameters.

Application services such as OpenClaw, Hermes, and Paperclip are displayed as
parent cards. Their existing `AppInstance` resources are nested directly below
the matching application, so status, URLs, credentials, and removal controls
remain together. Nested instances are collapsed by default and each application
has its own **Show**/**Hide** control; an expanded application remains expanded
across the periodic dashboard refresh. In the React dashboard, instance URLs
appear only on their instance card; the parent card keeps only the module's own
URLs, including while its instances are collapsed. The **New Instance** action on a parent
card opens that application's configuration directly. The global **Create
Instance** action keeps the two-step type picker for users who have not chosen
an application yet.

Shared AI runtime modules are rendered as compact rows in a separate section.
Technical platform and operator modules stay collapsed by default and can be
expanded explicitly. Filters switch between Applications, AI Runtime, and
Platform without changing any backend resource or lifecycle behavior.

Modules with `activationMode: static` are displayed as status cards but cannot
be enabled or disabled from the dashboard. Modules with
`activationMode: moduleactivation` expose only the currently valid action:
`Enable` for disabled modules and `Disable` for enabled modules. In-progress
modules disable their action button until the request settles.

Catalog entries with a supported `credentials.provider` show a **Credentials**
action only to operators and administrators while the module is enabled. For
LiteLLM, the panel exposes `admin` plus the generated master key used as the UI
password, API authorization value, and local/public API URLs. The API reads
only the fixed `ai/litellm-masterkey-secret`; catalog data cannot redirect it to
another Secret. Credential responses use `Cache-Control: no-store`.

This includes the optional vendor GPU and `kubeai` modules. KubeAI stays
disabled until a local model requests it. Vendor GPU modules are requested when
NFD detects matching hardware; a manually disabled provider is not
automatically re-enabled. CPU models require KubeAI but not the NVIDIA module.
A manual action takes ownership away from automatic lifecycle cleanup.

Progress is phase-based. The dashboard maps existing status phases such as
`Disabled`, `WaitingForModules`, `Starting`, `Reconciling`, `Removing`, `Ready`, and
`Degraded` to visual progress states. These percentages are orientation hints,
not scheduler- or operator-reported completion percentages.
Model Pod creation and runtime startup use indeterminate progress without a
percentage; failures also do not display a completion percentage.
For vLLM-Omni, Kubernetes permission/admission failures appear in the installed
model's status even when no Pod could be created. Temporary API outages remain
Starting and recover automatically; see [Realtime operations](../administration/troubleshooting/realtime.md#qwen3-omni-realtime-operation).

Instances are runtime requests stored as `AppInstance` resources in namespace
`ai-system`. The dashboard shows create controls only for instance types whose
required modules are installed or installable according to the module
catalog and current module status.

`Create Instance` opens a two-step dialog. The first step lists every instance
type in the application catalog, such as OpenClaw, Hermes, or Paperclip. Types
whose required modules are not Ready remain visible but disabled and identify
the missing modules. After selecting an available type, the second step renders
only that application's fields. `Cancel` closes the dialog if a different type
should be selected.

Instance hostnames are derived, not user-entered:

```text
<instance-name>.<instance-type>.<domain>
```

For example, an OpenClaw instance named `default` uses:

- `default.openclaw.magicstick.example.com`
- `default.openclaw.magicstick.local`

Every create form selects an access mode and exposure. The safe default is
shared SSO for any authenticated `magicstick-user`, with optional minimum roles
of viewer, operator, or administrator. An unauthenticated route is available
only through the explicit `Public without login` choice. Exposure can be local
only or both local and public; hostnames remain derived and are not user-entered.

The operator, not the instance chart or dashboard, creates `HTTPRoute`,
`SecurityPolicy`, and `ReferenceGrant` resources. Both local and public links
are reported in `AppInstance.status` and displayed on the instance card. The
catalog marks these AI application routes as streaming-capable, so their total
Envoy request timeout is disabled without changing the bounded SSO callback
routes.

Envoy Gateway is also the browser authentication boundary for application
instances. Hermes is configured against the in-cluster LiteLLM endpoint and
its instance URL opens the bundled Hermes dashboard on port `9119`; port `8443`
remains the separate agent gateway used by in-cluster integrations.
Paperclip runs in private `local_trusted` mode behind an in-pod loopback proxy,
and Odysseus disables its application-local login, so neither presents a second
login after the shared SSO check. Their Services remain ClusterIP-only and are
reached externally only through the operator-generated authenticated routes.

The Paperclip form additionally selects the default chat model, enables the
OpenCode sandbox runtime, optionally binds an existing OpenClaw or Hermes
gateway instance, and sets the maximum concurrent sandbox count. Gateway
selectors list existing matching `AppInstance` resources and are required only
when their checkbox is enabled. These values are stored under
`spec.values.agentExecution`; the dashboard does not create Paperclip
companies, employee agents, or gateway credentials.

## Pi Coding instances

The `pi-coding` application runs the upstream [Pi v1.0.0 release](https://github.com/earendil-works/pi/releases/tag/v1.0.0)
through ttyd 1.7.7 on service port `7681`. It uses the standard application catalog,
`AppInstance`, HelmRelease, SSO and instance-sharing flow. The module is optional
and disabled by default; its dependencies are `basis`, `litellm` and `model-catalog`.
Pi instances require namespace `ai`, where the model catalog and LiteLLM Secret live.

The form persists `spec.values.model` and `spec.values.storage.size`. Hostnames use
`<name>.pi-coding.<domain>`. The operator creates the local/public Gateway routes
with unbounded application request duration for the terminal WebSocket; the chart
exposes only a ClusterIP Service. The terminal checks WebSocket origins, accepts
one client at a time, and supplies no URL-controlled command arguments.

The Node 24 Bookworm base image is pinned by OCI digest. An init container downloads
the official Linux amd64/arm64 Pi and ttyd release assets and verifies their locked
SHA-256 checksums before extraction or execution. Pod recreation repeats this
bootstrap and requires GitHub access; Pi's automatic startup network operations are
disabled with `--offline`, which does not disable inference through LiteLLM.
Pins and upstream sources are recorded in
`magic-cluster/apps/instances/pi-coding/files/runtime-lock.json`.

Pi starts with the explicitly selected LiteLLM chat model. It reads the shared
`pi-models.json` export through its persistent agent directory; credentials are
environment references, backed by `litellm-masterkey-secret`, and are never copied
into the model ConfigMap. A missing selected model fails startup instead of choosing
another provider. Catalog changes follow the existing consumer-restart path, and
Pi `/model` reloads the mounted provider file. Per-model compaction budgets leave
space for agent instructions and tool results; other preferences and sessions are retained.

The process runs as UID/GID 1000 with a read-only root filesystem, dropped Linux
capabilities, and no service-account token or host mounts. Its home directory,
workspace and sessions live on the instance PVC. Removing the HelmRelease retains
that PVC through `helm.sh/resource-policy: keep`; deleting retained data is a separate
administrator operation. Recreating the same instance name reuses the volume.
Readiness confirms validated model configuration and an available terminal, not a
successful inference response. Verify inference with a small request after installation.
