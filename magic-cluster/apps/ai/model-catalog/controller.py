#!/usr/bin/env python3
import base64
import copy
import datetime
import hashlib
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

NAMESPACE = os.environ.get("NAMESPACE", "ai")
APPLIANCE_NAMESPACE = os.environ.get("APPLIANCE_NAMESPACE", "ai-system")
LITELLM_BASE_URL = os.environ.get("LITELLM_BASE_URL", "http://litellm.ai.svc.cluster.local:4000").rstrip("/")
LITELLM_API_BASE = os.environ.get("LITELLM_API_BASE", LITELLM_BASE_URL + "/v1").rstrip("/")
KUBEAI_API_BASE = os.environ.get("KUBEAI_API_BASE", "http://kubeai.ai.svc.cluster.local/openai/v1").rstrip("/")
CATALOG_CONFIGMAP = os.environ.get("CATALOG_CONFIGMAP", "ai-model-catalog")
EXTERNAL_MODELS_CONFIGMAP = os.environ.get("EXTERNAL_MODELS_CONFIGMAP", "ai-external-models")
POLL_SECONDS = int(os.environ.get("CATALOG_POLL_SECONDS", "30"))
WATCH_SECONDS = int(os.environ.get("CATALOG_WATCH_SECONDS", str(max(1, POLL_SECONDS // 2))))
DEFAULT_CHAT_MODEL = os.environ.get("AI_APPLIANCE_DEFAULT_CHAT_MODEL", "auto")
DEFAULT_EMBEDDING_MODEL = os.environ.get("AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL", "auto")
OPENCODE_DEFAULT_CONTEXT_TOKENS = max(1, int(os.environ.get("OPENCODE_DEFAULT_CONTEXT_TOKENS", "8192")))
OPENCODE_DEFAULT_OUTPUT_TOKENS = max(1, int(os.environ.get("OPENCODE_DEFAULT_OUTPUT_TOKENS", "2048")))
PAPERCLIP_OPENCODE_MAX_OUTPUT_TOKENS = max(
    1, int(os.environ.get("PAPERCLIP_OPENCODE_MAX_OUTPUT_TOKENS", "4096"))
)
PAPERCLIP_OPENCODE_CONTEXT_HEADROOM_TOKENS = max(
    0, int(os.environ.get("PAPERCLIP_OPENCODE_CONTEXT_HEADROOM_TOKENS", "4096"))
)
OPENCLAW_SMALL_CONTEXT_MAX_TOKENS = 32768
OPENCLAW_SMALL_CONTEXT_KEEP_RECENT_MAX_TOKENS = 4096
OPENCLAW_DEFAULT_KEEP_RECENT_TOKENS = 20000
OPENCLAW_TOOLS_PROFILE = "coding"
RESTART_CONSUMERS = os.environ.get("CONSUMER_RESTART_ENABLED", "true").lower() == "true"
SYNC_AGENT_TEMPLATES = os.environ.get("AGENT_TEMPLATE_SYNC_ENABLED", "true").lower() == "true"
AGENT_TEMPLATE_NAMES = [name.strip() for name in os.environ.get("AGENT_TEMPLATE_NAMES", "litellm-default").split(",") if name.strip()]
AGENT_TEMPLATE_APPINSTANCE_LABEL = "appliance.magicstick.dev/appinstance"
PREFERRED_MODEL_ANNOTATION = "ai-appliance.io/preferred-model"
CONSUMER_ANNOTATION = "ai-appliance.io/model-catalog-consumer"
CATALOG_HASH_ANNOTATION = "ai-appliance.io/catalog-hash"
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
DEFAULT_CONSUMER_SELECTORS = (
    {"app": "anything-llm"},
    {"app.kubernetes.io/instance": "hermes", "app.kubernetes.io/name": "hermes-agent"},
    {"app.kubernetes.io/instance": "openclaw", "app.kubernetes.io/name": "openclaw"},
    {"app.kubernetes.io/instance": "paperclip", "app.kubernetes.io/component": "server"},
)

KUBE_API = os.environ.get("KUBERNETES_SERVICE_URL", "https://kubernetes.default.svc")
SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
SA_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"


def log(message):
    print(utc_now() + " " + message, flush=True)


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def json_dumps(value):
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def deep_merge(base, overlay):
    result = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def k8s_token():
    with open(SA_TOKEN_PATH, "r", encoding="utf-8") as token_file:
        return token_file.read().strip()


K8S_SSL = ssl.create_default_context(cafile=SA_CA_PATH)


def k8s_request(method, path, body=None, ok=(200, 201, 202)):
    url = KUBE_API + path
    data = None
    headers = {
        "Accept": "application/json",
        "Authorization": "Bearer " + k8s_token(),
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=20, context=K8S_SSL) as response:
            payload = response.read().decode("utf-8")
            if response.status not in ok:
                raise RuntimeError(f"{method} {path} returned {response.status}: {payload}")
            return json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", errors="replace")
        if error.code in ok:
            return json.loads(payload) if payload else {}
        raise RuntimeError(f"{method} {path} returned {error.code}: {payload}") from error


def path_with_query(path, query):
    separator = "&" if "?" in path else "?"
    return path + separator + urllib.parse.urlencode(query)


def k8s_watch(path, description, query=None):
    list_query = query or {}
    try:
        listed = k8s_request("GET", path_with_query(path, list_query) if list_query else path)
    except RuntimeError as error:
        log("watch unavailable for " + description + ": " + str(error))
        return False
    resource_version = ((listed.get("metadata") or {}).get("resourceVersion") or "").strip()
    watch_query = dict(list_query)
    watch_query.update({
        "allowWatchBookmarks": "true",
        "timeoutSeconds": str(WATCH_SECONDS),
        "watch": "true",
    })
    if resource_version:
        watch_query["resourceVersion"] = resource_version

    request = urllib.request.Request(
        KUBE_API + path_with_query(path, watch_query),
        headers={
            "Accept": "application/json",
            "Authorization": "Bearer " + k8s_token(),
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=WATCH_SECONDS + 10, context=K8S_SSL) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8").strip()
                if not line:
                    continue
                event = json.loads(line)
                event_type = event.get("type")
                if event_type == "BOOKMARK":
                    continue
                if event_type == "ERROR":
                    log("watch error for " + description + ": " + json.dumps(event.get("object") or event))
                    return True
                log("watch event for " + description + ": " + str(event_type))
                return True
    except Exception as error:
        log("watch failed for " + description + ": " + str(error))
    return False


def litellm_request(method, path, body=None, ok=(200, 201, 202)):
    if not LITELLM_MASTER_KEY:
        raise RuntimeError("LITELLM_MASTER_KEY is required")
    url = LITELLM_BASE_URL + path
    data = None
    headers = {
        "Accept": "application/json",
        "Authorization": "Bearer " + LITELLM_MASTER_KEY,
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = response.read().decode("utf-8")
            if response.status not in ok:
                raise RuntimeError(f"{method} {path} returned {response.status}: {payload}")
            return json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", errors="replace")
        if error.code in ok:
            return json.loads(payload) if payload else {}
        raise RuntimeError(f"{method} {path} returned {error.code}: {payload}") from error


def positive_int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, str) and value.strip().isdigit():
        parsed = int(value.strip())
        return parsed if parsed > 0 else None
    return None


def safe_id(prefix, name):
    slug = re.sub(r"[^a-zA-Z0-9_.-]+", "-", name).strip("-").lower()
    return prefix + "-" + (slug or "model")


def model_type_from_features(features, fallback_name=""):
    lowered = [str(feature).lower() for feature in (features or [])]
    if any("embedding" in feature for feature in lowered):
        return "embedding"
    if any("generation" in feature or "chat" in feature for feature in lowered):
        return "chat"
    if "embedding" in fallback_name.lower():
        return "embedding"
    return "chat"


def context_from_args(args):
    args = [str(arg) for arg in (args or [])]
    for index, arg in enumerate(args):
        if arg.startswith("--max-model-len="):
            return positive_int(arg.split("=", 1)[1])
        if arg == "--max-model-len" and index + 1 < len(args):
            return positive_int(args[index + 1])
    return None


def context_from_model(model):
    annotations = (model.get("metadata") or {}).get("annotations") or {}
    annotated = positive_int(annotations.get("ai-appliance.io/context-window"))
    if annotated:
        return annotated
    return context_from_args((model.get("spec") or {}).get("args") or [])


def output_from_model(model):
    annotations = (model.get("metadata") or {}).get("annotations") or {}
    return positive_int(annotations.get("ai-appliance.io/max-output-tokens"))


def list_kubeai_models():
    path = f"/apis/kubeai.org/v1/namespaces/{NAMESPACE}/models"
    try:
        return k8s_request("GET", path).get("items") or []
    except RuntimeError as error:
        if " returned 404:" in str(error):
            return []
        raise


def kubeai_ready_replicas(model):
    replicas = ((model.get("status") or {}).get("replicas") or {})
    return positive_int(replicas.get("ready")) or 0


def get_configmap(name):
    path = f"/api/v1/namespaces/{NAMESPACE}/configmaps/{name}"
    try:
        return k8s_request("GET", path)
    except RuntimeError as error:
        if " returned 404:" in str(error):
            return None
        raise


def read_secret_value(ref):
    name = ref.get("name")
    key = ref.get("key")
    if not name or not key:
        return None
    secret = k8s_request("GET", f"/api/v1/namespaces/{NAMESPACE}/secrets/{name}")
    encoded = ((secret.get("data") or {}).get(key))
    if not encoded:
        return None
    return base64.b64decode(encoded).decode("utf-8")


def read_external_models():
    configmap = get_configmap(EXTERNAL_MODELS_CONFIGMAP)
    if not configmap:
        return []
    raw = (configmap.get("data") or {}).get("models.json", "").strip()
    if not raw:
        return []
    parsed = json.loads(raw)
    models = parsed.get("models") if isinstance(parsed, dict) else parsed
    return models if isinstance(models, list) else []


def read_model_activations():
    path = f"/apis/appliance.magicstick.dev/v1alpha1/namespaces/{APPLIANCE_NAMESPACE}/modelactivations"
    try:
        return k8s_request("GET", path).get("items") or []
    except RuntimeError as error:
        if " returned 404:" in str(error):
            return []
        raise


def external_activation_item(activation):
    metadata = activation.get("metadata") or {}
    spec = activation.get("spec") or {}
    external = spec.get("external") or {}
    item = dict(external)
    item["name"] = metadata.get("name")
    if external.get("modelType") and "type" not in item:
        item["type"] = external.get("modelType")
    if external.get("contextWindow") and "contextWindow" not in item:
        item["contextWindow"] = external.get("contextWindow")
    if external.get("maxOutputTokens") and "maxOutputTokens" not in item:
        item["maxOutputTokens"] = external.get("maxOutputTokens")
    return item


CAPABILITY_FIELDS = {"tools": "supports_function_calling", "vision": "supports_vision", "reasoning": "supports_reasoning"}


def capabilities(value):
    if not isinstance(value, dict):
        return {}
    return {key: value[key] for key in CAPABILITY_FIELDS if type(value.get(key)) is bool}


def capability_info(value):
    known = capabilities(value)
    # Track declarations separately from LiteLLM's inferred fields so removing
    # an override can clear it without mistaking inferred metadata for intent.
    return {**{CAPABILITY_FIELDS[key]: enabled for key, enabled in known.items()},
            "ai_appliance_capabilities": known}


def kubeai_deployment(model):
    metadata = model.get("metadata") or {}
    spec = model.get("spec") or {}
    name = metadata.get("name", "").strip()
    features = spec.get("features") or []
    model_type = model_type_from_features(features, name)
    context_window = context_from_model(model)
    max_output_tokens = output_from_model(model)
    model_info = {
        "id": safe_id("ai-appliance-kubeai", name),
        "ai_appliance_managed": True,
        "ai_appliance_source": "kubeai",
        "ai_appliance_type": model_type,
        "source": "kubeai",
        "features": features,
        "magicstick_vllm_priority": spec.get("engine") == "VLLM",
        "order": 0,
    }
    declaration = (metadata.get("annotations") or {}).get("ai-appliance.io/capabilities", "{}")
    model_info.update(capability_info(json.loads(declaration)))
    model_info["ai_appliance_unknown_capabilities"] = [key for key in CAPABILITY_FIELDS
                                                     if key not in model_info["ai_appliance_capabilities"]]
    if context_window:
        model_info["max_input_tokens"] = context_window
    if max_output_tokens:
        model_info["max_output_tokens"] = max_output_tokens
    return {
        "model_name": name,
        "litellm_params": {
            "model": "openai/" + name,
            "api_base": KUBEAI_API_BASE,
            "api_key": "none",
            "order": 0,
        },
        "model_info": model_info,
    }


def external_deployment(item):
    name = str(item.get("name") or "").strip()
    litellm = item.get("litellm") or {}
    params = {"model": litellm.get("model") or item.get("model")}
    api_base = litellm.get("apiBase") or litellm.get("api_base") or item.get("apiBase") or item.get("api_base")
    if api_base:
        params["api_base"] = api_base
    api_key = None
    if item.get("apiKeySecretRef"):
        api_key = read_secret_value(item["apiKeySecretRef"])
    api_key = api_key or litellm.get("apiKey") or litellm.get("api_key") or item.get("apiKey") or item.get("api_key")
    if api_key:
        params["api_key"] = api_key
    for source, target in (("apiVersion", "api_version"), ("api_version", "api_version"), ("customLlmProvider", "custom_llm_provider"), ("custom_llm_provider", "custom_llm_provider"), ("tpm", "tpm"), ("rpm", "rpm")):
        if source in litellm and litellm[source] is not None:
            params[target] = litellm[source]
        if source in item and item[source] is not None:
            params[target] = item[source]
    model_type = item.get("type") or item.get("modelType") or "chat"
    model_info = {
        "id": safe_id("ai-appliance-external", name),
        "ai_appliance_managed": True,
        "ai_appliance_source": "external",
        "ai_appliance_type": model_type,
        "source": "external",
    }
    model_info.update(capability_info(item.get("capabilities")))
    context_window = positive_int(item.get("contextWindow") or item.get("context_window") or item.get("max_input_tokens"))
    max_output_tokens = positive_int(item.get("maxOutputTokens") or item.get("max_output_tokens"))
    if context_window:
        model_info["max_input_tokens"] = context_window
    if max_output_tokens:
        model_info["max_output_tokens"] = max_output_tokens
    return {
        "model_name": name,
        "litellm_params": params,
        "model_info": model_info,
    }


def local_engine(activation):
    local = ((activation.get("spec") or {}).get("local") or {})
    return str(local.get("engine") or "VLLM").strip().lower()


def direct_runtime_endpoint(activation):
    """Validate the operator-owned Realtime Service endpoint before routing."""
    endpoint = str(((activation.get("status") or {}).get("runtimeEndpoint") or "")).strip().rstrip("/")
    if not endpoint:
        return None
    try:
        parsed = urllib.parse.urlsplit(endpoint)
    except ValueError:
        return None
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path != "/v1"
    ):
        return None
    # The operator owns a ClusterIP Service for this activation. Keep the
    # generated LiteLLM route inside that activation's namespace instead of
    # letting a status write turn a local-engine route into an arbitrary HTTP
    # backend.
    namespace = str((activation.get("spec") or {}).get("targetNamespace") or "ai").strip()
    expected_suffix = "." + namespace + ".svc.cluster.local"
    hostname = str(parsed.hostname or "").lower()
    if not namespace or not hostname.endswith(expected_suffix):
        return None
    return endpoint


def direct_runtime_backend(activation):
    local = (activation.get("spec") or {}).get("local") or {}
    if local_engine(activation) == "vllm" and (local.get("realtime") or {}).get("profile") == "qwen3-omni":
        return "vllm-omni"
    return ""


def direct_runtime_activation_ready(activation):
    metadata = activation.get("metadata") or {}
    spec = activation.get("spec") or {}
    status = activation.get("status") or {}
    if metadata.get("deletionTimestamp"):
        return False
    if spec.get("type") != "local" or spec.get("enabled", True) is False:
        return False
    if not direct_runtime_backend(activation):
        return False
    if str(status.get("phase") or "").strip().lower() != "ready":
        return False
    if direct_runtime_backend(activation) == "vllm-omni" and (
        not metadata.get("generation")
        or int(status.get("observedGeneration") or 0) < int(metadata["generation"])
    ):
        # An edit/restart invalidates the old Ready evidence immediately.
        return False
    return bool(direct_runtime_endpoint(activation))


def direct_runtime_deployment(activation):
    """Register a healthy direct runtime without going through KubeAI's proxy."""
    if not direct_runtime_activation_ready(activation):
        return None
    metadata = activation.get("metadata") or {}
    local = ((activation.get("spec") or {}).get("local") or {})
    name = str(metadata.get("name") or "").strip()
    endpoint = direct_runtime_endpoint(activation)
    if not name or not endpoint:
        return None
    features = local.get("features") or []
    model_type = local.get("modelType") or model_type_from_features(features, name)
    backend = direct_runtime_backend(activation)
    if backend == "vllm-omni":
        model_type = "realtime"
    model_info = {
        "id": safe_id("ai-appliance-" + backend, name),
        "ai_appliance_managed": True,
        "ai_appliance_source": backend,
        "ai_appliance_type": model_type,
        "source": backend,
        "features": features,
        "order": 0,
    }
    model_info.update(capability_info(local.get("capabilities")))
    model_info["ai_appliance_unknown_capabilities"] = [key for key in CAPABILITY_FIELDS
                                                     if key not in model_info["ai_appliance_capabilities"]]
    if backend == "vllm-omni":
        model_info["mode"] = "realtime"
        model_info["supports_audio_input"] = True
        model_info["supports_audio_output"] = True
    context_window = positive_int(local.get("contextWindow") or local.get("context_window"))
    max_output_tokens = positive_int(local.get("maxOutputTokens") or local.get("max_output_tokens"))
    if context_window:
        model_info["max_input_tokens"] = context_window
    if max_output_tokens:
        model_info["max_output_tokens"] = max_output_tokens
    return {
        "model_name": name,
        "litellm_params": {
            "model": "openai/" + name,
            "api_base": endpoint,
            "api_key": "none",
            "order": 0,
        },
        "model_info": model_info,
    }


def replicated_deployment(model, parents):
    """Expose healthy, current, UID-owned copies only under the public parent name."""
    meta = model.get("metadata") or {}
    labels, annotations = meta.get("labels") or {}, meta.get("annotations") or {}
    parent = parents.get(labels.get("appliance.magicstick.dev/modelactivation")) or {}
    pm, spec, status = parent.get("metadata") or {}, parent.get("spec") or {}, parent.get("status") or {}
    local = spec.get("local") or {}
    if (not pm.get("uid") or pm.get("deletionTimestamp") or meta.get("deletionTimestamp")
            or spec.get("enabled", True) is False or local.get("gpuDeployment") != "replicated"
            or spec.get("type") != "local" or labels.get("app.kubernetes.io/managed-by") != "magicstick-operator"
            or labels.get("appliance.magicstick.dev/activation-uid") != pm["uid"]
            or meta.get("namespace") != spec.get("targetNamespace", "ai")
            or annotations.get("appliance.magicstick.dev/activation-generation") != str(pm.get("generation"))
            or status.get("observedGeneration") != pm.get("generation")
            or kubeai_ready_replicas(model) < 1):
        return None
    cards = {d.get("uuid") for d in local.get("gpuDevices", [])}
    if annotations.get("appliance.magicstick.dev/replica-gpu") not in cards:
        return None
    ready = any(i.get("name") == meta.get("name") and i.get("modelUid") == meta.get("uid")
                and i.get("phase") == "Ready" for i in (status.get("replication") or {}).get("instances", []))
    if not ready or not meta.get("uid"):
        return None
    deployment = kubeai_deployment(model)
    deployment["model_name"] = pm["name"]
    deployment["model_info"]["magicstick_replica_parent"] = pm["name"]
    deployment["model_info"]["magicstick_replica_model"] = meta["name"]
    return deployment


def desired_deployments():
    deployments = []
    activations = read_model_activations()
    parents = {a.get("metadata", {}).get("name"): a for a in activations}
    for model in list_kubeai_models():
        name = ((model.get("metadata") or {}).get("name") or "").strip()
        if model.get("metadata", {}).get("labels", {}).get("appliance.magicstick.dev/model-replica") == "true":
            deployment = replicated_deployment(model, parents)
            if deployment:
                deployments.append(deployment)
            continue  # Never leak internal replica names as public models.
        if parents.get(name, {}).get("spec", {}).get("local", {}).get("gpuDeployment") == "replicated":
            continue  # Retiring legacy single/split runtime.
        if name and kubeai_ready_replicas(model) > 0:
            deployments.append(kubeai_deployment(model))
    for item in read_external_models():
        if item.get("enabled", True) is False:
            continue
        name = str(item.get("name") or "").strip()
        if name:
            deployments.append(external_deployment(item))
    for activation in activations:
        if (activation.get("metadata") or {}).get("deletionTimestamp"):
            continue
        spec = activation.get("spec") or {}
        if spec.get("type") == "external":
            if spec.get("enabled", True) is False:
                continue
            name = ((activation.get("metadata") or {}).get("name") or "").strip()
            if name:
                deployments.append(external_deployment(external_activation_item(activation)))
            continue
        deployment = direct_runtime_deployment(activation)
        if deployment:
            deployments.append(deployment)
    return {("replica:" + deployment_id(d) if d["model_info"].get("magicstick_replica_parent") else d["model_name"]): d for d in deployments}


def fetch_litellm_models():
    payload = litellm_request("GET", "/model/info")
    return payload.get("data") if isinstance(payload, dict) and isinstance(payload.get("data"), list) else []


def deployment_id(model):
    return ((model.get("model_info") or {}).get("id") or "").strip()


def is_managed(model):
    value = (model.get("model_info") or {}).get("ai_appliance_managed")
    return value is True or str(value).lower() == "true"


def sync_litellm():
    desired = desired_deployments()
    existing = fetch_litellm_models()
    existing_by_name = {model.get("model_name"): model for model in existing
                        if model.get("model_name") and not (model.get("model_info") or {}).get("magicstick_mesh_owner")
                        and not (model.get("model_info") or {}).get("magicstick_replica_parent")}
    existing_by_id = {deployment_id(model): model for model in existing if deployment_id(model)}
    retained = set()

    for deployment in desired.values():
        name = deployment["model_name"]
        replica = bool(deployment["model_info"].get("magicstick_replica_parent"))
        existing_model = existing_by_id.get(deployment_id(deployment)) if replica else existing_by_name.get(name)
        if replica and existing_model and (not is_managed(existing_model)
                or (existing_model.get("model_info") or {}).get("magicstick_replica_parent") != name
                or (existing_model.get("model_info") or {}).get("magicstick_mesh_owner")):
            raise ValueError("A foreign deployment occupies a reserved model replica ID")
        if existing_model and deployment_id(existing_model):
            deployment["model_info"]["id"] = deployment_id(existing_model)
        retained.add(deployment_id(deployment))
        try:
            if existing_model:
                previous_info = existing_model.get("model_info") or {}
                previous = capabilities(previous_info.get("ai_appliance_capabilities"))
                declared = deployment["model_info"].get("ai_appliance_capabilities") or {}
                # LiteLLM ignores null merge updates and retains cost-map flags
                # even after route recreation. Carry an explicit unknown mask
                # so removed declarations cannot leak into generated consumers.
                unknown = set(deployment["model_info"].get("ai_appliance_unknown_capabilities") or [])
                unknown.update(previous_info.get("ai_appliance_unknown_capabilities") or [])
                unknown.update(key for key in previous if key not in declared)
                deployment["model_info"]["ai_appliance_unknown_capabilities"] = sorted(
                    key for key in unknown if key in CAPABILITY_FIELDS and key not in declared)
                litellm_request("PATCH", "/model/" + urllib.parse.quote(deployment_id(existing_model), safe="") + "/update", deployment)
                log("updated LiteLLM model " + name)
            else:
                litellm_request("POST", "/model/new", deployment)
                log("added LiteLLM model " + name)
        except Exception as error:
            if existing_model or replica:
                raise
            log("model/new failed for " + name + ", trying model/update: " + str(error))
            litellm_request("POST", "/model/update", deployment)

    for model in existing:
        name = model.get("model_name")
        if deployment_id(model) in retained or not is_managed(model) or (model.get("model_info") or {}).get("magicstick_mesh_owner"):
            continue
        model_id = deployment_id(model)
        if not model_id:
            log("skipping managed model without id: " + str(name))
            continue
        litellm_request("POST", "/model/delete", {"id": model_id})
        log("deleted LiteLLM model " + name)

    return fetch_litellm_models()


def first_positive(mapping, keys):
    for key in keys:
        value = positive_int(mapping.get(key))
        if value:
            return value
    return None


def catalog_entry(model):
    name = model.get("model_name") or ""
    info = model.get("model_info") or {}
    params = model.get("litellm_params") or {}
    model_type = info.get("ai_appliance_type") or model_type_from_features(info.get("features") or [], name)
    context_window = first_positive(info, ["max_input_tokens", "contextWindow", "context_window", "context_length", "max_context_length", "max_tokens"])
    max_output_tokens = first_positive(info, ["max_output_tokens", "maxOutputTokens", "max_completion_tokens"])
    entry = {
        "id": name,
        "name": info.get("team_public_model_name") or name,
        "type": model_type,
        "provider": "litellm",
        "modelRef": "litellm/" + name,
        "source": info.get("source") or info.get("ai_appliance_source") or "litellm",
        "managed": is_managed(model),
        "litellm": {
            "model": params.get("model"),
            "apiBase": params.get("api_base"),
        },
    }
    if context_window:
        entry["contextWindow"] = context_window
    if max_output_tokens:
        entry["maxOutputTokens"] = max_output_tokens
    unknown = info.get("ai_appliance_unknown_capabilities") or []
    known = {key: info[field] for key, field in CAPABILITY_FIELDS.items()
             if key not in unknown and type(info.get(field)) is bool}
    known.update(capabilities(info.get("ai_appliance_capabilities")))
    if known:
        entry["capabilities"] = known
    return entry


def select_default(models, wanted, model_type):
    ids = [model["id"] for model in models if model.get("type") == model_type]
    return wanted if wanted in ids else (ids[0] if ids else "")


def openclaw_model(model):
    entry = {"id": model["id"], "name": model.get("name") or model["id"]}
    if model.get("contextWindow"):
        entry["contextWindow"] = model["contextWindow"]
    known = capabilities(model.get("capabilities"))
    if "reasoning" in known:
        entry["reasoning"] = known["reasoning"]
    if "vision" in known:
        entry["input"] = ["text", "image"] if known["vision"] else ["text"]
    if "tools" in known:
        entry["compat"] = {"supportsTools": known["tools"]}
    return entry


def openclaw_compaction(models, default_model):
    selected = next((model for model in models if model.get("id") == default_model), None)
    context_window = positive_int((selected or {}).get("contextWindow"))
    if context_window and context_window <= OPENCLAW_SMALL_CONTEXT_MAX_TOKENS:
        return {
            "keepRecentTokens": max(
                1, min(OPENCLAW_SMALL_CONTEXT_KEEP_RECENT_MAX_TOKENS, context_window // 4),
            ),
        }
    # OpenClaw 2026.9.8 caps its own reserve at a quarter of the active
    # model's context. The public schema no longer accepts reserve overrides.
    return {"keepRecentTokens": OPENCLAW_DEFAULT_KEEP_RECENT_TOKENS}


def hermes_model(model):
    entry = {"name": model.get("name") or model["id"]}
    if model.get("contextWindow"):
        entry["context_length"] = model["contextWindow"]
    entry.update(hermes_capabilities(model))
    return entry


def hermes_capabilities(model):
    known = capabilities(model.get("capabilities"))
    return {"supports_" + key: enabled for key, enabled in known.items()}


def opencode_model(model):
    context = positive_int(model.get("contextWindow")) or OPENCODE_DEFAULT_CONTEXT_TOKENS
    output = positive_int(model.get("maxOutputTokens")) or min(
        OPENCODE_DEFAULT_OUTPUT_TOKENS, max(1, context // 4)
    )
    entry = {
        "name": model.get("name") or model["id"],
        "limit": {
            "context": context,
            "output": min(output, context),
        },
    }
    known = capabilities(model.get("capabilities"))
    for key, target in (("tools", "tool_call"), ("reasoning", "reasoning")):
        if key in known:
            entry[target] = known[key]
    if "vision" in known:
        entry["modalities"] = {"input": ["text", "image"] if known["vision"] else ["text"], "output": ["text"]}
    return entry


def pi_model(model):
    # Pi's upstream defaults are too large for small local models. Keep unknown
    # limits conservative and leave space for agent instructions and tool output.
    context = positive_int(model.get("contextWindow")) or 8192
    output = positive_int(model.get("maxOutputTokens")) or 2048
    known = capabilities(model.get("capabilities"))
    return {
        "id": model["id"],
        "name": model.get("name") or model["id"],
        "contextWindow": context,
        "maxTokens": min(output, 8192, max(1, context // 4)),
        # Pi requires concrete booleans/modalities. Unknown remains absent in
        # the canonical catalog; this adapter keeps conservative Pi defaults.
        "reasoning": known.get("reasoning", False),
        "input": ["text", "image"] if known.get("vision") is True else ["text"],
    }


def paperclip_opencode_model(model):
    generated = opencode_model(model)
    physical_context = generated["limit"]["context"]
    headroom = 0
    if physical_context > 1 and PAPERCLIP_OPENCODE_CONTEXT_HEADROOM_TOKENS:
        headroom = min(
            PAPERCLIP_OPENCODE_CONTEXT_HEADROOM_TOKENS,
            max(1, physical_context // 4),
            physical_context - 1,
        )
    context = physical_context - headroom
    generated["limit"]["context"] = context
    generated["limit"]["output"] = min(
        generated["limit"]["output"],
        PAPERCLIP_OPENCODE_MAX_OUTPUT_TOKENS,
        max(1, context // 4),
    )
    return generated


def build_catalog(litellm_models):
    # Multiple LiteLLM deployments in one logical fallback group are one model
    # in application pickers. Prefer the local deployment's context metadata.
    groups = {}
    for model in sorted(litellm_models, key=lambda value: ((value.get("model_info") or {}).get("order") or 0)):
        if model.get("model_name") and (model.get("model_info") or {}).get("source") != "mesh-export":
            groups.setdefault(model["model_name"], []).append(catalog_entry(model))
    models = []
    for entries in groups.values():
        entry = entries[0]
        known = {}
        for key in CAPABILITY_FIELDS:
            values = [capabilities(item.get("capabilities")).get(key) for item in entries]
            if False in values:
                known[key] = False
            elif all(value is True for value in values):
                known[key] = True
        entry.pop("capabilities", None)
        if known:
            entry["capabilities"] = known
        models.append(entry)
    models.sort(key=lambda item: (item.get("type") or "", item["id"]))
    chat_models = [model for model in models if model.get("type") == "chat"]
    embedding_models = [model for model in models if model.get("type") == "embedding"]
    default_chat = select_default(models, DEFAULT_CHAT_MODEL, "chat")
    default_embedding = select_default(models, DEFAULT_EMBEDDING_MODEL, "embedding")
    openclaw_compaction_config = openclaw_compaction(chat_models, default_chat)
    hash_input = {
        "models": models,
        "defaultChatModel": default_chat,
        "defaultEmbeddingModel": default_embedding,
        "opencodeDefaultContextTokens": OPENCODE_DEFAULT_CONTEXT_TOKENS,
        "opencodeDefaultOutputTokens": OPENCODE_DEFAULT_OUTPUT_TOKENS,
        "paperclipOpenCodeMaxOutputTokens": PAPERCLIP_OPENCODE_MAX_OUTPUT_TOKENS,
        "paperclipOpenCodeContextHeadroomTokens": PAPERCLIP_OPENCODE_CONTEXT_HEADROOM_TOKENS,
        "openclawCompaction": openclaw_compaction_config,
        "openclawToolsProfile": OPENCLAW_TOOLS_PROFILE,
        "piModelConfigVersion": 1,
    }
    catalog_hash = hashlib.sha256(json.dumps(hash_input, sort_keys=True).encode("utf-8")).hexdigest()[:16]

    openclaw_models = [openclaw_model(model) for model in chat_models]
    openclaw = {
        "models": {
            "providers": {
                "litellm": {
                    "baseUrl": LITELLM_API_BASE,
                    "apiKey": "$" + "{LITELLM_API_KEY}",
                    "api": "openai-completions",
                    "models": openclaw_models,
                }
            }
        },
        "agents": {
            "defaults": {
                "compaction": openclaw_compaction_config,
                "model": {
                    "primary": "litellm/" + default_chat if default_chat else "",
                }
            }
        },
        "tools": {
            "profile": OPENCLAW_TOOLS_PROFILE,
        },
    }
    hermes = {
        "model": {
            "default": default_chat,
            "provider": "custom:litellm",
            "base_url": LITELLM_API_BASE,
            "api_mode": "chat_completions",
        },
        "providers": {
            "litellm": {
                "name": "LiteLLM",
                "base_url": LITELLM_API_BASE,
                "key_env": "OPENAI_API_KEY",
                "transport": "chat_completions",
                "default_model": default_chat,
                "discover_models": False,
                "models": {model["id"]: hermes_model(model) for model in chat_models},
            }
        },
        "model_overrides": {provider: {model["id"]: hermes_capabilities(model) for model in chat_models}
                            for provider in ("custom", "custom:litellm")},
    }
    opencode_providers = {
        "litellm": {
            "npm": "@ai-sdk/openai-compatible",
            "name": "LiteLLM",
            "options": {
                "baseURL": LITELLM_API_BASE,
                "apiKey": "{env:OPENAI_API_KEY}",
            },
            "models": {model["id"]: opencode_model(model) for model in chat_models},
        }
    }
    paperclip_opencode_providers = {
        "litellm": {
            "npm": "@ai-sdk/openai-compatible",
            "name": "LiteLLM",
            "options": {
                "baseURL": LITELLM_API_BASE,
                "apiKey": "{env:OPENAI_API_KEY}",
            },
            "models": {
                model["id"]: paperclip_opencode_model(model)
                for model in chat_models
            },
        }
    }
    paperclip_adapter_models = {
        "opencode_local": [
            {
                "id": model["modelRef"],
                "label": model.get("name") or model["id"],
            }
            for model in chat_models
        ]
    }
    default_opencode_model = "litellm/" + default_chat if default_chat else ""
    defaults_env = "\n".join([
        "AI_APPLIANCE_MODEL_CATALOG_READY=true",
        "AI_APPLIANCE_MODEL_CATALOG_HASH=" + catalog_hash,
        "AI_APPLIANCE_DEFAULT_CHAT_MODEL=" + default_chat,
        "AI_APPLIANCE_DEFAULT_OPENCODE_MODEL=" + default_opencode_model,
        "AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL=" + default_embedding,
        "AI_APPLIANCE_MODEL_COUNT=" + str(len(models)),
        "AI_APPLIANCE_CHAT_MODEL_COUNT=" + str(len(chat_models)),
        "AI_APPLIANCE_EMBEDDING_MODEL_COUNT=" + str(len(embedding_models)),
        "",
    ])
    data = {
        "catalog.json": json_dumps({"hash": catalog_hash, "models": models, "defaultChatModel": default_chat, "defaultEmbeddingModel": default_embedding}),
        "chat-models.json": json_dumps({"models": chat_models, "defaultModel": default_chat}),
        "embedding-models.json": json_dumps({"models": embedding_models, "defaultModel": default_embedding}),
        "defaults.env": defaults_env,
        "openclaw.json": json_dumps(openclaw),
        "hermes.yaml": json_dumps(hermes),
        "pi-models.json": json_dumps({
            "providers": {
                "litellm": {
                    "baseUrl": LITELLM_API_BASE,
                    "api": "openai-completions",
                    # Keep this consumer placeholder out of Flux substitution
                    # while this Python source is deployed via a ConfigMap.
                    "apiKey": "$" + "{LITELLM_API_KEY}",
                    "models": [pi_model(model) for model in chat_models],
                },
            },
        }),
        "opencode-providers.json": json_dumps(opencode_providers),
        "paperclip-opencode-providers.json": json_dumps(paperclip_opencode_providers),
        "paperclip-adapter-models.json": json_dumps(paperclip_adapter_models),
        "AI_APPLIANCE_MODEL_CATALOG_READY": "true",
        "AI_APPLIANCE_MODEL_CATALOG_HASH": catalog_hash,
        "AI_APPLIANCE_DEFAULT_CHAT_MODEL": default_chat,
        "AI_APPLIANCE_DEFAULT_OPENCODE_MODEL": default_opencode_model,
        "AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL": default_embedding,
    }
    return data, catalog_hash


def write_catalog(data, catalog_hash):
    existing = get_configmap(CATALOG_CONFIGMAP)
    existing_hash = (((existing or {}).get("metadata") or {}).get("annotations") or {}).get(CATALOG_HASH_ANNOTATION)
    existing_data = (existing or {}).get("data") or {}
    if existing and existing_hash == catalog_hash and all(existing_data.get(key) == value for key, value in data.items()):
        return False
    metadata = (existing or {}).get("metadata") or {}
    labels = metadata.get("labels") or {}
    annotations = metadata.get("annotations") or {}
    labels["app"] = "ai-model-catalog"
    annotations[CATALOG_HASH_ANNOTATION] = catalog_hash
    annotations["ai-appliance.io/last-sync"] = utc_now()
    obj = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": CATALOG_CONFIGMAP,
            "namespace": NAMESPACE,
            "labels": labels,
            "annotations": annotations,
        },
        "data": data,
    }
    if metadata.get("resourceVersion"):
        obj["metadata"]["resourceVersion"] = metadata["resourceVersion"]
        k8s_request("PUT", f"/api/v1/namespaces/{NAMESPACE}/configmaps/{CATALOG_CONFIGMAP}", obj)
    else:
        k8s_request("POST", f"/api/v1/namespaces/{NAMESPACE}/configmaps", obj)
    return True


def agent_template_model(model):
    return opencode_model(model)


def managed_agent_template_names():
    path = path_with_query(
        f"/apis/kubeopencode.io/v1alpha1/namespaces/{NAMESPACE}/agenttemplates",
        {"labelSelector": AGENT_TEMPLATE_APPINSTANCE_LABEL},
    )
    try:
        templates = k8s_request("GET", path).get("items") or []
    except RuntimeError as error:
        if " returned 404:" not in str(error):
            log("managed AgentTemplate discovery failed: " + str(error))
        return []
    return [
        (template.get("metadata") or {}).get("name")
        for template in templates
        if (template.get("metadata") or {}).get("name")
    ]


def sync_agent_templates(data):
    if not SYNC_AGENT_TEMPLATES or not AGENT_TEMPLATE_NAMES:
        return
    chat_catalog = json.loads(data.get("chat-models.json") or "{}")
    chat_models = chat_catalog.get("models") or []
    default_chat = chat_catalog.get("defaultModel") or ""
    if not chat_models or not default_chat:
        log("skipping AgentTemplate sync because the chat catalog is empty")
        return

    template_models = {model["id"]: agent_template_model(model) for model in chat_models}
    patch = {
        "spec": {
            "config": {
                "provider": {
                    "litellm": {
                        "models": template_models,
                    },
                },
            },
        },
    }
    managed_names = set(managed_agent_template_names())
    template_names = list(dict.fromkeys(AGENT_TEMPLATE_NAMES + sorted(managed_names)))
    for name in template_names:
        path = f"/apis/kubeopencode.io/v1alpha1/namespaces/{NAMESPACE}/agenttemplates/{name}"
        try:
            existing = k8s_request("GET", path)
        except RuntimeError as error:
            if " returned 404:" in str(error):
                log("AgentTemplate " + name + " is not available yet")
                continue
            log("AgentTemplate sync failed for " + name + ": " + str(error))
            continue
        updated = deep_merge(copy.deepcopy(existing), patch)
        config = updated["spec"]["config"]
        # Replace the model list so withdrawn routes disappear. Preserve the
        # provider's URL/authentication and the AppInstance's selected models.
        config["provider"]["litellm"]["models"] = template_models
        instance_managed = name in managed_names or AGENT_TEMPLATE_APPINSTANCE_LABEL in (
            (existing.get("metadata") or {}).get("labels") or {}
        )
        if not instance_managed:
            config["model"] = "litellm/" + default_chat
            config["small_model"] = "litellm/" + default_chat
        else:
            if not config.get("model") or config["model"] == "litellm/CHANGEME_MODEL":
                config["model"] = "litellm/" + default_chat
            if not config.get("small_model") or config["small_model"] == "litellm/CHANGEME_MODEL":
                config["small_model"] = config["model"]
        annotations = updated["spec"].setdefault("podSpec", {}).setdefault("annotations", {})
        annotations[CATALOG_HASH_ANNOTATION] = hashlib.sha256(
            json.dumps(config, sort_keys=True).encode("utf-8")
        ).hexdigest()[:16]
        if updated["spec"] == existing.get("spec"):
            continue
        updated.pop("status", None)
        (updated.get("metadata") or {}).pop("managedFields", None)
        try:
            k8s_request("PUT", path, updated)
            log("synced AgentTemplate " + name + " with " + str(len(template_models)) + " chat models")
        except RuntimeError as error:
            log("AgentTemplate update failed for " + name + ": " + str(error))


def sync_openclaw_instances(data):
    """Publish per-instance defaults without giving the catalog CR write access."""
    path = path_with_query(
        f"/apis/openclaw.rocks/v1alpha1/namespaces/{NAMESPACE}/openclawinstances",
        {"labelSelector": AGENT_TEMPLATE_APPINSTANCE_LABEL},
    )
    try:
        instances = k8s_request("GET", path).get("items") or []
    except RuntimeError as error:
        if " returned 404:" not in str(error):
            log("OpenClaw instance discovery failed: " + str(error))
        return
    chat_catalog = json.loads(data.get("chat-models.json") or "{}")
    base = json.loads(data["openclaw.json"])
    for instance in instances:
        metadata = instance.get("metadata") or {}
        name, uid = metadata.get("name"), metadata.get("uid")
        if not name or not uid:
            continue
        config_name = name + "-model-catalog"
        reference = ((instance.get("spec") or {}).get("config") or {}).get("configMapRef") or {}
        # Legacy/global and user-owned ConfigMap references retain their path.
        if reference != {"name": config_name, "key": "openclaw.json"}:
            continue
        selected = (metadata.get("annotations") or {}).get(PREFERRED_MODEL_ANNOTATION)
        selected = selected or chat_catalog.get("defaultModel") or ""
        config = copy.deepcopy(base)
        defaults = config["agents"]["defaults"]
        defaults["model"]["primary"] = "litellm/" + selected if selected else ""
        defaults["compaction"] = openclaw_compaction(chat_catalog.get("models") or [], selected)
        owner = {"apiVersion": "openclaw.rocks/v1alpha1", "kind": "OpenClawInstance",
                 "name": name, "uid": uid, "controller": True, "blockOwnerDeletion": False}
        cm_path = f"/api/v1/namespaces/{NAMESPACE}/configmaps/{config_name}"
        try:
            existing = k8s_request("GET", cm_path)
        except RuntimeError as error:
            if " returned 404:" not in str(error):
                log("OpenClaw catalog read failed for " + name + ": " + str(error))
                continue
            existing = {}
        existing_meta = existing.get("metadata") or {}
        owned = any(
            all(reference.get(key) == owner[key] for key in ("apiVersion", "kind", "name", "uid"))
            for reference in existing_meta.get("ownerReferences") or []
        )
        if existing and not owned:
            log("refusing to replace a foreign OpenClaw catalog for " + name)
            continue
        labels = dict(existing_meta.get("labels") or {})
        labels.update({"app.kubernetes.io/managed-by": "ai-model-catalog-controller",
                       AGENT_TEMPLATE_APPINSTANCE_LABEL: name})
        desired = {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {
            "name": config_name, "namespace": NAMESPACE,
            "labels": labels,
            "annotations": existing_meta.get("annotations") or {},
            "ownerReferences": [owner],
        }, "data": {"openclaw.json": json_dumps(config)}}
        if desired["data"] == existing.get("data"):
            continue
        try:
            if existing_meta.get("resourceVersion"):
                desired["metadata"]["resourceVersion"] = existing_meta["resourceVersion"]
                k8s_request("PUT", cm_path, desired)
            else:
                k8s_request("POST", f"/api/v1/namespaces/{NAMESPACE}/configmaps", desired)
        except RuntimeError as error:
            log("OpenClaw catalog update failed for " + name + ": " + str(error))


def labels_match(labels, selector):
    return all(labels.get(key) == value for key, value in selector.items())


def is_consumer_pod(pod):
    metadata = pod.get("metadata") or {}
    labels = metadata.get("labels") or {}
    annotations = metadata.get("annotations") or {}
    if labels.get(CONSUMER_ANNOTATION) == "false" or annotations.get(CONSUMER_ANNOTATION) == "false":
        return False
    if labels.get(CONSUMER_ANNOTATION) == "true" or annotations.get(CONSUMER_ANNOTATION) == "true":
        return True
    return any(labels_match(labels, selector) for selector in DEFAULT_CONSUMER_SELECTORS)


def restart_consumers():
    if not RESTART_CONSUMERS:
        return
    pods = k8s_request("GET", f"/api/v1/namespaces/{NAMESPACE}/pods").get("items") or []
    for pod in pods:
        metadata = pod.get("metadata") or {}
        if metadata.get("deletionTimestamp"):
            continue
        if not is_consumer_pod(pod):
            continue
        name = metadata.get("name")
        if not name:
            continue
        log("deleting model-catalog consumer pod " + name)
        k8s_request("DELETE", f"/api/v1/namespaces/{NAMESPACE}/pods/{name}", ok=(200, 202))


def reconcile_once():
    litellm_models = sync_litellm()
    data, catalog_hash = build_catalog(litellm_models)
    changed = write_catalog(data, catalog_hash)
    sync_openclaw_instances(data)
    sync_agent_templates(data)
    if changed:
        log("published model catalog hash " + catalog_hash)
        restart_consumers()
    else:
        log("model catalog hash unchanged " + catalog_hash)


def wait_for_catalog_source_change():
    if k8s_watch(f"/apis/kubeai.org/v1/namespaces/{NAMESPACE}/models", "KubeAI models"):
        return
    if k8s_watch(
        f"/api/v1/namespaces/{NAMESPACE}/configmaps",
        "external model configmap",
        {"fieldSelector": "metadata.name=" + EXTERNAL_MODELS_CONFIGMAP},
    ):
        return
    k8s_watch(
        f"/apis/appliance.magicstick.dev/v1alpha1/namespaces/{APPLIANCE_NAMESPACE}/modelactivations",
        "ModelActivation resources",
    )


def main():
    log("starting ai-model-catalog-controller")
    while True:
        try:
            reconcile_once()
        except Exception as error:
            log("reconcile failed: " + str(error))
            time.sleep(POLL_SECONDS)
            continue
        wait_for_catalog_source_change()


if __name__ == "__main__":
    main()
