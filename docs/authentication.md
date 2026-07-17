# Authentication and SSO

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
| `magicstick-user` | Authenticated application user |
| `magicstick-viewer` | Read-only dashboard and status access |
| `magicstick-operator` | Runtime application and model operations |
| `magicstick-admin` | Identity, security, and appliance administration |

Authentication and authorization remain separate. Envoy proves the identity
and forwards the OIDC access token. The dashboard API validates that token with
Keycloak and checks the relevant role before every operation. Upstream groups
should be mapped to these local roles in Keycloak.

Dashboard access is hierarchical: viewer permits read-only endpoints, operator
also permits module, instance, model, and credential operations, and admin also
permits appliance-wide settings changes. `magicstick-user` alone does not grant
dashboard access.

AppInstance access uses the same hierarchy at the Envoy edge. OIDC stores the
Keycloak access token in the shared `MagicStickAccessToken` cookie; Envoy's JWT
filter validates that token and authorizes the selected minimum
`realm_access.roles` value before forwarding to the application. A route can be
made unauthenticated only with explicit `spec.access.authentication: none`.

Human browser sessions use OIDC Authorization Code Flow. Machine clients must
use separate clients and policies (service accounts, JWT validation, mTLS, or a
combination); they must not reuse browser cookies or the human gateway client.

## Implemented Scope

The current implementation provides:

- Envoy Gateway `v1.8.2` as the primary `LoadBalancer` data plane
- Keycloak with PostgreSQL in namespace `identity-system`
- runtime-generated database, bootstrap-admin, and OIDC client secrets
- a first-run wizard that creates the first human and recovery administrators
  without storing their passwords in Kubernetes
- a scoped Keycloak service account for setup, user management, and callback reconciliation
- a self-signed pilot certificate for local `.local` hostnames
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
- dashboard API token validation and viewer/operator/admin authorization
- protected local and public routes for LiteLLM, AnythingLLM, and KubeOpenCode
  with a minimum `magicstick-user` role
- removal of the bundled dashboard and AI application `Ingress` resources
- no human default password on new installations

The pilot uses the standard HTTPS port `443` through the Envoy `LoadBalancer`
service. The `.local` names remain part of the design and can continue to be
used by the later mTLS layer.

## Run the Pilot

Wait until both Flux waves are ready:

```bash
kubectl -n flux-system get kustomizations envoy-gateway identity-pilot
kubectl -n envoy-gateway-system get helmrelease envoy-gateway
kubectl -n identity-system get pods,gateway,httproute,securitypolicy
```

Read the address of the generated Envoy service:

```bash
kubectl -n envoy-gateway-system get service \
  -l gateway.envoyproxy.io/owning-gateway-namespace=identity-system,gateway.envoyproxy.io/owning-gateway-name=identity-pilot \
  -o wide
```

Resolve the identity, pilot, and dashboard names to the reported LoadBalancer address with local DNS or
temporary hosts-file entries. Rancher Desktop commonly exposes the service on
the address shown for the Envoy service:

```text
192.168.64.2 id.magicstick.local auth-pilot.magicstick.local magicstick.local
```

For a new installation, complete the physical-console claim flow described in
[first-run-setup.md](first-run-setup.md). There is no Kubernetes Secret that
contains the first administrator's password.

Open `https://auth-pilot.magicstick.local`. Accept the pilot's self-signed
certificate only in the isolated development environment. The request must be
redirected to Keycloak and return to the protected success page after login.

Open `https://magicstick.local` to validate the real dashboard route. After
login, the administrator created during first-run setup can use all dashboard
operations. `/logout` clears the Envoy browser session.

On a host-local K3s appliance, Gateway-aware kdns publishes the annotated local
routes automatically. Rancher Desktop keeps multicast inside its Linux VM; use
`magic-cluster/platform/basis/kdns/publish-rancher-desktop-mdns.sh` on macOS
while testing so the same accepted routes are published through the host mDNS
responder.

## Production Migration

The remaining rollout is intentionally incremental:

1. Replace the pilot certificate with the appliance certificate trust model.
2. Add separate machine clients and JWT/mTLS policies for APIs and agents.
3. Configure optional upstream identity providers and group-to-role mappings.

All bundled browser surfaces are represented by Envoy `HTTPRoute` resources.
An additional Envoy API gateway is not needed for the authentication layer.

## Secret and Recovery Rules

- Secrets are generated at runtime and never committed.
- Identity database storage must be backed up before production use.
- Realm configuration changes after the first import must be managed through a
  reviewed realm export or an administration workflow; restarting Keycloak does
  not overwrite an existing realm. The scoped startup reconciliation is the
  reviewed exception for the human gateway callback patterns and web origins.
- Save and test the one-time recovery administrator created by first-run setup.
- A cloud identity provider outage must not prevent local break-glass login.
