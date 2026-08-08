#!/usr/bin/env python3
import json
import os
import sys
import time
import urllib.error
import urllib.request

AISIX_BASE_URL = os.environ.get("AISIX_BASE_URL", "http://aisix.aisix-system.svc.cluster.local:4000").rstrip("/")
LITELLM_BASE_URL = os.environ.get("LITELLM_BASE_URL", "http://litellm.ai.svc.cluster.local:4000").rstrip("/")
API_KEY = os.environ.get("AI_GATEWAY_API_KEY", "")
CHAT_MODEL = os.environ.get("TEST_CHAT_MODEL", "").strip()
EMBEDDING_MODEL = os.environ.get("TEST_EMBEDDING_MODEL", "").strip()


def request(base_url, method, path, body=None, authenticated=True, expected=(200,)):
    headers = {"Accept": "application/json"}
    if authenticated:
        headers["Authorization"] = "Bearer " + API_KEY
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base_url + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            payload = response.read().decode("utf-8")
            if response.status not in expected:
                raise AssertionError(f"{method} {path}: expected {expected}, got {response.status}")
            return response.status, json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", errors="replace")
        if error.code not in expected:
            raise AssertionError(f"{method} {path}: expected {expected}, got {error.code}: {payload}") from error
        try:
            return error.code, json.loads(payload) if payload else {}
        except json.JSONDecodeError:
            return error.code, {"raw": payload}


def model_ids(payload):
    return {str(item.get("id")) for item in (payload.get("data") or []) if item.get("id")}


def stream_request(base_url, body):
    payload = dict(body)
    payload["stream"] = True
    req = urllib.request.Request(
        base_url + "/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Accept": "text/event-stream",
            "Authorization": "Bearer " + API_KEY,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as response:
        if response.status != 200:
            raise AssertionError(f"streaming: expected 200, got {response.status}")
        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if line.startswith("data:"):
                return
    raise AssertionError("streaming response contained no SSE data event")


def check_models(timeout_seconds=240):
    deadline = time.monotonic() + timeout_seconds
    expected = {model for model in (CHAT_MODEL, EMBEDDING_MODEL) if model}
    while True:
        _, aisix = request(AISIX_BASE_URL, "GET", "/v1/models")
        _, litellm = request(LITELLM_BASE_URL, "GET", "/v1/models")
        aisix_ids = model_ids(aisix)
        litellm_ids = model_ids(litellm)
        if expected.issubset(aisix_ids) and expected.issubset(litellm_ids):
            break
        if time.monotonic() >= deadline:
            raise AssertionError(
                "timed out waiting for contract models; "
                + f"expected={sorted(expected)} AISIX={sorted(aisix_ids)} LiteLLM={sorted(litellm_ids)}"
            )
        time.sleep(5)
    missing = sorted(aisix_ids - litellm_ids)
    if missing:
        raise AssertionError("AISIX returned models absent from LiteLLM: " + ", ".join(missing))
    print(f"models: AISIX={len(aisix_ids)} LiteLLM={len(litellm_ids)}")
    return aisix_ids


def check_chat(aisix_ids):
    if not CHAT_MODEL:
        print("chat: skipped (no contract chat model configured)")
        return
    if CHAT_MODEL not in aisix_ids:
        print("chat: skipped (the default model is not AISIX-compatible: " + CHAT_MODEL + ")")
        return
    body = {"model": CHAT_MODEL, "messages": [{"role": "user", "content": "Reply with the word ready."}], "max_tokens": 16}
    for name, base_url in (("AISIX", AISIX_BASE_URL), ("LiteLLM", LITELLM_BASE_URL)):
        _, payload = request(base_url, "POST", "/v1/chat/completions", body)
        if not isinstance(payload.get("choices"), list) or not payload["choices"]:
            raise AssertionError(name + " chat response has no choices")
        stream_request(base_url, body)
    print("chat: both gateways returned OpenAI-compatible JSON and SSE responses")


def check_embeddings(aisix_ids):
    if not EMBEDDING_MODEL:
        print("embeddings: skipped (no contract embedding model configured)")
        return
    if EMBEDDING_MODEL not in aisix_ids:
        print("embeddings: skipped (the default model is not AISIX-compatible: " + EMBEDDING_MODEL + ")")
        return
    body = {"model": EMBEDDING_MODEL, "input": ["magicstick contract test"]}
    for name, base_url in (("AISIX", AISIX_BASE_URL), ("LiteLLM", LITELLM_BASE_URL)):
        _, payload = request(base_url, "POST", "/v1/embeddings", body)
        data = payload.get("data") or []
        if not data or not isinstance(data[0].get("embedding"), list):
            raise AssertionError(name + " embedding response has no vector")
    print("embeddings: both gateways returned an OpenAI-compatible vector")


def main():
    if not API_KEY:
        raise RuntimeError("AI_GATEWAY_API_KEY is required")
    request(AISIX_BASE_URL, "GET", "/livez", authenticated=False)
    request(AISIX_BASE_URL, "GET", "/readyz", authenticated=False)
    request(AISIX_BASE_URL, "GET", "/v1/models", authenticated=False, expected=(401, 403))
    request(AISIX_BASE_URL, "POST", "/v1/chat/completions", {"model": "magicstick-does-not-exist", "messages": []}, expected=(400, 404))
    aisix_ids = check_models()
    check_chat(aisix_ids)
    check_embeddings(aisix_ids)
    print("AISIX/LiteLLM contract smoke test passed")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("contract test failed: " + str(error), file=sys.stderr)
        raise
