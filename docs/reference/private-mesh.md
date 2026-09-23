# Private Mesh routing contract

## LiteLLM keys and local priority

The control plane uses the existing master key solely for scoped route/key
management. Each exported model receives a separate null-user service key with
an exact `share/...` allowlist, chat-only allowed routes, concurrency/RPM/TPM
limits and a 24-hour lifetime. It is rotated before expiry. Neither the key nor
the master credential enters Mesh configuration or peer traffic.

The LiteLLM callback derives traffic class from the authenticated key and trusted
router deployment. It strips client priorities. Local vLLM requests get priority
`0`; mesh-export requests get `10`. Managed vLLM wrappers enforce
`--scheduling-policy priority`. Lower numbers run first in the scheduler; this
is not a GPU partition or an unconditional preemption/latency guarantee.
Existing already-running model pods need a normal controlled rollout to acquire
the new scheduler argument. Do not claim priority enforcement on old pods.
Ollama and FreeToken aliases never receive vLLM's `priority` parameter. They
retain the same remote concurrency/rate limits, but do not promise a lower
engine-internal queue priority. Logical local-first routing and remote fallback
work for catalog-managed local routes of all three engines.

The bridge additionally applies per-model remote concurrency, RPM, TPM, context
and output limits. There is no waiting queue: a busy remote allowance returns
429 with a retry hint. Local requests do not consume this remote allowance.
The context budget is conservative UTF-8 bytes plus chat/template allowance and
reserved output, not an exact model tokenizer count. Requests are rejected,
not silently truncated. Arbitrary URLs, credentials, fallbacks and provider
parameters are not forwarded.
