#!/usr/bin/env python3
import base64
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
DEFAULT_CHAT_MODEL = os.environ.get("AI_APPLIANCE_DEFAULT_CHAT_MODEL", "qwen3635b")
DEFAULT_EMBEDDING_MODEL = os.environ.get("AI_APPLIANCE_DEFAULT_EMBEDDING_MODEL", "qwen352bvlembedding")
OPENCODE_DEFAULT_CONTEXT_TOKENS = int(os.environ.get("OPENCODE_DEFAULT_CONTEXT_TOKENS", "131072"))
OPENCODE_DEFAULT_OUTPUT_TOKENS = int(os.environ.get("OPENCODE_DEFAULT_OUTPUT_TOKENS", "8192"))
RESTART_CONSUMERS = os.environ.get("CONSUMER_RESTART_ENABLED", "true").lower() == "true"
SYNC_AGENT_TEMPLATES = os.environ.get("AGENT_TEMPLATE_SYNC_ENABLED", "true").lower() == "true"
AGENT_TEMPLATE_NAMES = [name.strip() for name in os.environ.get("AGENT_TEMPLATE_NAMES", "litellm-default").split(",") if name.strip()]
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
    }
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


def desired_deployments():
    deployments = []
    for model in list_kubeai_models():
        name = ((model.get("metadata") or {}).get("name") or "").strip()
        if name:
            deployments.append(kubeai_deployment(model))
    for item in read_external_models():
        if item.get("enabled", True) is False:
            continue
        name = str(item.get("name") or "").strip()
        if name:
            deployments.append(external_deployment(item))
    for activation in read_model_activations():
        if (activation.get("metadata") or {}).get("deletionTimestamp"):
            continue
        spec = activation.get("spec") or {}
        if spec.get("type") != "external" or spec.get("enabled", True) is False:
            continue
        name = ((activation.get("metadata") or {}).get("name") or "").strip()
        if name:
            deployments.append(external_deployment(external_activation_item(activation)))
    return {deployment["model_name"]: deployment for deployment in deployments}


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
    existing_by_name = {model.get("model_name"): model for model in existing if model.get("model_name")}

    for name, deployment in desired.items():
        existing_model = existing_by_name.get(name)
        if existing_model and deployment_id(existing_model):
            deployment["model_info"]["id"] = deployment_id(existing_model)
        try:
            if existing_model:
                litellm_request("POST", "/model/update", deployment)
                log("updated LiteLLM model " + name)
            else:
                litellm_request("POST", "/model/new", deployment)
                log("added LiteLLM model " + name)
        except Exception as error:
            if existing_model:
                raise
            log("model/new failed for " + name + ", trying model/update: " + str(error))
            litellm_request("POST", "/model/update", deployment)

    for model in existing:
        name = model.get("model_name")
        if name in desired or not is_managed(model):
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
    return entry


def select_default(models, wanted, model_type):
    ids = [model["id"] for model in models if model.get("type") == model_type]
    return wanted if wanted in ids else (ids[0] if ids else "")


def openclaw_model(model):
    entry = {"id": model["id"], "name": model.get("name") or model["id"]}
    if model.get("contextWindow"):
        entry["contextWindow"] = model["contextWindow"]
    return entry


def hermes_model(model):
    entry = {"name": model.get("name") or model["id"]}
    if model.get("contextWindow"):
        entry["context_length"] = model["contextWindow"]
    return entry


def opencode_model(model):
    return {
        "name": model.get("name") or model["id"],
        "limit": {
            "context": model.get("contextWindow") or OPENCODE_DEFAULT_CONTEXT_TOKENS,
            "output": model.get("maxOutputTokens") or OPENCODE_DEFAULT_OUTPUT_TOKENS,
        },
    }


def build_catalog(litellm_models):
    models = [catalog_entry(model) for model in litellm_models if model.get("model_name")]
    models.sort(key=lambda item: (item.get("type") or "", item["id"]))
    chat_models = [model for model in models if model.get("type") == "chat"]
    embedding_models = [model for model in models if model.get("type") == "embedding"]
    default_chat = select_default(models, DEFAULT_CHAT_MODEL, "chat")
    default_embedding = select_default(models, DEFAULT_EMBEDDING_MODEL, "embedding")
    hash_input = {
        "models": models,
        "defaultChatModel": default_chat,
        "defaultEmbeddingModel": default_embedding,
        "opencodeDefaultContextTokens": OPENCODE_DEFAULT_CONTEXT_TOKENS,
        "opencodeDefaultOutputTokens": OPENCODE_DEFAULT_OUTPUT_TOKENS,
    }
    catalog_hash = hashlib.sha256(json.dumps(hash_input, sort_keys=True).encode("utf-8")).hexdigest()[:16]

    openclaw_models = [openclaw_model(model) for model in chat_models]
    openclaw = {
        "models": {
            "providers": {
                "litellm": {
                    "baseUrl": LITELLM_API_BASE,
                    "apiKey": "$" + "{OPENAI_API_KEY}",
                    "api": "openai-completions",
                    "models": openclaw_models,
                }
            }
        },
        "agents": {
            "defaults": {
                "model": {
                    "primary": "litellm/" + default_chat if default_chat else "",
                }
            }
        },
    }
    hermes = {
        "model": {
            "default": default_chat,
            "provider": "litellm",
            "base_url": LITELLM_API_BASE,
            "api_mode": "chat_completions",
        },
        "providers": {
            "litellm": {
                "name": "LiteLLM",
                "base_url": LITELLM_API_BASE,
                "key_env": "OPENAI_API_KEY",
                "api_mode": "chat_completions",
                "default_model": default_chat,
                "discover_models": False,
                "models": {model["id"]: hermes_model(model) for model in chat_models},
            }
        },
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
        "opencode-providers.json": json_dumps(opencode_providers),
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
    return {"name": model.get("name") or model["id"]}


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
                "model": "litellm/" + default_chat,
                "small_model": "litellm/" + default_chat,
            },
        },
    }
    for name in AGENT_TEMPLATE_NAMES:
        path = f"/apis/kubeopencode.io/v1alpha1/namespaces/{NAMESPACE}/agenttemplates/{name}"
        try:
            existing = k8s_request("GET", path)
        except RuntimeError as error:
            if " returned 404:" in str(error):
                log("AgentTemplate " + name + " is not available yet")
                continue
            log("AgentTemplate sync failed for " + name + ": " + str(error))
            continue
        updated = deep_merge(existing, patch)
        updated.pop("status", None)
        (updated.get("metadata") or {}).pop("managedFields", None)
        try:
            k8s_request("PUT", path, updated)
            log("synced AgentTemplate " + name + " with " + str(len(template_models)) + " chat models")
        except RuntimeError as error:
            log("AgentTemplate update failed for " + name + ": " + str(error))


def labels_match(labels, selector):
    return all(labels.get(key) == value for key, value in selector.items())


def is_consumer_pod(pod):
    metadata = pod.get("metadata") or {}
    labels = metadata.get("labels") or {}
    annotations = metadata.get("annotations") or {}
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
