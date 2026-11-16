# SPDX-License-Identifier: BUSL-1.1
"""Fail-closed, pre-OIDC ExtProc gate. Only :authority is inspected."""
import logging
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from concurrent import futures
from concurrent.futures import Future

import grpc
from envoy.service.ext_proc.v3 import external_processor_pb2 as messages
from envoy.service.ext_proc.v3 import external_processor_pb2_grpc as service
from envoy.type.v3 import http_status_pb2

STATUS_URL = "http://magicstick-setup.identity-system.svc.cluster.local:8080/internal/callback-readiness"
READINESS_TIMEOUT_SECONDS = 7
LOGGER = logging.getLogger(__name__)


def unavailable(reason, started, status=None):
    # Fixed reasons and numeric observations only: no host, response body,
    # exception text, cookie or Authorization header enters the diagnostic.
    status = status if isinstance(status, int) and 100 <= status <= 599 else "unknown"
    LOGGER.warning("callback readiness unavailable: reason=%s status=%s elapsed_ms=%d",
                   reason, status, max(0, int((time.monotonic() - started) * 1000)))
    return False


def ready(host):
    started = time.monotonic()
    request = urllib.request.Request(STATUS_URL + "?" + urllib.parse.urlencode({"host": host, "gateway": "1"}), headers={"Cache-Control": "no-store"})
    try:
        with urllib.request.urlopen(request, timeout=READINESS_TIMEOUT_SECONDS) as response:
            if response.status == 204:
                return True
            return unavailable("http_status", started, response.status)
    except urllib.error.HTTPError as error:
        return unavailable("http_status", started, error.code)
    except TimeoutError:
        return unavailable("timeout", started)
    except urllib.error.URLError as error:
        reason = "timeout" if isinstance(error.reason, TimeoutError) else "transport_error"
        return unavailable(reason, started)
    except OSError:
        return unavailable("transport_error", started)


class Gate(service.ExternalProcessorServicer):
    def __init__(self, check=ready):
        self.check = check
        self._inflight = {}
        self._lock = threading.Lock()

    def check_overlapping(self, host):
        """Share only an overlapping complete host-readiness observation.

        This is not user authorization. The actual checker still validates
        current routes/policies, callback ownership and before/after revisions;
        every request subsequently encounters its own authentication guards.
        Remove the flight before publishing its result, so a later request can
        never obtain a completed positive (or negative) decision from this map.
        """
        with self._lock:
            future = self._inflight.get(host)
            owner = future is None
            if owner:
                future = Future()
                self._inflight[host] = future
        started = time.monotonic()
        if not owner:
            try:
                return bool(future.result(timeout=READINESS_TIMEOUT_SECONDS))
            except futures.TimeoutError:
                return unavailable("overlap_timeout", started)
            except Exception:
                return unavailable("overlap_error", started)
        available = False
        try:
            available = bool(self.check(host))
        except Exception:
            unavailable("check_error", started)
        finally:
            with self._lock:
                self._inflight.pop(host, None)
                future.set_result(available)
        return available

    def Process(self, requests, context):
        for request in requests:
            try:
                authorities = [header.raw_value.decode("ascii") if header.raw_value else header.value
                               for header in request.request_headers.headers.headers if header.key == ":authority"]
                authority = authorities[0].lower() if len(authorities) == 1 else ""
                host = authority[:-4] if authority.endswith(":443") else authority
                available = request.WhichOneof("request") == "request_headers" and bool(host) and self.check_overlapping(host)
            except Exception:
                available = False
            if not available:
                yield messages.ProcessingResponse(immediate_response=messages.ImmediateResponse(
                    status=http_status_pb2.HttpStatus(code=503),
                    body=b"Sign-in is waiting for identity callback verification. Please retry shortly."))
                return
            yield messages.ProcessingResponse(request_headers=messages.HeadersResponse(
                response=messages.CommonResponse(status=messages.CommonResponse.CONTINUE)))


def start(port=8081, cert_dir="/etc/magicstick-callback-gate"):
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=64), options=[("grpc.max_receive_message_length", 131072)])
    service.add_ExternalProcessorServicer_to_server(Gate(), server)
    directory = Path(cert_dir)
    credentials = grpc.ssl_server_credentials(((directory.joinpath("tls.key").read_bytes(), directory.joinpath("tls.crt").read_bytes()),))
    if not server.add_secure_port("[::]:" + str(port), credentials):
        raise RuntimeError("Callback gate could not bind its internal port")
    server.start()
    return server
