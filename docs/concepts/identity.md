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
Keycloak access token in the shared `MagicStickAccessToken` cookie; Envoy's JWT
filter validates that token and authorizes the selected minimum
`realm_access.roles` value before forwarding to the application. A route can be
made unauthenticated only with explicit `spec.access.authentication: none`.

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

## Implemented Scope

The current implementation provides:

- Envoy Gateway `v1.8.2` as the primary `LoadBalancer` data plane
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
- a non-blocking Keycloak startup reconciliation that adds the callback path
  patterns needed by existing installations
- dashboard API token validation, a minimal user launchpad and viewer/operator/admin authorization
- a public `magicstick-cli` device-flow client and the JWT-protected,
  mDNS-published `api.<mDNS-domain>` route used by the CLI and TUI
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
