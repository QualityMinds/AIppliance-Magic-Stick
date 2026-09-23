# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 QualityMinds GmbH. See LICENSE.
"""Private Mesh control plane. No model execution, prompts or credentials in logs.

The signed roster is authoritative; Mesh gossip is discovery, not authorization.
Only the mesh creator can enroll/revoke members. Each member owns its endpoint key.
"""
from __future__ import annotations

import base64
import contextlib
import copy
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, PublicFormat, NoEncryption

MESH_VERSION = "0.76.2"
PLUGIN_VERSION = "0.2.0"
POLICY_VERSION = 1
ROSTER_LIFETIME = 120
ROLES = {"magic-stick", "client"}
NAME = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
MODEL = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\Z")
ENDPOINT = re.compile(r"[a-f0-9]{64}\Z")
LOCAL_ENGINES = {"kubeai": {"VLLM", "OLLAMA"}, "freetoken": {"FREETOKEN"}}


def ready_local_model(model):
    """Accept only discovered, ready local runtimes, never imported/proxy names."""
    return bool(model and model.get("ready") and model.get("uid")
                and str(model.get("engine", "")).upper() in LOCAL_ENGINES.get(model.get("source"), set()))


class MeshError(Exception):
    def __init__(self, message, status=400, code="configuration_error"):
        super().__init__(message)
        self.status, self.code = status, code


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def unb64(value):
    if not isinstance(value, str) or len(value) > 65536:
        raise MeshError("Invalid encoded value.")
    try:
        return base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    except (ValueError, TypeError) as error:
        raise MeshError("Invalid encoded value.") from error


def valid_name(value, label="Name"):
    if not isinstance(value, str) or not NAME.fullmatch(value):
        raise MeshError(f"{label} must use lowercase letters, numbers and hyphens (1–63 characters).")
    return value


def valid_model(value):
    if not isinstance(value, str) or not MODEL.fullmatch(value):
        raise MeshError("Only a local model identifier can be shared.")
    return value


def integer(value, minimum, maximum, label):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise MeshError(f"{label} must be between {minimum} and {maximum}.")
    return value


def relay_config(value):
    mode = value.get("mode", "auto")
    if mode not in {"auto", "public", "custom"}:
        raise MeshError("Invalid relay mode.")
    result = {"mode": mode, "url": ""}
    if mode == "custom":
        url = str(value.get("url", ""))
        parsed = urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise MeshError("A custom relay requires an HTTPS URL without credentials.")
        result["url"] = url.rstrip("/")
    return result


def share_config(value):
    return {
        "enabled": value.get("enabled") is True,
        "maxConcurrent": integer(value.get("maxConcurrent", 2), 1, 64, "Concurrency"),
        "rpm": integer(value.get("rpm", 10), 1, 10000, "Requests per minute"),
        "tpm": integer(value.get("tpm", 64000), 1, 10000000, "Tokens per minute"),
        "maxContext": integer(value.get("maxContext", 32768), 1, 1048576, "Context"),
        "maxOutput": integer(value.get("maxOutput", 2048), 1, 131072, "Output tokens"),
        "priority": "low",
    }


class Store:
    """One persistent transactional state; secrets never returned by status()."""
    def __init__(self, path):
        self.lock = threading.RLock()
        if path != ":memory:":
            target = Path(path)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        self.db.execute("INSERT OR IGNORE INTO state VALUES (1, '{}')")
        if path != ":memory:":
            Path(path).chmod(0o600)

    def read(self):
        with self.lock:
            return json.loads(self.db.execute("SELECT value FROM state WHERE id=1").fetchone()[0])

    @contextlib.contextmanager
    def change(self):
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                state = self.read()
                yield state
                self.db.execute("UPDATE state SET value=? WHERE id=1", (canonical(state).decode(),))
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise


class Identity:
    def __init__(self, seed=None):
        self.key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(seed)) if seed else Ed25519PrivateKey.generate()

    @property
    def seed(self):
        return self.key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption()).hex()

    @property
    def endpoint(self):
        return self.key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()

    def sign(self, domain, payload):
        return b64(self.key.sign(domain.encode() + b"\0" + canonical(payload)))


def verify(public_key, domain, payload, signature):
    try:
        if not ENDPOINT.fullmatch(str(public_key)):
            raise ValueError("key")
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key)).verify(
            unb64(signature), domain.encode() + b"\0" + canonical(payload))
    except (ValueError, InvalidSignature, MeshError) as error:
        raise MeshError("Mesh authentication failed.", 401, "authentication_failed") from error


class MeshService:
    def __init__(self, store, local_models, clock=time.time, *, consume_only=False):
        self.store, self.local_models, self.clock = store, local_models, clock
        self.consume_only = consume_only
        with store.change() as state:
            state.setdefault("identity", Identity().seed)
            state.setdefault("shares", {})
            state.setdefault("invites", {})
            state.setdefault("members", {})
            state.setdefault("nonces", {})
            state.setdefault("imports", {})
            state.setdefault("relay", {"mode": "auto", "url": ""})
        self.identity = Identity(store.read()["identity"])

    def can_export(self):
        return not self.consume_only

    def require_appliance(self):
        if not self.can_export():
            raise MeshError('Consume-only clients cannot administer or export models.', 403, 'forbidden')

    def require_runtime(self):
        if self.consume_only:
            if self.store.read().get('node', {}).get('type') != 'client':
                raise MeshError('This companion can only consume mesh models.', 403)
        else:
            self.require_appliance()

    def createMesh(self, mesh_name, node_name, origin, tls_pin, relay=None, shares=None, ca_certificate=None):
        self.require_appliance()
        valid_name(mesh_name, "Mesh name")
        valid_name(node_name, "Node name")
        parsed = urlsplit(origin)
        if parsed.scheme != "https" or not parsed.hostname or parsed.path not in {"", "/"} or parsed.query or parsed.fragment or parsed.username:
            raise MeshError("Mesh enrollment requires the appliance's HTTPS address.")
        if not ENDPOINT.fullmatch(str(tls_pin)):
            raise MeshError("The enrollment certificate could not be verified.")
        selected = {}
        for name, settings in (shares or {}).items():
            self._require_local(name)
            selected[name] = share_config(settings)
        with self.store.change() as state:
            if state.get("mesh"):
                raise MeshError("Leave the current mesh before creating another.", 409)
            state["mesh"] = {"id": secrets.token_hex(16), "name": mesh_name,
                             "authority": self.identity.endpoint, "origin": origin.rstrip("/"), "tlsPin": tls_pin, "caCertificate": ca_certificate}
            state["node"] = {"name": node_name, "type": "magic-stick", "id": self.identity.endpoint}
            state["relay"] = relay_config(relay or {})
            state["shares"] = selected
            state["members"] = {self.identity.endpoint: self._member(node_name, "magic-stick")}
            state["invites"] = {}
        return self.getStatus()

    def _member(self, name, role):
        return {"name": name, "type": role, "revoked": False, "joinedAt": int(self.clock()), "lastSeen": int(self.clock()), "exports": {}}

    def _authority(self, state):
        if (state.get("mesh") or {}).get("authority") != self.identity.endpoint:
            raise MeshError("Only the mesh owner can manage membership.", 403)

    def _require_local(self, name):
        valid_model(name)
        model = self.local_models().get(name)
        # The inventory proves local Kubernetes ownership, never Mesh gossip or
        # user-supplied LiteLLM model names/API URLs.
        if not ready_local_model(model):
            raise MeshError("This model is not a ready local backend.", 409, "model_unavailable")
        return model

    def shareModel(self, name, value):
        self.require_appliance()
        self._require_local(name)
        settings = share_config(value)
        with self.store.change() as state:
            if not state.get("mesh") or state.get("node", {}).get("type") != "magic-stick":
                raise MeshError("This node cannot publish models.", 403)
            state["shares"][name] = settings
        return settings

    def unshareModel(self, name):
        valid_model(name)
        with self.store.change() as state:
            state["shares"].pop(name, None)

    def exportModels(self):
        state = self.store.read()
        if not self.can_export() or not state.get("mesh") or state.get("node", {}).get("type") != "magic-stick":
            return {}
        local = self.local_models()
        result = {}
        for name, config in state["shares"].items():
            model = local.get(name) or {}
            if config["enabled"] and ready_local_model(model):
                result[f"share/{state['node']['name']}/{name}"] = {"localModel": name, "uid": model["uid"], **config}
        return result

    def createInvite(self, role, creator, lifetime=3600):
        self.require_appliance()
        if role not in ROLES:
            raise MeshError("Unknown node type.")
        integer(lifetime, 60, 86400, "Invite lifetime")
        token, invite_id = secrets.token_urlsafe(32), secrets.token_hex(12)
        with self.store.change() as state:
            self._authority(state)
            invite = {"id": invite_id, "type": role, "creator": str(creator)[:128], "expiresAt": int(self.clock()) + lifetime,
                      "createdAt": int(self.clock()), "usedAt": None, "revoked": False, "digest": hashlib.sha256(token.encode()).hexdigest()}
            state["invites"][invite_id] = invite
            public = self._invite_public(invite)
            envelope = {"v": 1, "id": invite_id, "secret": token, "mesh": state["mesh"], "type": role, "expiresAt": invite["expiresAt"]}
        envelope["signature"] = self.identity.sign("magicstick-invite-v1", envelope)
        return {**public, "token": "msmesh1." + b64(canonical(envelope))}

    def revokeInvite(self, invite_id):
        with self.store.change() as state:
            self._authority(state)
            if invite_id not in state["invites"]:
                raise MeshError("Invite not found.", 404)
            state["invites"][invite_id]["revoked"] = True

    def revokeNode(self, endpoint):
        with self.store.change() as state:
            self._authority(state)
            if endpoint == self.identity.endpoint:
                raise MeshError("Use Leave mesh to stop the owner.")
            if endpoint not in state["members"]:
                raise MeshError("Node not found.", 404)
            state["members"][endpoint]["revoked"] = True

    def decodeInvite(self, token):
        try:
            if not token.startswith("msmesh1.") or len(token) > 16384:
                raise ValueError("format")
            invite = json.loads(unb64(token[8:]))
            signature = invite.pop("signature")
            verify(invite["mesh"]["authority"], "magicstick-invite-v1", invite, signature)
            if invite["v"] != 1 or invite["type"] not in ROLES or invite["expiresAt"] <= self.clock():
                raise ValueError("expired")
            return invite
        except (ValueError, TypeError, KeyError, AttributeError) as error:
            raise MeshError("Invalid or expired mesh invite.", 401, "authentication_failed") from error

    def enroll(self, payload):
        self.require_appliance()
        endpoint = payload.get("endpoint", "")
        if not ENDPOINT.fullmatch(endpoint):
            raise MeshError("Invalid node identity.")
        name = valid_name(payload.get("name"), "Node name")
        proof = {key: payload.get(key) for key in ("invite", "secret", "endpoint", "name")}
        verify(endpoint, "magicstick-enroll-v1", proof, payload.get("signature"))
        with self.store.change() as state:
            self._authority(state)
            invitation = state["invites"].get(payload.get("invite")) or {}
            if (invitation.get("revoked") or invitation.get("usedAt") is not None or invitation.get("expiresAt", 0) <= self.clock()
                    or not hmac.compare_digest(invitation.get("digest", ""), hashlib.sha256(str(payload.get("secret", "")).encode()).hexdigest())):
                raise MeshError("Invite is invalid, expired, revoked or already used.", 401, "authentication_failed")
            if endpoint == self.identity.endpoint or any(key != endpoint and member["name"] == name for key, member in state["members"].items()):
                raise MeshError("Node name is already registered.", 409)
            # A valid fresh invitation may re-enroll the same proven identity
            # after Leave or revocation. Its role comes from this invitation,
            # never from the old registration or the joining device.
            state["members"][endpoint] = self._member(name, invitation["type"])
            invitation["usedAt"] = int(self.clock())
        return self.signedRoster()

    def joinMesh(self, token, node_name, exchange):
        if self.store.read().get("mesh"):
            raise MeshError("Leave the current mesh before joining another.", 409)
        invite = self.decodeInvite(token)
        if self.consume_only:
            if invite['type'] != 'client':
                raise MeshError('This companion requires a Client invitation.', 403)
        else:
            self.require_appliance()
        proof = {"invite": invite["id"], "secret": invite["secret"], "endpoint": self.identity.endpoint, "name": valid_name(node_name, "Node name")}
        response = exchange(invite["mesh"], "/mesh/enroll", {**proof, "signature": self.identity.sign("magicstick-enroll-v1", proof)})
        roster = self.verifyRoster(invite["mesh"], response)
        member = roster["members"].get(self.identity.endpoint)
        if not member or member["revoked"] or member["type"] != invite["type"]:
            raise MeshError("The enrollment response does not authorize this node.", 401)
        with self.store.change() as state:
            state["mesh"] = invite["mesh"]
            state["node"] = {"id": self.identity.endpoint, "name": member["name"], "type": member["type"]}
            state["roster"] = roster
            state["relay"] = roster["relay"]
            state["shares"] = {}
        return self.getStatus()

    def signedRoster(self):
        self.require_appliance()
        exports = self.exportModels()
        with self.store.change() as state:
            self._authority(state)
            own = state["members"][self.identity.endpoint]
            own.update(lastSeen=int(self.clock()), exports=exports)
            roster = {"version": POLICY_VERSION, "meshId": state["mesh"]["id"], "issuedAt": int(self.clock()),
                      "expiresAt": int(self.clock()) + ROSTER_LIFETIME, "members": copy.deepcopy(state["members"]),
                      "relay": state["relay"], "bootstrap": state.get("bootstrap", "")}
        return {"payload": roster, "signature": self.identity.sign("magicstick-roster-v1", roster)}

    def verifyRoster(self, mesh, signed):
        payload = signed.get("payload", {})
        verify(mesh["authority"], "magicstick-roster-v1", payload, signed.get("signature"))
        if (payload.get("version") != POLICY_VERSION or payload.get("meshId") != mesh["id"]
                or not self.clock() - 10 <= payload.get("issuedAt", 0) <= self.clock() + 30
                or not self.clock() < payload.get("expiresAt", 0) <= self.clock() + ROSTER_LIFETIME + 30):
            raise MeshError("Mesh membership information expired.", 401, "authentication_failed")
        return payload

    def memberRequest(self, path, body):
        claim = {"endpoint": self.identity.endpoint, "timestamp": int(self.clock()), "nonce": secrets.token_hex(16),
                 "path": path, "body": body}
        return {"claim": claim, "signature": self.identity.sign("magicstick-member-v1", claim)}

    def heartbeat(self, request):
        self.require_appliance()
        claim = request.get("claim") or {}
        endpoint = claim.get("endpoint", "")
        verify(endpoint, "magicstick-member-v1", claim, request.get("signature"))
        with self.store.change() as state:
            self._authority(state)
            member = state["members"].get(endpoint)
            if not member or member["revoked"] or claim.get("path") != "/mesh/heartbeat" or abs(self.clock() - claim.get("timestamp", 0)) > 30:
                raise MeshError("This node is not authorized.", 403, "authentication_failed")
            nonces = {key: expiry for key, expiry in state["nonces"].items() if expiry > self.clock()}
            nonce = endpoint + ":" + str(claim.get("nonce", ""))
            if not re.fullmatch(r"[a-f0-9]{64}:[a-f0-9]{32}", nonce) or nonce in nonces:
                raise MeshError("Replayed membership request.", 401)
            nonces[nonce] = self.clock() + 60
            state["nonces"] = nonces
            exports = (claim.get("body") or {}).get("exports", {})
            if not isinstance(exports, dict) or len(exports) > 128:
                raise MeshError("Invalid model publication.")
            if member["type"] == "client" and exports:
                raise MeshError("Client nodes cannot publish models.", 403)
            prefix = "share/" + member["name"] + "/"
            for model_id, settings in exports.items():
                if not model_id.startswith(prefix) or not MODEL.fullmatch(model_id[len(prefix):]):
                    raise MeshError("A node can publish only its own local models.", 403)
                share_config(settings)
            member.update(lastSeen=int(self.clock()), exports=exports)
        return self.signedRoster()

    def refreshMembership(self, exchange):
        state = self.store.read()
        if not state.get("mesh"):
            return
        self.require_runtime()
        if state["mesh"]["authority"] == self.identity.endpoint:
            roster = self.signedRoster()["payload"]
        else:
            response = exchange(state["mesh"], "/mesh/heartbeat", self.memberRequest("/mesh/heartbeat", {"exports": self.exportModels()}))
            roster = self.verifyRoster(state["mesh"], response)
            member = roster["members"].get(self.identity.endpoint)
            if not member or member["revoked"]:
                raise MeshError("Mesh membership has been revoked.", 403)
        with self.store.change() as current:
            current["roster"] = roster

    def activeRoster(self):
        state = self.store.read()
        roster = state.get("roster", {})
        return roster if roster.get("expiresAt", 0) > self.clock() else {}

    def policy(self):
        roster = self.activeRoster()
        members = {key: value for key, value in roster.get("members", {}).items() if not value["revoked"]}
        return {"version": POLICY_VERSION, "expires_at": roster.get("expiresAt", 0), "members": members}

    def setRelayConfig(self, config):
        self.require_runtime()
        normalized = relay_config(config)
        with self.store.change() as state:
            state["relay"] = normalized
        return normalized

    def getRelayConfig(self):
        return self.store.read()["relay"]

    def leaveMesh(self):
        with self.store.change() as state:
            for key in ("mesh", "node", "roster", "bootstrap"):
                state.pop(key, None)
            state.update(shares={}, imports={}, members={}, invites={})

    def _invite_public(self, invite):
        return {key: value for key, value in invite.items() if key != "digest"}

    def getStatus(self):
        state, roster = self.store.read(), self.activeRoster()
        now = self.clock()
        nodes = [{"id": key, **value, "online": not value["revoked"] and value["lastSeen"] + 60 > now}
                 for key, value in roster.get("members", state.get("members", {})).items()]
        return {"configured": bool(state.get("mesh")), "mesh": state.get("mesh"), "node": state.get("node"),
                "authority": (state.get("mesh") or {}).get("authority") == self.identity.endpoint,
                "nodes": nodes, "invites": [self._invite_public(value) for value in state["invites"].values()],
                "shares": state["shares"], "models": [name for name, model in self.local_models().items()
                    if ready_local_model(model)], "imports": list(state["imports"]),
                "relay": state["relay"], "membershipValid": bool(roster), "meshVersion": MESH_VERSION}
