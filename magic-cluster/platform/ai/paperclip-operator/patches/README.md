# Paperclip operator compatibility patch

MagicStick builds `paperclip-operator` from the upstream `v0.18.0` source with
[`local-trusted-loopback.patch`](local-trusted-loopback.patch).

Upstream `v0.18.0` always emits `PAPERCLIP_BIND=custom` and
`PAPERCLIP_BIND_HOST=0.0.0.0`. The Paperclip application rejects that
combination when `deployment.mode=local_trusted`, so a no-second-login instance
cannot start in Kubernetes. The patch preserves the upstream network bind for
authenticated instances and selects loopback only for `local_trusted`.

The MagicStick Paperclip instance chart pairs the loopback listener with a
hardened in-pod TCP proxy bound only to the Pod IP. The ClusterIP Service and
authenticated Envoy Gateway route reach that proxy; Paperclip itself remains
loopback-only.

The build workflow checks out the exact upstream tag, applies this patch, runs
the upstream Go tests, and publishes an amd64/arm64 image tagged with the
MagicStick commit SHA. Remove the patch and return to the upstream operator
image once an upstream release provides an equivalent mode-aware bind.
