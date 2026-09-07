# Targeted instance access (Enterprise)

The `resource-sharing` capability adds user/group allow-lists to **AppInstance**
resources. It supplements existing SSO, minimum-role and local/public exposure
settings; those Community functions remain available without a license.
This increment does not add module ACLs, team delegation or resource budgets.

## Dashboard workflow

1. Install the optional Enterprise API implementation and provision/import a
   valid signed license containing `resource-sharing`; see [licensing](licensing.md).
2. In **Dashboard → Services**, expand an application's instances and select
   **Sharing**. Administrators can also select sharing while creating an instance.
3. Keep **All users with the required role**, or select **Selected users or groups**.
4. Search the Keycloak directory, add existing users/groups, review the selection
   and confirm **Save sharing**. A concurrent change requires reopening the dialog
   and reviewing the latest state.

Only a currently enabled, live-verified `magicstick-admin` can change sharing.
The picker uses stable Keycloak IDs, never usernames, emails or group names as
authority. Renaming an identity does not remove its grant; deleting/recreating
one with the same name does not inherit the old grant. Disabled users and service
accounts cannot be selected. Group creation remains in Keycloak, not this UI.
Membership in a subgroup also counts as membership in its parent groups.

A selected user **or** a member of any selected group is granted access, provided
the existing minimum role also allows it. An empty selected list denies everyone.
Selected sharing requires SSO; `authentication: none` cannot bypass it.
Administrators retain the management view but do **not** automatically receive
app access or private instance credentials. Ordinary viewers/operators see only
their permitted instances; membership lists are not disclosed to them.
The basic `magicstick-user` role receives a minimal **My instances** launchpad,
not access to the control-plane/status/admin APIs.

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
have empty lists. Omitting sharing preserves the existing Community behavior.
An older client that omits the field while updating a restricted instance cannot
erase its policy. Restricted-instance updates/deletion require a live admin;
changing the sharing policy additionally requires the entitlement.

| Route | Access/meaning |
|---|---|
| `GET /api/my-instances` | Any Magic Stick user; minimal granted instance names, phases and links |
| `GET /api/instance-principals?kind=users\|groups&search=&first=0` | Live admin + entitlement; directory IDs/names, paginated in batches of 50 |
| `GET /api/instances/{name}/access` | Live admin; current sharing, labels, revision, guard/feature readiness |
| `PUT /api/instances/{name}/access` | Live admin + entitlement + CSRF; `{sharing, expectedRevision}`; atomic Kubernetes `resourceVersion` update |

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
An unrestricted request needs no license or Enterprise import. A restricted
request verifies the signature/expiry/installation binding, implemented capability,
authenticated identity, live enabled status, effective role and current groups.
Arbitrary identity headers from the browser are not trusted.

`EnvoyProxy.spec.filterOrder` places external authorization after JWT/OIDC
authentication. `SecurityPolicy.spec.extAuth.failOpen` is false. The check is a
ClusterIP-only internal route, not a public `/api` operation. Header/cookie
authentication is validated by the API against Keycloak, even after Envoy auth.
The guard returns an empty **200 OK** only on success, as required by the
[Envoy HTTP authorization contract](https://www.envoyproxy.io/docs/envoy/latest/api-v3/extensions/filters/http/ext_authz/v3/ext_authz.proto.html#extensions-filters-http-ext-authz-v3-httpservice);
other status codes, including 204, are not an authorization success.
The separate internal entitlement probe allows the operator to refuse a new
restricted workload without duplicating signature verification in the controller.

The operator waits for the current, accepted guard policy before connecting its
routes to an application backend. `status.accessGuardReady` reports that state;
sharing changes return `409` while it is false. Update the packaged API image
(including `instance_access.py`), backend ConfigMap, gateway filter order, CRD
and controller together. Merely changing the frontend cannot enable this feature.

**Coordinated runtime requirement:** deployment pins must reference a published
API runtime that contains `instance_access.py`, alongside the matching backend
ConfigMap, CRD, controller and gateway policy. The previous license-foundation
image does not contain that integration; applying only the new ConfigMap/controller
against it is not supported. Branch image builds publish immutable SHA tags
without advancing installation channel tags, so matching pins can be verified
before merging. The default image remains Community-only: source integration
does not approve publication of the commercial package or final customer terms.
A full Flux upgrade of an existing physical appliance is a separate acceptance
check from the isolated Rancher tests below.

| Failure | Behavior |
|---|---|
| Missing/expired license, revoked trust, absent Enterprise implementation | Private requests denied; policy retained; new private workloads not reconciled |
| Keycloak/group lookup or API unavailable | Private request denied; no fail-open fallback |
| No selected principals | No app access, including for admin unless explicitly granted later |
| API outage | Instance edge checks fail closed, including unrestricted routes; restore API availability |
| User/group grant removed | Subsequent requests denied; no stored ACL membership cache |
| Policy missing (ordinary Community instance) | Existing SSO/role/exposure behavior; no entitlement requirement |

License expiry does **not** delete workloads or make them public. It pauses use
of restricted instances until a valid entitlement is restored. Admins can still
inspect/manage the resource and remove it. Do not remove policies as an automatic
expiry/recovery action. License/trust/identity changes do not interrupt an already
accepted streaming HTTP request or WebSocket; enforcement is on new requests.

This is **not Kubernetes tenant isolation**. Cluster administrators and operators
with direct workload/Secret/CR permissions, port-forward access or network access
to a backend can bypass the HTTP entry point. Existing arbitrary-code/agent
workloads are not made mutually isolated by these UI ACLs. Do not grant such
privileges to mutually untrusted tenants; network/workload isolation requires
a separate design. External identity federation is also not added here.

## Verification

Unit/API tests: `dashboard/apps/api/test_instance_access.py`; operator guard
tests: `magic-cluster/platform/magicstick-operator/controller/test_controller.py`;
React and CLI tests live next to their client code. The opt-in integration test
uses real Keycloak, Chrome OIDC login, Envoy, API, CRD validation and
signed-license storage:

```bash
docker --context rancher-desktop build -f dashboard/apps/api/Dockerfile \
  --target enterprise -t magicstick-api:sharing-test .
PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright \
  /path/to/venv/bin/python dashboard/apps/api/rancher_sharing_test.py
```

Install `dashboard/apps/api/requirements.txt` and `pyyaml` in that virtualenv.
Node.js, Playwright, Chrome, kubectl and Helm are also required. The browser
helper keeps ephemeral session cookies in a private subprocess pipe, never the
test report. A separate synthetic-fixture Chrome layout/interaction test is
available after `cd dashboard && pnpm build`:

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright \
  node dashboard/apps/api/sharing_browser_test.cjs
```

Run the commands above from the repository root. The frontend fixture test is
not evidence of backend authorization; the Rancher test covers that separately.
The test creates a random namespace/class/release, ephemeral signing keys and
test identities, and removes its resources. It does not replace existing CRDs
or contact the physical server. Abrupt termination can require cleanup of the
printed namespace and its explicitly named test cluster resources. A full Flux
upgrade of an existing physical appliance remains a separate release check.

Local acceptance on 2026-09-06 covered 27 package/security tests, 105 dashboard
API tests, 54 operator tests, 21 identity tests, 24 React tests and 86 CLI tests.
The real Chrome fixture test covered user/group selection, confirmation,
desktop/mobile layout, exact offline license-text downloads and the basic-user
launchpad. In isolated Rancher with
Keycloak 26.6.3 and Envoy Gateway 1.8.2, real browser sessions verified direct
user and nested-group grants, nonmember/admin denial, immediate ACL changes,
concurrent-update rejection and fail-closed trust revocation without deleting
the policy. Community image exclusion and six Kubernetes compositions were
also checked. This is not production multi-tenant isolation acceptance.
