#!/usr/bin/env python3
"""Register the Magic Stick LiteLLM endpoint in Odysseus.

Odysseus persists model endpoints through its own API. Environment variables
such as OPENAI_BASE_URL alone are not consumed by Odysseus, so the instance
chart runs this small reconciler next to the application. The API key is read
from the process environment and is never included in log messages.
"""

from __future__ import annotations

import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass(frozen=True)
class Config:
    odysseus_url: str
    litellm_url: str
    api_key: str
    model: str
    endpoint_name: str
    ready_file: pathlib.Path
    request_timeout: int
    reconcile_interval: int


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _http_url(name: str, value: str) -> str:
    normalized = value.strip().rstrip("/")
    parsed = urllib.parse.urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{name} must be an http(s) URL")
    return normalized


def load_config() -> Config:
    model = os.getenv("ODYSSEUS_DEFAULT_MODEL", "").strip()
    if not model or model == "CHANGEME_MODEL":
        raise ValueError("ODYSSEUS_DEFAULT_MODEL must select a model")

    api_key = os.getenv("LITELLM_API_KEY", "")
    if not api_key:
        raise ValueError("LITELLM_API_KEY is required")

    return Config(
        odysseus_url=_http_url(
            "ODYSSEUS_API_URL",
            os.getenv("ODYSSEUS_API_URL", "http://127.0.0.1:7000"),
        ),
        litellm_url=_http_url(
            "LITELLM_BASE_URL",
            os.getenv(
                "LITELLM_BASE_URL",
                "http://litellm.ai.svc.cluster.local:4000/v1",
            ),
        ),
        api_key=api_key,
        model=model,
        endpoint_name=os.getenv(
            "ODYSSEUS_ENDPOINT_NAME", "Magic Stick LiteLLM"
        ).strip()
        or "Magic Stick LiteLLM",
        ready_file=pathlib.Path(
            os.getenv("ODYSSEUS_BOOTSTRAP_READY_FILE", "/tmp/ready")
        ),
        request_timeout=_bounded_int(
            "ODYSSEUS_BOOTSTRAP_REQUEST_TIMEOUT", 45, 5, 120
        ),
        reconcile_interval=_bounded_int(
            "ODYSSEUS_BOOTSTRAP_RECONCILE_INTERVAL", 300, 30, 3600
        ),
    )


def request_json(
    url: str,
    *,
    timeout: int,
    form: Optional[Dict[str, str]] = None,
) -> Any:
    data = None
    headers = {"Accept": "application/json"}
    if form is not None:
        data = urllib.parse.urlencode(form).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    request = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        # Odysseus may echo form validation details. Do not copy a response
        # body into logs because the submitted form contains the API key.
        raise RuntimeError(f"Odysseus returned HTTP {exc.code}") from exc


def register_endpoint(config: Config) -> Dict[str, Any]:
    result = request_json(
        f"{config.odysseus_url}/api/model-endpoints",
        timeout=config.request_timeout,
        form={
            "name": config.endpoint_name,
            "base_url": config.litellm_url,
            "api_key": config.api_key,
            "require_models": "true",
            "endpoint_kind": "proxy",
            "pinned_models": config.model,
            "shared": "true",
        },
    )
    if not isinstance(result, dict) or not result.get("id"):
        raise RuntimeError("Odysseus returned an invalid endpoint response")

    available = result.get("models") or []
    pinned = result.get("pinned_models") or []
    if config.model not in available and config.model not in pinned:
        raise RuntimeError("Odysseus did not register the selected model")
    return result


def reconcile_forever(config: Config) -> None:
    retry_delay = 5
    ready_announced = False
    while True:
        try:
            result = register_endpoint(config)
            config.ready_file.touch(mode=0o600, exist_ok=True)
            if not ready_announced:
                action = "reconciled" if result.get("existing") else "registered"
                print(
                    f"Odysseus endpoint {action}: "
                    f"model={config.model} endpoint_id={result['id']}",
                    flush=True,
                )
                ready_announced = True
            retry_delay = 5
            time.sleep(config.reconcile_interval)
        except Exception as exc:  # retry transient Odysseus/LiteLLM startup failures
            print(
                f"Odysseus model bootstrap pending: {type(exc).__name__}: {exc}",
                flush=True,
            )
            time.sleep(retry_delay)
            retry_delay = min(retry_delay * 2, 60)


def main() -> None:
    reconcile_forever(load_config())


if __name__ == "__main__":
    main()
