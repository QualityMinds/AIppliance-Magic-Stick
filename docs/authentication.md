# Authentication and SSO

Magic Stick uses a local-first identity architecture. Keycloak is the local
OpenID Connect (OIDC) provider and identity broker. Envoy Gateway enforces the
login before a protected HTTP route reaches an application. The appliance can
therefore authenticate users while fully disconnected from cloud services.

This page describes the target architecture and the first isolated pilot. Envoy
Gateway is the only installed application gateway. The pilot does not yet move
the dashboard or existing applications to authenticated `HTTPRoute` resources;
their legacy `Ingress` objects are therefore intentionally not served.

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
and can enforce route-level policy. The dashboard API must additionally check
the relevant role before permitting configuration changes. Upstream groups
should be mapped to these local roles in Keycloak.

Human browser sessions use OIDC Authorization Code Flow. Machine clients must
use separate clients and policies (service accounts, JWT validation, mTLS, or a
combination); they must not reuse browser cookies or the human gateway client.

## Pilot Scope

The first implementation adds:

- Envoy Gateway `v1.8.2` as the primary `LoadBalancer` data plane
- Keycloak with PostgreSQL in namespace `identity-system`
- runtime-generated database, bootstrap-admin, local-admin, and OIDC client secrets
- a self-signed pilot certificate for local `.local` hostnames
- an unprotected Keycloak route and a protected `auth-pilot` route
- a local `local-admin` account for end-to-end validation

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

Resolve both pilot names to the reported LoadBalancer address with local DNS or
temporary hosts-file entries. Rancher Desktop commonly exposes the service on
`127.0.0.1`:

```text
127.0.0.1 id.magicstick.local auth-pilot.magicstick.local
```

Read the generated login credentials locally (do not paste them into tickets or
logs):

```bash
kubectl -n identity-system get secret keycloak-local-admin \
  -o jsonpath='{.data.username}' | base64 --decode
kubectl -n identity-system get secret keycloak-local-admin \
  -o jsonpath='{.data.password}' | base64 --decode
```

Open `https://auth-pilot.magicstick.local`. Accept the pilot's self-signed
certificate only in the isolated development environment. The request must be
redirected to Keycloak and return to the protected success page after login.

## Production Migration

The remaining rollout is intentionally incremental:

1. Replace the pilot certificate with the appliance certificate trust model.
2. Protect the dashboard route and enforce roles in the dashboard API.
3. Move static web applications to `HTTPRoute` resources and the shared human
   OIDC policy.
4. Teach the Magic Stick Operator to generate authenticated routes for every
   `AppInstance`.
5. Add separate machine clients and JWT/mTLS policies for APIs and agents.
6. Configure optional upstream identity providers and group-to-role mappings.
7. Delete obsolete application `Ingress` resources after every replacement
   `HTTPRoute` has passed its rollback checks.

During migration, only routes already represented by Envoy `HTTPRoute`
resources are externally reachable. An additional Envoy API gateway is not
needed for the authentication layer.

## Secret and Recovery Rules

- Secrets are generated at runtime and never committed.
- Identity database storage must be backed up before production use.
- Realm configuration changes after the first import must be managed through a
  reviewed realm export or an administration workflow; restarting Keycloak does
  not overwrite an existing realm.
- Production deployments must rotate the pilot account and client secret and
  document break-glass access.
- A cloud identity provider outage must not prevent local break-glass login.
