# SPDX-License-Identifier: BUSL-1.1
"""Fail-closed, pre-OIDC ExtProc gate. Only :authority is inspected."""
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from concurrent import futures

import grpc
from envoy.service.ext_proc.v3 import external_processor_pb2 as messages
from envoy.service.ext_proc.v3 import external_processor_pb2_grpc as service
from envoy.type.v3 import http_status_pb2

STATUS_URL = "http://magicstick-setup.identity-system.svc.cluster.local:8080/internal/callback-readiness"


def ready(host):
    request = urllib.request.Request(STATUS_URL + "?" + urllib.parse.urlencode({"host": host, "gateway": "1"}), headers={"Cache-Control": "no-store"})
    try:
        with urllib.request.urlopen(request, timeout=7) as response:
            return response.status == 204
    except (OSError, urllib.error.URLError):
        return False


class Gate(service.ExternalProcessorServicer):
    def __init__(self, check=ready):
        self.check = check

    def Process(self, requests, context):
        for request in requests:
            try:
                authorities = [header.raw_value.decode("ascii") if header.raw_value else header.value
                               for header in request.request_headers.headers.headers if header.key == ":authority"]
                authority = authorities[0].lower() if len(authorities) == 1 else ""
                host = authority[:-4] if authority.endswith(":443") else authority
                available = request.WhichOneof("request") == "request_headers" and bool(host) and self.check(host)
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
