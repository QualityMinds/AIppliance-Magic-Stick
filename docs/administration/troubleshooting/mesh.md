# Private Mesh troubleshooting

## Troubleshooting

| Status | Check |
|---|---|
| Connecting | Module rollout, native process and creator HTTPS reachability; allow the next membership refresh. |
| Authentication failed | Invitation expiry/use/revocation, correct device type, creator availability and clock/TLS trust. Never bypass TLS or use a native join token as an application invite. |
| Mesh unavailable | Native image/checksum, runtime restart, relay reachability and UDP/NAT path. |
| LiteLLM unavailable | Existing proxy/database availability, route/key API compatibility and mounted service credentials. |
| Model unavailable | Local ready vLLM/Ollama/FreeToken provenance, explicit sharing, remote roster, disappearance grace and model backend health. |
| Local models unavailable | Read access to KubeAI Models and ModelActivations, Kubernetes API connectivity and module RBAC rollout. |
| 429 | Shared concurrency/RPM/TPM allowance; wait or adjust the exporting node's sharing limits. |
| Local metrics unavailable | Matching LiteLLM callback image/config and optional service-secret mount; never expose the internal metrics endpoint publicly. |

Only `/mesh/enroll` and `/mesh/heartbeat` are Gateway routes. Admin, import,
native console and export surfaces are not public routes. Do not add a generic
`/mesh/*` reverse proxy or expose a model runtime to work around a failed request.
