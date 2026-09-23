# Private Mesh administration

## Private Mesh operation

Use **System → Settings → Mesh** for membership, invitations and per-model sharing.
To join an existing mesh, use **Join Mesh** with a fresh **Magic Stick** invitation
from its owner. This action remains visible after setup. The dialog guides module
activation when needed and requires an explicit leave before switching meshes;
canceling before confirmation preserves membership. Leaving an owner disconnects its members once
their authorization leases expire. Local models keep running.
Ready local chat models from vLLM, Ollama and FreeToken can all be shared. Models
must first be running under **Models**; external providers and imported Mesh
routes are not eligible. Ollama and FreeToken use the same remote request limits
without vLLM-specific scheduling parameters. Deploy the updated Mesh image,
discovery RBAC and dashboard together when upgrading this capability.
No license file is needed for Private Mesh. Membership, expiring signed rosters
and per-model access rules protect mesh traffic. Use the same page for
connection status and remote limits. The module defaults off. Local models keep
running independently of mesh availability. Leave the mesh before disabling its
module so owned LiteLLM routes and keys are removed. Back up the retained state
PVC and service Secret securely. See [Private Mesh operations and troubleshooting](private-mesh.md#lifecycle-data-and-observability),
including creator HTTPS reachability and the two-minute authorization lease.

## Private membership and relay trust

Upstream MeshLLM does not provide the application's exact infrastructure/client
roles. This integration therefore adds a small, pinned **native transport
policy**, not merely UI restrictions:

- Each device has its own persisted Ed25519/Iroh endpoint identity.
- Upstream's ephemeral client-key behavior is disabled for this private
  embedding; laptop transport uses the exact identity proved at enrollment.
- The creator is the membership authority. It signs expiring invitations and a
  short-lived roster mapping endpoint identities to roles and allowed exports.
- Enrollment consumes an invitation transactionally and requires proof of the
  joining endpoint's private key. Heartbeats are signed, time-bounded and
  replay-protected. Clients cannot publish models or mint invitations.
- TLS hostname and pinned appliance-CA verification complete before invitation
  secrets are sent. Native bootstrap tokens alone grant no membership.
- The policy checks authenticated QUIC peers on new connections and streams.
  Native owner administration, stage/distributed workers, file transfer and
  arbitrary plugin streams are disabled in this embedding.
- Client announcements cannot advertise models. Infrastructure announcements
  must match the signed exports. Incoming inference is sent to a fixed loopback
  bridge, **never back into Mesh's routing engine**.
- Caller-supplied peer/bridge headers are removed and replaced with authenticated
  transport identity. The bridge closes the HTTP connection after one request.
- Rosters refresh every five seconds and expire after two minutes. Authority loss
  eventually denies new mesh requests; existing local inference remains usable.

**The creator's HTTPS dashboard address must be reachable by all members.**
Its two enrollment/heartbeat paths are authenticated by application proofs, not
interactive browser login. A local-only `.local` address is suitable only where
all devices can resolve/reach it. Iroh's relay transports inference; it does not
make this HTTPS control-plane endpoint reachable through arbitrary NAT. Cross-
network onboarding therefore requires an already reachable appliance address
(for example via the organization's network/VPN). No router port changes or
public mesh discovery are performed automatically.

Auto and Public relay both use Iroh's shipped public relay set with direct-path
upgrades. Custom relay accepts an HTTPS relay URL. Relay connectivity is not
membership authorization, and UI connection status comes from transport path
diagnostics rather than from the selected relay preference.

## Lifecycle, data and observability

The `private-mesh` module defaults off and depends on the existing dashboard,
LiteLLM and model-catalog modules. It uses one small Deployment, a persistent
SQLite volume, generated service credentials and read-only discovery RBAC for
KubeAI Models in `ai` and ModelActivations in `ai-system`. The current appliance build targets Linux amd64. No extra database or
identity service is added to the appliance.

The native binary checksum is verified before startup. Only the isolated runtime
environment is inherited by child processes. Config/key files are private.
Native inference initialization is disabled in this endpoint-only embedding;
explicit native model configuration is rejected rather than loaded or downloaded.
Changes to relay settings restart the transport; refreshed bootstrap address
hints alone do not. Failed child processes are restarted with a delay.

Model disappearance grace defaults to 120 seconds; advanced deployments may set
`MESH_MODEL_GRACE_SECONDS` between 5 and 3600. Trust expiry and explicit unshare/
revocation deny inference independently of this display/routing grace period.

Status includes online devices, component states, direct/relay path, incoming
and outgoing request/error/active counters, per-peer/model export activity and
completed LiteLLM backend attempts. Backend attempts include retries/fallbacks,
not just end-user requests. Counters reset on restart. Queue length is zero
because the bridge rejects rather than queues. Prompt/response logging is off;
default diagnostics do not include credentials or content.

Use **Leave mesh** before disabling the module so owned LiteLLM routes and keys
are reconciled away. Forced removal may leave unreachable imported aliases or
keys until re-enable/cleanup; it does not authorize the now-absent bridge. The
state PVC and generated service Secret are retained, like other keep-data
modules. Back them up securely together; they contain identities and scoped keys.
