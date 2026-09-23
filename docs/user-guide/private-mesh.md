# Use Private Mesh

Private Mesh is an opt-in core module managed from **System → Settings →
Mesh**. It shares existing local vLLM, Ollama and FreeToken backends with enrolled appliances and
consume-only employee laptops. It never starts another copy of the model.

## Core access and security

Private Mesh requires no license file on an appliance or consume-only companion.
Administrators enable it through the authenticated dashboard API. Appliances and
companions use signed invitations, device identities, membership, expiring signed
rosters and per-model allow-lists. Consume-only companions cannot create meshes,
invite members or export models. A license file never bypasses these checks.

Membership revocation, expired authorization leases and unavailable discovery
fail closed. Reconciliation clears stale native allow-lists and owned remote
routes/share keys. Local models and normal LiteLLM routes remain independent.
Recovery actions include unsharing, revocation, leaving and disabling the module.

The implementation is in `core/magicstick_core/private_mesh/`, with BSL 1.1
terms in [LICENSE](../../LICENSE). Upstream MeshLLM and endpoint-plugin code retain
their own Apache-2.0 notices. See [third-party obligations](../../THIRD_PARTY_NOTICES.md).

## User workflow

1. Open **System → Settings → Mesh → Enable Private Mesh** as an administrator.
   The existing module/Flux lifecycle installs the optional component.
2. Choose **Create Private Mesh**, enter mesh/device names, select relay settings
   and choose ready local models to share. Sharing is off unless selected.
3. Under **Invitations**, create a single-use invitation for **Magic Stick** or
   **Employee laptop**. The token is displayed once; send it over a trusted
   channel. Invitations expire and can be revoked before use.
4. On another appliance, open **System → Settings → Mesh → Join Mesh** and enter
   the device name and the **Magic Stick** invitation token. The join entry stays
   visible after setup, including when disconnected. If the optional module is
   not installed, the dialog first offers **Enable Private Mesh** and waits for
   it to become available. If this appliance already belongs to a mesh, it first
   requires an explicit **Leave current mesh** confirmation; opening the dialog
   or canceling before confirmation never changes membership. One appliance belongs to one
   mesh at a time. Leaving stops sharing/imported routes, not local models;
   leaving on the owner also removes the other members' authorization when their
   leases expire. Use a fresh invitation to rejoin. Tokens are cleared when the
   dialog closes or joining succeeds and are never stored in browser storage.
   For a laptop, open the platform's companion application and use its Join
   form. No LiteLLM/Kubernetes credentials are given to the laptop.
5. **Overview**, **Models** and **Network** show status, imports, sharing limits
   and relay configuration. Buttons save only actual configuration changes.
6. Unsharing removes the allowed export immediately and then removes remote
   routes. Revoking a node denies new requests as soon as the exporter refreshes
   its signed policy; previously started inference is not retroactively canceled.

The companion opens a loopback browser UI itself; its authenticated API cannot
configure infrastructure or publish models. The interface is titled
**Magicstick MeshLLM Endpoint**. Its collapsible **OpenAI-compatible API**
section shows the current loopback Base URL, a masked/copyable inference-only
API key, exact model ID and curl example. The independent, per-launch Bearer
key allows only `GET /v1/models` and `POST /v1/chat/completions`; it cannot read
the browser session, join/leave the mesh, change relay settings or stop the
client. Connection details require the authenticated browser session and are
not embedded in the public HTML or routine status response. Host/origin checks
remain in effect, and the listener is never opened to the LAN.

The desktop HTTP adapter currently supports non-streaming text chat only
(`stream: false`); streaming requests are explicitly rejected. Its local
port/key may change on restart. These desktop limits are distinct from the
appliance-to-appliance Mesh bridge's streaming support. See
[client connection instructions](../../magic-cluster/apps/ai/private-mesh/COMPANION-README.md#connect-a-local-application).
Its
[GitHub build workflow](../../.github/workflows/build-mesh-companion.yml) runs on
relevant pushes to `main`, matching pull requests, or **Run workflow** in GitHub
Actions. No application signing credential or appliance secret is required.

### Permanent GitHub client downloads

Open the repository's **Releases** page and select a **MagicStickMesh**
pre-release. Every complete, successful `main` client build publishes its four
platform archives and SHA-256 files as **release assets without automatic
expiry**. Versioned tags use `mesh-client-<build>.<attempt>-<commit>`; old releases
and downloads are never automatically deleted or overwritten. Public release
assets can be downloaded without a GitHub login.

| Package | Target | Release asset |
|---|---|---|
| `MagicStickMesh-macos-arm64` | Apple Silicon / M-series, including M5; macOS 14 runner | `.zip` with `MagicStickMesh.app` |
| `MagicStickMesh-macos-x64` | Intel Mac; macOS 15 runner | `.zip` with `MagicStickMesh.app` |
| `MagicStickMesh-linux-x64` | x86-64 Linux; Ubuntu 24.04 runner | `.tar.gz` with the complete executable directory |
| `MagicStickMesh-windows-x64` | Windows x64; Windows Server 2022 runner | `.zip` with `MagicStickMesh/MagicStickMesh.exe` and the bundled runtime |

Download the platform `.zip` or `.tar.gz` asset and extract it once. The
GitHub-generated **Source code** archives are not client applications. Each
macOS/Linux archive preserves executable permissions and symbolic links. All archives include onboarding
instructions, source/build metadata and resolved Python/Cargo dependency
inventories; the adjacent `.sha256` file covers the complete platform archive.
See the [bundled client instructions](../../magic-cluster/apps/ai/private-mesh/COMPANION-README.md).

The workflow also keeps its intermediate **Actions → Artifacts** downloads for
30 days. Those expiring copies are for CI/debugging; their expiry does not affect
release assets. PR builds produce only these temporary artifacts, never releases.

To promote an older, still-unexpired successful `main` build without rebuilding,
use **Actions → Build Private Mesh companion → Run workflow** on `main` and set
`source_run_id` to that build's numeric run ID. Leave the field empty for a new
build. Publication checks repository, branch, workflow, source history, all
four platform results, archive checksums, packaged launch evidence and embedded
build revision. Historical three-platform runs cannot be promoted with this
four-platform workflow; build a new revision instead. Existing published releases
remain unchanged. A draft becomes public only after all eight assets are uploaded and their remote digests
match. Retries resume matching drafts; differing existing files are rejected.

GitHub may deny the CI token permission to create a tag for a historical commit
with older workflow files. In that case, publication stops with the exact tag
and source SHA. A maintainer can create that lightweight tag at the specified
SHA using their normal repository access, then retry the workflow. Never point
the tag at a different commit or broaden the workflow token's permissions to
work around this check. Existing tags are verified and never moved.

Before upload, CI checks packaging contracts, host/target architecture, the
exact patched native source, the bundled transport checksum/version, Windows
native import policy and macOS signature integrity. It starts the actual frozen
application on each native runner and checks its loopback UI, rejected
unauthenticated access, authenticated status and shutdown using disposable state.
This check neither opens a browser nor joins a mesh. A missing package or failed
launch fails publication. These are **test pre-releases**: macOS apps are not
Developer ID signed/notarized and Windows packages are not Authenticode signed.
Real mesh enrollment/inference, complete SBOM review and platform release
acceptance remain separate gates.

### Windows companion package

Extract `MagicStickMesh-windows-x64.zip` and start
`MagicStickMesh/MagicStickMesh.exe` from inside the extracted package. Keep the
`_internal` directory beside the launcher. The package contains the native x64
transport and Python runtime; Python, Rust, Docker and a local GPU are not
required. This build does not provide Windows ARM64 or 32-bit executables.

The native transport starts without an extra console window and receives only
its isolated runtime directory and the required Windows system environment,
not appliance/admin credentials. Membership is persisted under
`%LOCALAPPDATA%\MagicStickMesh`. **Quit endpoint** stops the application;
closing the browser alone does not. Windows may warn about the unsigned test
download. Do not disable SmartScreen, Defender or other security controls;
organization-approved signing and Windows client acceptance remain release gates.

### macOS companion package

Build on the intended Mac architecture: Apple Silicon notebooks (M-series) use
`arm64`. The existing `build_companion.py` bundles the native policy-enabled
MeshLLM transport, Python runtime and dependencies in `MagicStickMesh.app`;
notebooks do not need a separate Python or Rust installation. It uses only the
consume-only client interface and still requires a **Client / Employee laptop**
invitation from the mesh creator.

PyInstaller rewrites and ad-hoc signs the native executable on macOS. The builder
therefore records the checksum of the **packaged** executable, then re-seals and
verifies the outer app without signing nested executables again. The resulting
test bundle is **not Developer ID signed or notarized**. Do not describe ad-hoc
signature verification as Apple distribution approval. For a release, sign the
nested code with the release identity, regenerate its checksum, sign the outer
app and complete notarization and launch acceptance. Never disable Gatekeeper or
remove application security controls as a packaging step.

The macOS `cryptography` binding must use statically linked OpenSSL. Intel builds
may compile this pinned dependency from source; CI sets `OPENSSL_STATIC=1`,
disables the pip wheel cache and rejects dynamic `libssl`/`libcrypto` imports
before building the transport. This avoids bundling incompatible OpenSSL
libraries from Python and Homebrew under the same file name. The final frozen
launch check remains mandatory on both Mac architectures.
