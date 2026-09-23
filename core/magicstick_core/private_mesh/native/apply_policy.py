# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 QualityMinds GmbH. See LICENSE.
"""Build-time, exact-source transformations for MeshLLM v0.76.2 only.

Not a runtime monkeypatch: the pinned source is compiled with these changes.
Any upstream drift is a hard build failure, never a best-effort security patch.
"""
from pathlib import Path
import shutil
import subprocess
import sys

PIN = "a0c1e66b0ac037dd56544b9e2d94969ea43d694f"
root = Path(sys.argv[1]).resolve()
if subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip() != PIN:
    raise SystemExit("Unsupported MeshLLM source revision")
src = root / "crates/mesh-llm-host-runtime/src"


def replace(file, before, after):
    path = src / file
    text = path.read_text()
    if text.count(before) != 1:
        raise SystemExit(f"Security patch anchor changed: {file}")
    path.write_text(text.replace(before, after))


shutil.copyfile(Path(__file__).with_name("magicstick_policy.rs"), src / "magicstick_policy.rs")
with (src / "lib.rs").open("a") as stream:
    stream.write("\n// Private Magic Stick embedding: not active in standalone upstream mode.\npub(crate) mod magicstick_policy;\n")
replace("lib.rs", "    !options.client && options.plugin.is_none()",
        "    !crate::magicstick_policy::enabled() && !options.client && options.plugin.is_none()")
replace("mesh/node/startup.rs", "pub(super) async fn startup_secret_key(role: &NodeRole) -> Result<SecretKey> {",
        """pub(super) async fn startup_secret_key(role: &NodeRole) -> Result<SecretKey> {
    // Upstream clients use ephemeral identities. Private enrolled clients must
    // instead prove the persistent endpoint named in their signed membership.
    if crate::magicstick_policy::enabled() { return load_or_create_key().await; }""")
replace("runtime/startup_models.rs", "    validate_runtime_cli_model_options(options)?;\n    let startup_specs =",
        """    validate_runtime_cli_model_options(options)?;
    if crate::magicstick_policy::enabled() {
        // This embedding is a transport for the fixed LiteLLM Export Bridge,
        // never a second model runtime. Refuse native inference configuration.
        anyhow::ensure!(!cli_has_explicit_models(options) && config.models.is_empty()
            && !options.split && !options.local_model_only,
            "native model execution is disabled in the private embedding");
    }
    let startup_specs =""")
replace("mesh/peer_state.rs",
        "    match policy {\n        TrustPolicy::Off | TrustPolicy::PreferOwned => true,",
        "    if crate::magicstick_policy::enabled() { return owner_summary.verified; }\n    match policy {\n        TrustPolicy::Off | TrustPolicy::PreferOwned => true,")
replace("mesh/peer_state.rs", "        matches!(self.role, NodeRole::Host { .. })",
        "        matches!(self.role, NodeRole::Host { .. }) && crate::magicstick_policy::can_serve(self.id)")
replace("mesh/gossip.rs",
        "    ) -> OwnershipSummary {\n        let trust_store = self.trust_store.lock().await.clone();",
        "    ) -> OwnershipSummary {\n        if crate::magicstick_policy::enabled() {\n            let valid = crate::magicstick_policy::announcement(id, ann);\n            return OwnershipSummary { verified: valid, status: if valid { mesh_llm_identity::OwnershipStatus::Verified } else { mesh_llm_identity::OwnershipStatus::UntrustedOwner }, ..Default::default() };\n        }\n        let trust_store = self.trust_store.lock().await.clone();")
replace("mesh/gossip.rs", "        let trust_store = self.trust_store.lock().await.clone();\n        let owner_summary = verify_node_ownership(\n            ann.owner_attestation.as_ref(),\n            id.as_bytes(),\n            &trust_store,\n            self.trust_policy,\n            current_time_unix_ms(),\n        );",
        "        let owner_summary = self.direct_peer_owner_summary(id, ann).await;")
replace("mesh/connections/inbound.rs", "        let capture_streams = self.swarm_capture_enabled();\n        if stream_allowed_before_admission(stream_type, self.trust_policy) {",
        "        if !crate::magicstick_policy::allow_stream(remote, stream_type) { return None; }\n        let capture_streams = self.swarm_capture_enabled();\n        if stream_allowed_before_admission(stream_type, self.trust_policy) {")
replace("mesh/connections/inbound.rs", "        if self.handle_stage_alpn(&alpn, conn.clone(), remote).await {",
        """        if crate::magicstick_policy::enabled() &&
            (alpn.as_slice() != ALPN_V1 || !crate::magicstick_policy::allow_stream(remote, 0x01)) {
            conn.close(0u32.into(), b"private mesh only");
            return Ok(());
        }
        if self.handle_stage_alpn(&alpn, conn.clone(), remote).await {""")
replace("mesh/connections/inbound.rs", "        if alpn.as_slice() != ALPN_CONTROL_V1 {",
        """        if crate::magicstick_policy::enabled() {
            anyhow::bail!("owner control is disabled in the private embedding");
        }
        if alpn.as_slice() != ALPN_CONTROL_V1 {""")
replace("network/tunnel/inbound_http.rs", "    if let Some(ingress) = ingress {",
        """    if crate::magicstick_policy::enabled() {
        if !crate::magicstick_policy::allow_stream(remote, 0x04) { anyhow::bail!("peer denied"); }
        let prefix = crate::magicstick_policy::bridge_prefix(&prefix, remote)?;
        // Fixed loopback destination. Never use Mesh's model-routing ingress for
        // incoming requests; this makes Mesh -> LiteLLM -> Mesh loops impossible.
        let port: u16 = std::env::var("MAGICSTICK_BRIDGE_PORT")?.parse()?;
        let mut tcp_stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await?;
        tcp_stream.set_nodelay(true)?;
        tcp_stream.write_all(&prefix).await?;
        let (tcp_read, tcp_write) = tokio::io::split(tcp_stream);
        return super::relay_bidirectional(tcp_read, tcp_write, quic_send, quic_recv).await;
    }
    if let Some(ingress) = ingress {""")
