# Instance access contract

## Runtime/API contract

Optional `AppInstance.spec.access.sharing`:

```yaml
access:
  authentication: sso
  role: user
  exposure: local
  sharing:
    mode: selected
    users: [11111111-1111-4111-8111-111111111111]
    groups: [22222222-2222-4222-8222-222222222222]
```

`mode` is `all` or `selected`. Each list has at most 100 unique IDs. `all` must
have empty lists. Omitting sharing preserves the role-based behavior.
An older client that omits the field while updating a restricted instance cannot
erase its policy. Restricted-instance updates, deletion and sharing-policy changes require a live admin.

| Route | Access/meaning |
|---|---|
| `GET /api/my-instances` | Any Magic Stick user; minimal granted instance names, phases and links |
| `GET /api/instance-principals?kind=users\|groups&search=&first=0` | Live admin; directory IDs/names, paginated in batches of 50 |
| `GET /api/instances/{name}/access` | Live admin; current sharing, labels, revision, guard readiness |
| `PUT /api/instances/{name}/access` | Live admin + CSRF; `{sharing, expectedRevision}`; atomic Kubernetes `resourceVersion` update |

Shared `/api/instances`, `/api/appliance`, `/api/modules`, `/api/status` and
`/api/events` reads remove hidden instances and derived links/workload references.
Credential requests independently check the grant. The CLI/TUI use the same
filtered backend; assignment is offered in the React dashboard and CLI.

```bash
magicstick instance principals --kind users --search example --json
magicstick instance principals --kind groups --search team --json
magicstick instance access hermes-example --json
magicstick instance share hermes-example --file /path/to/policy.json --yes
```

The policy file contains only `mode`, `users` and `groups`. The CLI reads the
current revision and sends it with the change; it never silently retries a
conflict. Updates through the dedicated sharing endpoint emit a
`magicstick.instance-sharing` audit event with
actor ID, instance name, mode and result, without tokens or full membership lists.
Kubernetes audit configuration is required for a complete lifecycle record,
including initial instance creation and direct cluster writes.

## Enforcement and rollout

The operator installs an Envoy HTTP external-authorization check for **every**
instance route, including currently unrestricted routes. This avoids an old
public route remaining usable when a restriction is first added. The check is
bound to the AppInstance name **and UID**; a reused name does not reuse a grant.
A restricted request verifies authenticated identity, live enabled status,
effective role and current groups. Arbitrary identity headers from the browser
are not trusted. Neither restricted nor unrestricted decisions require a license.

`EnvoyProxy.spec.filterOrder` places external authorization after JWT/OIDC
authentication. `SecurityPolicy.spec.extAuth.failOpen` is false. The check is a
ClusterIP-only internal route, not a public `/api` operation. Header/cookie
authentication is validated by the API against Keycloak, even after Envoy auth.
The guard returns an empty **200 OK** only on success, as required by the
[Envoy HTTP authorization contract](https://www.envoyproxy.io/docs/envoy/latest/api-v3/extensions/filters/http/ext_authz/v3/ext_authz.proto.html#extensions-filters-http-ext-authz-v3-httpservice);
other status codes, including 204, are not an authorization success.

The operator waits for the current, accepted guard policy before connecting its
routes to an application backend. `status.accessGuardReady` reports that state;
sharing changes return `409` while it is false. Update the packaged API image
(including `instance_access.py`), backend ConfigMap, gateway filter order, CRD
and controller together. Merely changing the frontend cannot enable this feature.

**Coordinated runtime requirement:** deployment pins must reference a published
API containing `instance_access.py` and `magicstick_core.sharing`, with matching
ConfigMap, CRD, controller and gateway policy. Update these together.
A full Flux upgrade of a physical appliance is a separate acceptance check.

| Failure | Behavior |
|---|---|
| Keycloak/group lookup or API unavailable | Private request denied; no fail-open fallback |
| No selected principals | No app access, including for admin unless explicitly granted later |
| API outage | Instance edge checks fail closed, including unrestricted routes; restore API availability |
| User/group grant removed | Subsequent requests denied; no stored ACL membership cache |
| Policy missing (ordinary instance) | Existing SSO/role/exposure behavior; no entitlement requirement |

License expiry does not affect Resource Sharing. An identity or ACL change
does not interrupt an already accepted streaming HTTP request or WebSocket;
enforcement is on new requests. Never remove policies as an automatic recovery
action.

This is **not Kubernetes tenant isolation**. Cluster administrators and operators
with direct workload/Secret/CR permissions, port-forward access or network access
to a backend can bypass the HTTP entry point. Existing arbitrary-code/agent
workloads are not made mutually isolated by these UI ACLs. Do not grant such
privileges to mutually untrusted tenants; network/workload isolation requires
a separate design. External identity federation is also not added here.
