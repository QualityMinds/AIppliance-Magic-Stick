# SPDX-License-Identifier: BUSL-1.1
# Copyright (c) 2026 QualityMinds GmbH. See LICENSE.
"""LiteLLM model/key reconciliation and the restricted export data plane."""
from __future__ import annotations

import contextlib
import hashlib
import json
import threading
import time
import uuid
from collections import defaultdict, deque
from urllib import error, request

from mesh_service import LOCAL_ENGINES, MeshError, canonical, ready_local_model


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise MeshError("Unexpected upstream redirect.", 502, "upstream_unavailable")


def json_request(url, method="GET", body=None, token=None, timeout=15):
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        with request.build_opener(NoRedirect()).open(request.Request(url, canonical(body) if body is not None else None, headers, method=method), timeout=timeout) as response:
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise MeshError("Upstream response exceeds the safety limit.", 502)
            return json.loads(raw) if raw else {}
    except error.HTTPError as exc:
        # Never propagate an upstream body: it may contain prompts or keys.
        raise MeshError("Upstream request failed.", 503 if exc.code >= 500 else exc.code, "upstream_unavailable") from None
    except (error.URLError, TimeoutError, ValueError) as exc:
        raise MeshError("Upstream is unavailable.", 503, "upstream_unavailable") from None


class LiteLLM:
    def __init__(self, base_url, master_key):
        self.base = base_url.rstrip("/")
        self._key = master_key

    def admin(self, method, path, body=None):
        return json_request(self.base + path, method, body, self._key)

    def deployments(self):
        return self.admin("GET", "/model/info").get("data", [])

    def new_key(self, model, config):
        # key_type=llm_api would overwrite allowed_routes with the broad
        # llm_api_routes bucket in LiteLLM 1.84.0. Keep the explicit chat list.
        payload = {"user_id": None, "models": [model], "key_type": "default",
                   "key_alias": "magicstick-private-mesh-export", "duration": "24h",
                   "allowed_routes": ["/v1/chat/completions", "/chat/completions"],
                   "rpm_limit": config["rpm"], "tpm_limit": config["tpm"],
                   "max_parallel_requests": config["maxConcurrent"],
                   "metadata": {"magicstick_traffic_class": "MESH_REMOTE"}}
        # Proxy-admin creates a null-user service key, never an admin-owned key.
        result = self.admin("POST", "/key/generate", payload)
        if (not result.get("key") or result.get("user_id") is not None
                or result.get("models") != [model]
                or set(result.get("allowed_routes") or []) != set(payload["allowed_routes"])):
            if result.get("key"):
                self.admin("POST", "/key/delete", {"keys": [result["key"]]})
            raise MeshError("LiteLLM did not create a restricted service key.", 503)
        return result["key"]


class ModelSync:
    def __init__(self, service, litellm, mesh_models, kubeai_base, import_base, import_key, grace=120):
        self.service, self.litellm, self.mesh_models = service, litellm, mesh_models
        self.kubeai_base, self.import_base, self.import_key = kubeai_base, import_base, import_key
        self.grace = grace
        self.lock = threading.RLock()
        self.last_error, self.last_success = None, None

    def _deployment(self, name, backend, base, source, api_key="none", order=0, engine=None):
        owner = self.service.identity.endpoint
        payload = {"model_name": name,
                   "litellm_params": {"model": "openai/" + backend, "api_base": base, "api_key": api_key, "order": order},
                   "model_info": {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, owner + ":" + name + ":" + backend)),
                                  "magicstick_mesh_owner": owner, "source": source, "ai_appliance_type": "chat",
                                  "magicstick_vllm_priority": str(engine).upper() == "VLLM" and source in {"local", "mesh-export"}, "order": order}}
        payload["model_info"]["magicstick_mesh_fingerprint"] = hashlib.sha256(canonical(payload)).hexdigest()
        return payload

    def reconcile(self):
        with self.lock:
            return self._reconcile()

    def _reconcile(self):
        service = self.service
        state = service.store.read()
        exports = service.exportModels()
        now = service.clock()
        can_export = service.can_export()
        roster = service.activeRoster() if can_export else {}
        own_id = service.identity.endpoint
        authorized = {}
        for node, member in roster.get("members", {}).items():
            if node == own_id or member["revoked"] or member["type"] != "magic-stick":
                continue
            for name in member.get("exports", {}):
                prefix = "share/" + member["name"] + "/"
                if name.startswith(prefix) and "/" not in name[len(prefix):]:
                    authorized[name] = member["name"]
        try:
            discovered = {item["id"] for item in self.mesh_models().get("data", []) if isinstance(item.get("id"), str)} if state.get("mesh") else set()
            self.last_error = None
        except MeshError:
            discovered = set()
            self.last_error = "mesh_unavailable"
        desired = {}
        if state.get("mesh") and state.get("node", {}).get("type") == "magic-stick":
            local = service.local_models()
            for name, backend in local.items():
                if ready_local_model(backend):
                    base = backend["apiBase"] if backend["source"] == "freetoken" else self.kubeai_base
                    desired["local/" + name] = self._deployment("local/" + name, name, base, "local", engine=backend["engine"])
            for share in exports:
                name = exports[share]["localModel"]
                backend = local.get(name)
                if ready_local_model(backend):
                    base = backend["apiBase"] if backend["source"] == "freetoken" else self.kubeai_base
                    desired[share] = self._deployment(share, name, base, "mesh-export", engine=backend["engine"])
        with service.store.change() as current:
            imports = current["imports"]
            for remote in discovered.intersection(authorized):
                alias = "mesh/" + remote[len("share/"):]
                imports[alias] = {"remote": remote, "lastSeen": now, "missingSince": None, "node": authorized[remote]}
            for alias, entry in list(imports.items()):
                remote = entry["remote"]
                if remote not in discovered:
                    if entry.get("missingSince") is None:
                        entry["missingSince"] = now
                if not can_export or not state.get("mesh") or (roster and remote not in authorized) or (entry.get("missingSince") is not None and now - entry["missingSince"] >= self.grace):
                    del imports[alias]
                    continue
                desired[alias] = self._deployment(alias, remote, self.import_base, "mesh-import", self.import_key, 1)
        try:
            existing = self.litellm.deployments()
            # LiteLLM's native order-based routing provides logical <model>
            # groups. The existing catalog owns order-0 local deployments;
            # this reconciler owns only order-1 remote fallback deployments.
            # Explicit local/ and mesh/<node>/ aliases remain deterministic.
            occupied_models = {}
            for model in existing:
                if model.get("model_info", {}).get("magicstick_mesh_owner") != own_id:
                    occupied_models.setdefault(model.get("model_name"), []).append(model)
            for alias, entry in service.store.read()["imports"].items():
                name = entry["remote"].rsplit("/", 1)[-1]
                others = occupied_models.get(name, [])
                if others and not all(m.get("model_info", {}).get("ai_appliance_source") in LOCAL_ENGINES
                                      and m.get("model_info", {}).get("ai_appliance_managed") is True
                                      and m.get("model_info", {}).get("order") == 0 for m in others):
                    # Never replace an external provider or an unowned route.
                    continue
                desired["logical:" + alias] = self._deployment(name, entry["remote"], self.import_base, "mesh-import", self.import_key, 1)
            owned = {m.get("model_info", {}).get("id"): m for m in existing if m.get("model_info", {}).get("magicstick_mesh_owner") == own_id}
            occupied = {m.get("model_name") for m in existing if m.get("model_info", {}).get("magicstick_mesh_owner") != own_id}
            for name, deployment in desired.items():
                if not name.startswith("logical:") and name in occupied:
                    raise MeshError("A model namespace conflicts with an existing route.", 409)
                old = owned.get(deployment["model_info"]["id"])
                if old and old.get("model_info", {}).get("magicstick_mesh_fingerprint") == deployment["model_info"]["magicstick_mesh_fingerprint"]:
                    continue
                self.litellm.admin("POST", "/model/update" if old else "/model/new", deployment)
            wanted_ids = {d["model_info"]["id"] for d in desired.values()}
            for model_id in owned.keys() - wanted_ids:
                self.litellm.admin("POST", "/model/delete", {"id": model_id})
            self._keys(exports)
            self.last_success = now
        except MeshError:
            self.last_error = "litellm_unavailable"
            raise
        return desired

    def _keys(self, exports):
        now = self.service.clock()
        with self.service.store.change() as state:
            keys = state.setdefault("exportKeys", {})
            for name, value in list(keys.items()):
                fingerprint = hashlib.sha256(canonical(exports.get(name))).hexdigest()
                if name in exports and value["fingerprint"] == fingerprint and value["expiresAt"] > now + 600:
                    continue
                # Remove the stale key before introducing a replacement. If the
                # provider is down, the bridge's live allowlist still denies it.
                try:
                    self.litellm.admin("POST", "/key/delete", {"keys": [value["key"]]})
                except MeshError as exc:
                    if exc.status != 404:
                        raise
                del keys[name]
            for name, config in exports.items():
                if name not in keys:
                    keys[name] = {"key": self.litellm.new_key(name, config), "expiresAt": now + 86400,
                                  "fingerprint": hashlib.sha256(canonical(config)).hexdigest()}


class ExportBridge:
    # The transport supplies an authenticated endpoint id. HTTP clients cannot
    # forge it: the native adapter removes their identity headers first.
    def __init__(self, service, litellm_base, token, clock=time.monotonic):
        self.service, self.base, self._token, self.clock = service, litellm_base.rstrip("/"), token, clock
        self.lock = threading.RLock()
        self.active, self.windows = defaultdict(int), defaultdict(deque)
        self.metrics = {"requests": 0, "errors": 0, "active": 0, "queue": 0, "latencySeconds": 0.0}
        self.by_peer_model = {}

    def activity(self):
        with self.lock:
            return [dict(row) for row in self.by_peer_model.values()]

    def authorize(self, internal_token, peer):
        import hmac
        if not isinstance(internal_token, str) or not hmac.compare_digest(internal_token, self._token):
            raise MeshError("Export authentication failed.", 401, "authentication_failed")
        self.service.require_appliance()
        member = self.service.activeRoster().get("members", {}).get(peer)
        if not member or member["revoked"] or member["type"] not in {"magic-stick", "client"}:
            raise MeshError("Mesh node is not authorized.", 403, "authentication_failed")

    def models(self):
        return {"object": "list", "data": [{"id": model, "object": "model", "owned_by": "private-mesh"} for model in self.service.exportModels()]}

    def prepare(self, payload):
        if not isinstance(payload, dict):
            raise MeshError("Invalid chat request.")
        model = payload.get("model")
        exports = self.service.exportModels()
        if not isinstance(model, str) or model not in exports:
            raise MeshError("This model is not shared by this node.", 404, "model_unavailable")
        config = exports[model]
        allowed = {"model", "messages", "stream", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "seed", "tools", "tool_choice", "response_format", "presence_penalty", "frequency_penalty"}
        # No URLs, API keys, metadata, arbitrary extra_body, priority or fallbacks.
        clean = {key: value for key, value in payload.items() if key in allowed}
        messages = clean.get("messages")
        if not isinstance(messages, list) or not 1 <= len(messages) <= 256:
            raise MeshError("Provide 1–256 chat messages.")
        for message in messages:
            if not isinstance(message, dict) or not isinstance(message.get("content", ""), (str, type(None))):
                raise MeshError("Private mesh currently supports text chat, not media attachments.")
        output = clean.pop("max_completion_tokens", clean.get("max_tokens", config["maxOutput"]))
        if isinstance(output, bool) or not isinstance(output, int) or output < 1 or output > config["maxOutput"]:
            raise MeshError("Requested output exceeds the mesh output limit.", 400, "token_limit")
        # Fail-safe text budget: UTF-8 bytes plus chat/template allowance. Never
        # claim a tokenizer-independent exact count or silently truncate prompts.
        estimated = len(canonical(messages)) + len(canonical(clean.get("tools", []))) + 256 * len(messages) + output
        if estimated > config["maxContext"]:
            raise MeshError("Request exceeds the mesh context budget.", 413, "context_limit")
        clean["max_tokens"] = output
        key = self.service.store.read().get("exportKeys", {}).get(model)
        if not key or key["expiresAt"] <= self.service.clock():
            raise MeshError("Export credentials are not ready.", 503, "litellm_unavailable")
        return model, config, clean, key["key"], estimated

    @contextlib.contextmanager
    def reserve(self, model, config, tokens, peer=None):
        started = self.clock()
        with self.lock:
            window = self.windows[model]
            while window and window[0][0] <= started - 60:
                window.popleft()
            if self.active[model] >= config["maxConcurrent"] or len(window) >= config["rpm"] or sum(item[1] for item in window) + tokens > config["tpm"]:
                raise MeshError("Shared capacity is busy; retry shortly.", 429, "rate_limited")
            window.append((started, tokens))
            self.active[model] += 1
            self.metrics["requests"] += 1
            self.metrics["active"] += 1
            label = (peer, model)
            if label not in self.by_peer_model and len(self.by_peer_model) >= 512:
                label = (None, 'other')
            activity = self.by_peer_model.setdefault(label, {"peer": label[0], "model": label[1], "requests": 0, "errors": 0, "active": 0, "latencySeconds": 0.0})
            activity['requests'] += 1
            activity['active'] += 1
        try:
            yield
        except BaseException:
            with self.lock:
                self.metrics["errors"] += 1
                activity['errors'] += 1
            raise
        finally:
            with self.lock:
                self.active[model] -= 1
                self.metrics["active"] -= 1
                self.metrics["latencySeconds"] += self.clock() - started
                activity['active'] -= 1
                activity['latencySeconds'] += self.clock() - started

    def open(self, body, key):
        headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json", "Accept": "text/event-stream" if body.get("stream") else "application/json"}
        try:
            return request.build_opener(NoRedirect()).open(request.Request(self.base + "/v1/chat/completions", canonical(body), headers, method="POST"), timeout=120)
        except error.HTTPError as exc:
            raise MeshError("The shared model rejected the request.", exc.code if exc.code in {400, 429} else 503, "model_unavailable") from None
        except (error.URLError, TimeoutError):
            raise MeshError("LiteLLM or the shared model is unavailable.", 503, "model_unavailable") from None
