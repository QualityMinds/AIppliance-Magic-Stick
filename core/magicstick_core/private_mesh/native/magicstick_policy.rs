// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 QualityMinds GmbH. See LICENSE.
//! Magic Stick's opt-in, fail-closed endpoint/role boundary.
//! A locally verified, short-lived signed roster produces this policy file.
//! The file is read for every stream/routing decision, including existing peers.
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use serde::Deserialize;
use crate::mesh::{NodeRole, PeerAnnouncement};
use iroh::EndpointId;

#[derive(Deserialize)]
struct Member {
    #[serde(rename = "type")]
    role: String,
    name: String,
    revoked: bool,
    #[serde(default)]
    exports: HashMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct Policy {
    version: u32,
    expires_at: u64,
    members: HashMap<String, Member>,
}

pub(crate) fn enabled() -> bool {
    std::env::var_os("MAGICSTICK_MESH_POLICY").is_some()
}

fn policy() -> Option<Policy> {
    let file = std::env::var_os("MAGICSTICK_MESH_POLICY")?;
    let metadata = std::fs::metadata(&file).ok()?;
    if metadata.len() > 1024 * 1024 { return None; }
    let value: Policy = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    (value.version == 1 && value.expires_at > now).then_some(value)
}

fn member(id: EndpointId) -> Option<Member> {
    let mut value = policy()?;
    let member = value.members.remove(&hex::encode(id.as_bytes()))?;
    (!member.revoked && matches!(member.role.as_str(), "magic-stick" | "client")).then_some(member)
}

pub(crate) fn can_serve(id: EndpointId) -> bool {
    !enabled() || member(id).is_some_and(|m| m.role == "magic-stick")
}

pub(crate) fn allow_stream(id: EndpointId, kind: u8) -> bool {
    if !enabled() { return true; }
    // No owner control, config transfer, plugin channel, arbitrary TCP, model
    // file transfer, distributed workers or native-runtime execution surface.
    matches!(kind, 0x01 | 0x04 | 0x06 | 0x07 | 0x0e) && member(id).is_some()
}

pub(crate) fn announcement(id: EndpointId, ann: &PeerAnnouncement) -> bool {
    let Some(member) = member(id) else { return false; };
    let announced = ann.serving_models.iter()
        .chain(ann.hosted_models.iter().flatten())
        .chain(ann.served_model_descriptors.iter().map(|d| &d.identity.model_name));
    if member.role == "client" {
        return matches!(ann.role, NodeRole::Client) && announced.count() == 0
            && ann.available_models.is_empty();
    }
    let prefix = format!("share/{}/", member.name);
    announced.into_iter().all(|name| name.starts_with(&prefix) && member.exports.contains_key(name))
}

/// Attach authenticated QUIC identity, never a caller-supplied header. The
/// fixed bridge closes each HTTP connection after one request, preventing a
/// pipelined request from inheriting the first request's identity.
pub(crate) fn bridge_prefix(prefix: &[u8], remote: EndpointId) -> anyhow::Result<Vec<u8>> {
    let end = prefix.windows(4).position(|p| p == b"\r\n\r\n")
        .ok_or_else(|| anyhow::anyhow!("incomplete HTTP headers"))?;
    let header = std::str::from_utf8(&prefix[..end])?;
    let mut lines = header.split("\r\n");
    let first = lines.next().ok_or_else(|| anyhow::anyhow!("missing HTTP request"))?;
    let mut result = format!("{first}\r\n");
    for line in lines {
        let (key, _) = line.split_once(':').ok_or_else(|| anyhow::anyhow!("malformed HTTP header"))?;
        if key.chars().any(char::is_whitespace) { anyhow::bail!("invalid HTTP header"); }
        if key.to_ascii_lowercase().starts_with("x-magicstick-") || key.eq_ignore_ascii_case("connection") {
            continue;
        }
        result.push_str(line);
        result.push_str("\r\n");
    }
    let secret = std::env::var("MAGICSTICK_BRIDGE_TOKEN")?;
    if !secret.bytes().all(|b| b.is_ascii_alphanumeric()) || secret.len() < 32 {
        anyhow::bail!("invalid internal bridge credential");
    }
    result.push_str(&format!("X-MagicStick-Peer: {}\r\nX-MagicStick-Bridge: {}\r\nConnection: close\r\n\r\n", hex::encode(remote.as_bytes()), secret));
    let mut bytes = result.into_bytes();
    bytes.extend_from_slice(&prefix[end + 4..]);
    Ok(bytes)
}
