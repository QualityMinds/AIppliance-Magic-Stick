# MagicStickMesh client

This consume-only companion connects your laptop to an existing Private Mesh.
It includes Python and the native Mesh transport; no separate Python or Rust
installation is needed. It does not run an inference model on your laptop.

## Choose and open the client

- **macos-arm64**: Apple Silicon (M-series, including M5). Extract the ZIP
  and open `MagicStickMesh.app`. You may copy it to Applications first.
- **macos-x64**: Intel Mac. Extract the ZIP and open `MagicStickMesh.app`.
- **linux-x64**: x86-64 Linux, built on Ubuntu 24.04. Extract the `.tar.gz`
  and run `./MagicStickMesh/MagicStickMesh` from the extracted package directory.
- **windows-x64**: Windows x64, built on Windows Server 2022. Extract the ZIP
  completely and open `MagicStickMesh/MagicStickMesh.exe` inside the extracted
  package. Keep the `_internal` directory next to it. No separate Python, Rust,
  Docker or local GPU is needed. Windows ARM64 and 32-bit builds are not included.

The repository's **Releases** page contains permanent, versioned client assets
with no automatic expiry. Download the platform archive and its `.sha256` file;
extract the platform archive once. GitHub's **Source code** downloads are not
the client application. Intermediate Actions artifacts expire after 30 days
and add an outer ZIP which must be extracted first. Keep the complete app/directory
together: the launcher needs its bundled runtime. macOS/Linux archives preserve
executable permissions and symbolic links.

These are **test builds**, not signed production releases. macOS apps are only
ad-hoc signed, not Developer ID signed or notarized, and macOS may block a
downloaded copy. Windows packages are unsigned and may trigger a security
warning. Do not disable Gatekeeper, SmartScreen, Defender or other security controls. Intel
builds use macOS 15 runners; Apple Silicon builds use macOS 14 runners. Build
success does not establish compatibility with every older OS version.

## Join your mesh

1. On a Magic Stick, open **System → Settings → Mesh → Invitations**
   and create a **Client / Employee laptop** invitation.
2. Start the companion. It opens its local interface in your browser.
3. Enter a device name and the one-time invitation token, then select **Join
   mesh**. Transfer invitation tokens only through a trusted channel.
4. Select an available model and send a message.

Your laptop needs no appliance license, Kubernetes credentials or LiteLLM
administration key. Participating appliances require the `private-mesh`
Private Mesh module. If the model list is empty, an appliance must explicitly
share a ready local **vLLM**, **Ollama** or **FreeToken** chat model. The appliance
must run a Mesh version with engine-independent sharing; no engine or model
installation is needed on the consuming notebook.

Membership is stored outside the application and survives an application
update. Closing the browser tab does not stop the background client. Use
**Quit endpoint** to stop it, or **Leave mesh** to leave the mesh.
On Windows, membership is stored in `%LOCALAPPDATA%\MagicStickMesh`, not in
the extracted download folder. The native transport opens no extra console window.

## Connect a local application

The browser interface is named **Magicstick MeshLLM Endpoint**. After joining,
expand **OpenAI-compatible API**, between Models and Network. Choose an
OpenAI-compatible/custom provider in your application and copy the displayed
**Base URL**, **API key** and complete **Model ID**. Keep the `share/` prefix in
the model ID, even though the compact model selector omits it. The section also
provides a curl example for the selected model; replace `PASTE_API_KEY_HERE`
with the copied key. No real key is embedded in the example.

- `GET /v1/models` lists available shared models.
- `POST /v1/chat/completions` accepts text chat with `stream: false`.
- Authenticate with `Authorization: Bearer <API key>`.

The API listens on `127.0.0.1` only and is not available to other computers or
cloud-hosted tools. Keep the endpoint application running. The dynamically
assigned port and inference key can change when it restarts; update application
settings from the newly opened interface. The key is separate from the browser
session and cannot join/leave the mesh, change settings or quit the client. It
is shown masked, fetched only when opening the API section and never persisted
in browser storage. Treat it as a credential and give it only to trusted local
applications. Streaming, Responses API and embeddings are not supported by this
desktop endpoint; streaming requests receive a clear error instead of an
unexpected non-streaming response.

## Build information and verification

`BUILD-INFO.json` identifies the source commit, architecture, toolchain and
signature status. `PYTHON-DEPENDENCIES.json` and `Cargo.lock` record resolved
build dependencies; they do not replace a complete release SBOM/review. The
application includes the BSL, MIT Change License and upstream license notices.

The adjacent `.sha256` file covers the complete platform archive. Verify it with
`shasum -a 256 -c FILE.sha256` on macOS or `sha256sum -c FILE.sha256` on Linux,
replacing `FILE.sha256` with the downloaded checksum filename.
On Windows, run `Get-FileHash .\MagicStickMesh-windows-x64.zip -Algorithm SHA256`
in PowerShell and compare the hash with the first value in the adjacent
`.sha256` file.

CI verifies packaging contracts, the bundled transport version/checksum,
Windows native imports and macOS signature integrity. It also launches the
packaged application on each native runner, checking the local UI, authentication,
status and shutdown with disposable state. `BUILD-INFO.json` records this
`launchCheck`. It does not join a real mesh or prove end-to-end inference.
Downloads contain no invitation, saved membership or private key.
