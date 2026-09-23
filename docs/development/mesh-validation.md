# Private Mesh validation

## Versions and verification

Use the reviewed source/image pins rather than copying a second version inventory:

- The [Mesh Deployment](../../magic-cluster/apps/ai/private-mesh/deployment.yaml)
  selects the immutable runtime digest. Publishing a readable tag alone does not
  update existing appliances. Record the source revision and actual image ID for
  each acceptance run.
- [MeshLLM v0.76.2](https://github.com/Mesh-LLM/mesh-llm/tree/v0.76.2), commit
  `a0c1e66b0ac037dd56544b9e2d94969ea43d694f`, native policy patch applied only to
  this exact source. No native inference libraries/weights are bundled.
- [openai-endpoint v0.2.0](https://github.com/Mesh-LLM/openai-endpoint/tree/v0.2.0),
  commit `9166c6a918cda73fe4c05912ed9b06446bb95e60`, plugin protocol generation 3.
- The [LiteLLM Deployment](../../magic-cluster/apps/ai/litellm/base/deployment.yaml)
  pins the proxy version. Verify dynamic model/key APIs, explicit allowed routes,
  trusted callbacks and order-based routing when updating it. The adapter keeps
  explicit route lists instead of relying on a key-type shortcut.
- Existing vLLM CPU/NVIDIA v0.23.0 and AMD/Intel v0.26.0; the
  [priority scheduler](https://docs.vllm.ai/en/v0.26.0/api/vllm/v1/core/sched/scheduler/)
  supports server-assigned request priorities.

The source includes unit/API/UI tests, `probe_litellm.py` for non-mutating tests
against the actual LiteLLM library, and an isolated `e2e-job.yaml` with real
Mesh A/B/C, two LiteLLM proxies and one real CPU vLLM using tiny, deterministic
synthetic Qwen2 weights generated in the test Job. This verifies inference
routing and authorization, not model quality or GPU performance, and needs no
model download. The E2E fixture uses its
own local inventory and ephemeral signed mesh identities instead
of production Kubernetes discovery. It does not replace a
two-appliance cross-NAT acceptance test. It creates no production model routes.

Build/test resources are intentionally excluded from Kustomize. Use the
developer build Job only in its disposable test namespace, provide its source
ConfigMap, then the acceptance source ConfigMap, and delete that namespace when
finished. Record actual results separately from code/render checks.

The transport build source comes from
`core/magicstick_core/private_mesh/native/`. Build the release image
with repository-root context and
`-f magic-cluster/apps/ai/private-mesh/Dockerfile`. Run access-boundary tests with
`python -m unittest discover -s magic-cluster/apps/ai/private-mesh -p 'test_*.py'`
after installing that directory's requirements. Test fixtures are never copied
into the release image.

Before release, follow [the release gates](release-checklist.md#private-mesh-release-gates):
native/E2E results, real appliance routing, network policy, disconnected/revoked
clients, relay-only networks, companion launch/signing and immutable images.

### Acceptance scope

Unit and fixture checks do not prove physical-appliance operation. Record the
source revision, image digests and environment for each run. Real cross-NAT and
two-appliance tests, companion signing and deployment-level RBAC/network-policy
acceptance remain separate release gates. No license key or file is needed for
these checks; signed mesh membership is still required.
