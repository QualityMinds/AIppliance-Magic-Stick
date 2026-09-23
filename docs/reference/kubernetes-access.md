# Kubernetes SSO contract

## Kubernetes SSO Access

Kubernetes access uses the local Keycloak realm as the stable issuer. The
public `magicstick-kubernetes` client permits only authorization-code flow with
PKCE S256 and the kubelogin loopback callbacks on ports `8000` and `18000`. It
has no client secret, direct-password grant, service account, or implicit flow.
The group-membership mapper emits absolute Keycloak group paths in the `groups`
claim. Keeping the leading `/` prevents an identically named nested group from
matching a root-level Kubernetes grant.

The appliance-owned K3s API server trusts:

- issuer `https://id.<mdns-domain>/realms/magicstick`
- client ID `magicstick-kubernetes`
- username claim `preferred_username` with prefix `oidc:`
- groups claim `groups` with prefix `oidc:`
- the public appliance identity CA installed at
  `/etc/rancher/k3s/magicstick-oidc-ca.crt`

RBAC binds only `oidc:/magicstick-kubernetes-viewer`,
`oidc:/magicstick-kubernetes-operator`, and
`oidc:/magicstick-kubernetes-admin`. The Operator role can mutate only Magic
Stick runtime intent CRs in `ai-system` and cannot create arbitrary Deployments
or read Secrets. Cluster Administrator maps to `cluster-admin` and therefore
requires an explicit high-risk choice.

The dashboard generates a kubeconfig only after the host has confirmed this
API-server configuration in the non-secret
`identity-system/magicstick-kubernetes-access-info` ConfigMap. The file uses
`kubectl oidc-login get-token` with keyring-backed token caching. It embeds
public CAs but never credentials. Revoking the direct Keycloak group prevents
new tokens from carrying the Kubernetes group; an already issued token remains
usable until its short expiry, so emergency revocation may additionally require
API-server or realm-session incident procedures.

For appliance-owned K3s, the kubeconfig uses the current private control-plane
IP for `clusters[].cluster.server`. This is intentional: OpenLens and some
other GUI clients resolve names inside their own proxy and may send `.local` to
unicast DNS instead of mDNS. The Keycloak issuer remains the stable
`https://id.<mdns-domain>/realms/magicstick` URL. After a DHCP address change,
download a fresh kubeconfig; the API certificate includes the selected host IP.
