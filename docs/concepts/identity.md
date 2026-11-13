# Identity and security

Magic Stick uses a local-first identity architecture. Keycloak is the local
OpenID Connect (OIDC) provider and identity broker. Envoy Gateway enforces the
login before a protected HTTP route reaches an application. The appliance can
therefore authenticate users while fully disconnected from cloud services.

Envoy Gateway is the only installed application gateway. The dashboard, all
operator-managed AppInstances, LiteLLM, AnythingLLM, and the KubeOpenCode
server use authenticated Gateway API resources. The bundled installation
contains no application `Ingress` resources.

## Target Architecture

```text
Browser
  -> Envoy Gateway
     -> OIDC login at local Keycloak
        -> local user database (offline)
        -> optional upstream Entra ID, Google, AWS, or another OIDC/SAML IdP
     -> authenticated request to dashboard or application

kubectl
  -> OIDC exec credential plugin
     -> the same local Keycloak login and optional upstream broker
     -> short-lived ID token with direct Magic Stick Kubernetes groups
  -> Kubernetes API server OIDC authentication and RBAC

magicstick CLI or TUI
  -> public Keycloak device-flow client
     -> browser verification or a URL plus one-time code
     -> short-lived access token with the same Magic Stick realm roles
  -> Envoy JWT policy on api.<mDNS-domain>
  -> dashboard control-plane API authorization

attached appliance monitor (TUI)
  -> confidential magicstick-console client, secret mounted in-cluster only
     -> short-lived token of the local console service account, no user or browser
  -> cluster-internal dashboard API, which reads the console's current roles
     from Keycloak on every authorization
```

Applications trust one stable local issuer. External enterprise identity
providers are configured as upstream identity providers in Keycloak rather
than integrated separately into every application. Replacing an upstream
provider therefore does not change application routes or their OIDC clients.

Supported operating modes are:

| Mode | Login path | Internet required |
|---|---|---|
| Local standalone | Keycloak local account | No |
| Brokered enterprise | Keycloak forwards to Entra ID, Google, AWS, or another supported IdP | Only for the selected upstream IdP |
| Direct external provider | A deployment overlay replaces the OIDC provider settings at the gateway | Yes; intended as an escape hatch |

The recommended production mode is local Keycloak with optional upstream
brokering. Keep at least one protected local break-glass administrator account
so an upstream outage does not lock administrators out of the appliance.

## Authorization Model

The local realm defines four initial roles:

| Role | Intended access |
|---|---|
| `magicstick-user` | Authenticated application user; minimal dashboard My instances launchpad |
| `magicstick-viewer` | Read-only dashboard and status access |
| `magicstick-operator` | Runtime application and model operations |
| `magicstick-admin` | Identity, security, and appliance administration |

Authentication and authorization remain separate. Envoy proves the identity
and forwards the OIDC access token only to backends that consume it. The
dashboard API validates that token with Keycloak and checks the relevant role
before every operation. LiteLLM remains protected by the same edge login and
role policy, but does not receive the OIDC token in `Authorization` because that
header belongs to LiteLLM's own `Bearer sk-...` API authentication. Upstream
groups should be mapped to the local Magic Stick roles in Keycloak.

Dashboard access is hierarchical: viewer permits read-only endpoints, operator
also permits module, instance, model, and credential operations, and admin also
permits appliance-wide settings and human-user administration. `magicstick-user`
alone receives only the dashboard **My instances** launchpad and its minimal
session/instance API; it does not grant control-plane or status access.

AppInstance access uses the same hierarchy at the Envoy edge. OIDC stores the
Keycloak access token in a host-only `__Host-MagicStickAccessToken` cookie;
Envoy's JWT filter validates that token and authorizes the selected minimum
`realm_access.roles` value before forwarding to the application. A route can be
made unauthenticated only with explicit `spec.access.authentication: none`.

Browser token cookies are scoped to the exact application hostname, never the
shared appliance domain. The login provider remains shared, so visiting another
service can reuse its sign-in without copying that service's token cookies to
siblings. A global sign-out invalidates the central session; the edge checks
session validity before forwarding later requests, even when another host still
has an old cookie. Legacy Magic Stick token cookies are removed narrowly;
unrelated application cookies are not erased.

The Gateway denies access when an authentication policy is missing and retains
the callback check when a route-specific gate disappears. Admission rejects
unsafe overrides and deletion of these baselines. Fresh activation requires a
real admission deny probe, not only a rendered manifest. See
[identity validation](../development/identity-validation.md).

The core [instance-sharing capability](../user-guide/sharing.md) adds
allow-lists of stable Keycloak user and group IDs. For restricted instances, the
API and gateway guard also verify live user status, effective minimum role,
group membership (including subgroups). No license file is required for instance sharing. Administrators
retain management visibility, but require an explicit grant to use the app or
retrieve its private credentials. These are HTTP access controls, not Kubernetes
tenant/network isolation.

Human browser sessions use OIDC Authorization Code Flow. Human `kubectl`
sessions use a separate public PKCE client and an exec credential plugin. The
Magic Stick CLI and TUI use a third public client with Device Authorization
Flow and send its Bearer access token to the dedicated control-plane API route.
None of these clients reuse browser cookies, client secrets, or each other's
client ID. Unattended machine integrations still need their own policy and
credential lifecycle; a renewable human device session is not a service
account.

The monitor attached to the appliance is the one deliberate exception to a
personal login. It signs in automatically as the **Local console** service
account so the appliance stays operable at the machine itself without a network
or a second device. Physical access to that keyboard therefore equals the
configured dashboard access: Administrator by default, or Operator, Viewer or
Off as chosen by an administrator. The identity has dashboard roles only, is
hidden from user lists, cannot be used to sign in to the browser dashboard or
`kubectl`, and a console with a lowered level cannot raise it again. Its tokens
are accepted only on the cluster-internal API connection, never through a
network-facing route. Root on the host, Kubernetes cluster administrators and
Keycloak administrators can read the generated secret; they already hold
equivalent or broader access. See
[automatic sign-in](../reference/cli.md#automatic-sign-in).

## Browser session lifetime

Local Keycloak login offers its native **Remember me** checkbox. Normal SSO
sessions retain a 1,800-second idle timeout and a 36,000-second maximum.
Opted-in sessions use 604,800 seconds idle and 2,592,000 seconds maximum.
Access tokens remain 300 seconds; Envoy renews them using the existing refresh
flow. Browser restart and standby do not revoke the remembered session, but
explicit logout and the absolute maximum still end it. Use a fresh login to
opt in after an upgrade. See [Keycloak session timeouts](https://www.keycloak.org/docs/latest/server_admin/#_timeouts).

The realm import contains these defaults. Existing realms are reconciled once
by `keycloak-session-policy.sh` in both Keycloak startup paths. Migration version
`magicstickRememberMePolicyVersion=1` is stored in the realm attributes. Only
the unchanged original policy (`rememberMe=true`, 300/1,800/36,000-second token
and normal limits, both remember-me limits zero) is upgraded. Custom/disabled
policies are retained and marked as reviewed, with a sanitized message. A repeat
does not reapply defaults or overwrite later administrator changes.

Reads use the existing scoped setup client; writes authenticate separately with
the already provisioned bootstrap administrator. No Dashboard service account
receives `manage-realm`. Authentication, read, version, concurrent-change, write
and verification failures stop this migration with a fixed diagnostic code; they
never enable an unauthenticated fallback. Other realm attributes, ordinary
session policy, API keys and API token validation are unchanged. See the
[isolated session checks](../development/identity-validation.md#session-policy-and-remember-me).

## Hostname changes and callback readiness

The first-run wizard and Settings save the configured local and public hosts.
Flux updates the identity routes and runs the existing Keycloak startup
reconciliation. Importing a changed realm file alone does not replace clients
already stored in Keycloak's database.

The startup hook now completes in the foreground, without opening process 1's
file descriptors. The existing scoped setup client updates only the configured
human gateway redirect URIs, web origins and logout callbacks. Readback verifies
the same client identity and exact redirect/origin sets before startup succeeds;
failed writes, stale data or failed companion-client synchronization fail the
hook instead of leaving a Ready server with old callbacks. Existing users,
credentials, roles and unrelated client attributes are preserved. Callback
paths for instances remain scoped to the explicit configured hosts; no wildcard
host, additional realm permission or AppArmor ptrace grant is introduced.
The existing administrative clients reconcile only role differences: an exact
direct mapping is verified without posting the same grant again. Missing or
unexpected mappings still require the existing authority and exact final
readback; denied changes do not become success. Retry decisions are bounded by
both the attempt limit and a ten-minute elapsed-time budget. Fixed step codes
identify a failed companion-client reconciliation without exposing raw errors.

After an approved name change, wait for identity reconciliation to finish and
open the new dashboard URL again. A saved authorization URL can contain stale
login state; it is not a new login attempt. See the
[callback validation procedure](../development/identity-validation.md#hostname-and-callback-reconciliation).

## Implemented Scope

The current implementation provides:

- Envoy Gateway `v1.8.5` with Envoy Proxy `v1.38.7` as the primary `LoadBalancer` data plane
- Keycloak with PostgreSQL in namespace `identity-system`
- runtime-generated database, bootstrap-admin, and OIDC client secrets
- a first-run wizard that creates the first human and recovery administrators
  without storing their passwords in Kubernetes
- a scoped Keycloak setup service account for first-run and callback
  reconciliation
- a separate `magicstick-user-admin` service account for dashboard user
  administration; it has user-query and user-management roles but no client,
  realm, impersonation, or identity-provider administration role
- a separate `magicstick-federation-admin` service account for licensed
  dashboard federation; it has only identity-provider view/manage plus
  `view-realm`, and no user, client, realm-management, or impersonation role
- an appliance-local identity CA and a CA-signed certificate for local
  `.local` hostnames; the public CA can be embedded in OIDC kubeconfigs
- an unprotected Keycloak route and a protected `auth-pilot` test route
- protected local and public dashboard `HTTPRoute` resources
- operator-generated local and public AppInstance `HTTPRoute` resources with
  default SSO and optional user/viewer/operator/admin minimum roles
- removal of edge-managed OIDC cookies before requests reach the Hermes API
  gateway; authorization is completed at Envoy and the access token is
  forwarded in the `Authorization` header
- per-instance callback routes on the shared dashboard hosts, so the same
  Keycloak client and browser session protect dynamically created instances
- a verified foreground Keycloak startup reconciliation for configured callback
  hosts and the instance callback paths needed by existing installations
- dashboard API token validation, a minimal user launchpad and viewer/operator/admin authorization
- a public `magicstick-cli` device-flow client and the JWT-protected,
  mDNS-published `api.<mDNS-domain>` route used by the CLI and TUI
- a confidential `magicstick-console` service-account client for automatic
  sign-in of the attached monitor, with an administrator-controlled access level
- protected local and public routes for LiteLLM, AnythingLLM, and KubeOpenCode
  with a minimum `magicstick-user` role
- LiteLLM-specific OIDC token forwarding disabled after edge authorization, so
  its UI and API retain their own virtual-key `Authorization` header
- removal of the bundled dashboard and AI application `Ingress` resources
- no human default password on new installations
- a public PKCE client `magicstick-kubernetes`, a `groups` token mapper, and
  direct Viewer/Operator/Administrator groups for human Kubernetes access

The dashboard API accepts access tokens only when their `azp` is the browser
gateway client or `magicstick-cli`, their issuer matches the local realm, they
are unexpired, Keycloak still accepts them through `userinfo`, and the required
realm role is present. The edge JWT policy is an additional validation layer,
not a replacement for API authorization.

### Gateway patch updates

Both the identity gateway and temporary first-run gateway explicitly select the
patched Envoy Proxy image. The Helm default alone is insufficient: an attached
`EnvoyProxy` without a merge type replaces the controller default.
The selected same-series patches follow the upstream
[Envoy Gateway v1.8.5 upgrade guidance](https://gateway.envoyproxy.io/news/releases/notes/v1.8.5/)
and include fixes for authentication-filter crashes. This is not proof that a
historical, unsymbolized native crash had one particular upstream cause.

Upgrading from the older OIDC cookie format can require users to sign in once
again; it does not remove local accounts. Validate authenticated dashboard and
application access plus module/route disable, re-enable and cleanup without
proxy restarts after a gateway update. Do not bypass TLS, authentication or the
regression cleanup fence if that check fails.
