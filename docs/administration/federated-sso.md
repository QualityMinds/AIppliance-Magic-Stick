# Federated SSO

## Dashboard-managed federation

Administrators with a Free Registered or Commercial `federated-sso` entitlement configure upstream
identity providers in **System → Settings → Federated SSO**. OIDC providers use their
standard discovery URL and confidential client; SAML providers use active
metadata with a signing certificate. Metadata-selected POST/Redirect bindings
are preserved while response/assertion signature validation stays mandatory.
Magic Stick validates metadata before save and shows the provider-specific
callback `https://id.<domain>/realms/magicstick/broker/<alias>/endpoint`, which
must be registered at the upstream provider.

Authorization mappings are deliberately exact and deny-by-default. Each row
matches one OIDC claim or SAML attribute value and grants exactly one of
`magicstick-user`, `magicstick-viewer`, `magicstick-operator`, or
`magicstick-admin`. Users without a match receive no Magic Stick realm role.
Start with a non-administrator group and validate login and logout before adding
an administrator mapping. Keep the protected local recovery administrator; an
upstream outage or bad mapping must never be the only administration path.

Only dashboard-owned providers marked in Keycloak are shown or edited through
the dashboard. The API
does not expose client secrets, accepts no raw mapper representation and requires
the OIDC secret again for an update. Changes are staged disabled and are enabled
only after all fixed role mappers exist. If entitlement verification later
fails or becomes unavailable, the `keycloak-federation` HTTPRoute protects
`/realms/magicstick/broker` using Envoy external authorization with `failOpen:
false`. The internal `/internal/federation-license` check verifies the current
entitlement on each request. A verifier/API outage therefore blocks external
brokering, not local login, password recovery or the appliance's OIDC clients.
Callback codes are not logged by this guard. This uses Envoy's documented
[external authorization contract](https://gateway.envoyproxy.io/docs/tasks/security/ext-auth/).

A periodic backend check also disables every external identity-provider instance,
including social/custom brokers and providers created outside the dashboard.
It changes only `enabled`, preserving provider configuration, mappings and local
users. Normal dashboard edits still respect provider ownership. Existing sessions
retain their ordinary lifetimes. A live local administrator may delete a managed
provider for recovery; restoring a license does not silently re-enable providers.
Custom gateways must enforce the same broker-path entitlement boundary.

Every user-management request requires a current `magicstick-admin` role. The
backend performs a live Keycloak lookup in addition to normal access-token
validation so a disabled or demoted administrator cannot continue to use a
cached browser token. Mutations are serialized and protect against:

- self-disable, self-delete, and removal of the actor's administrator role
- mutation of the recovery account marked by direct membership in the
  non-editable internal top-level group `/magicstick-recovery`
- removal of the last enabled administrator
- removal of the last enabled local break-glass administrator

Role updates own only `magicstick-user`, `magicstick-viewer`,
`magicstick-operator`, and `magicstick-admin`. Other direct roles and all
group-derived roles are preserved. Disabling an account, reducing its direct
MagicStick access, resetting its password, or deleting it requests a Keycloak
logout. The Keycloak session ends, but an already issued JWT may remain valid
at Envoy's local JWT filter until token expiry. The dashboard user-management
API still denies a disabled or demoted administrator immediately because it
performs a live actor lookup for every request.

The pilot uses the standard HTTPS port `443` through the Envoy `LoadBalancer`
service. Port `80` serves no application content; one catch-all Gateway API
route redirects every HTTP hostname and path to the equivalent HTTPS URL with
status `301`. For example, `http://litellm.magicstick.local/ui/` redirects to
`https://litellm.magicstick.local/ui/` before the normal SSO flow begins. The
`.local` names remain part of the design and can continue to be used by the
later mTLS layer.

## Federated SSO Administration

The **System → Settings → Federated SSO** tab is visible only to `magicstick-admin` when local
Keycloak identity management is active. The tab is disabled until the installed
license contains the `federated-sso` entitlement (Free Registered or Commercial). The
`#/federated-sso` and `#/system/federated-sso` routes redirect to
`#/system/settings/federated-sso`.
Federated SSO is the only license-file-gated capability: listing and recovery deletion
remain possible, while metadata
validation and create/update require a currently valid entitlement and the
packaged implementation. OIDC uses a discovery URL, client ID, client secret and
scopes; SAML uses a metadata URL. Both protocols require one or more exact
upstream claim/attribute mappings to `user`, `viewer`, `operator`, or `admin`.

The browser cannot submit a raw Keycloak provider or mapper. The API accepts a
bounded contract, HTTPS metadata URLs and allowlisted metadata fields, rejects
expired or unsigned SAML metadata, preserves the discovered SAML binding, forces
signature validation, and generates only the four fixed Magic Stick realm-role
mappers. Client secrets are sent only on save, stored in Keycloak, redacted from
all responses and required again for every OIDC update. Providers managed outside
the dashboard and unknown mappers are not adopted or deleted. Entitlement
enforcement also disables external OIDC/SAML providers created directly in Keycloak.

Provider changes use a sanitized expected revision and a single API-process
lock. A provider is staged disabled; mapper failure removes a newly created
provider or leaves an existing provider disabled. A background entitlement check
disables (but does not delete) external OIDC/SAML providers after an invalid,
missing, expired or currently unverifiable license. Local Keycloak login and the
protected recovery administrator stay independent of upstream availability.

Keycloak receives a separate confidential `magicstick-federation-admin` service
account. It has exactly `manage-identity-providers`, `view-identity-providers`
and `view-realm`; it has no user, client, realm, impersonation or cluster access.
The API ServiceAccount can read only its fixed generated Secret through
`federation-admin-rbac.yaml`. Federation audit lines contain actor, action,
target, request ID and result, never request bodies or secrets.
