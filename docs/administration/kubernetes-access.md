# Kubernetes access

## Kubernetes Access Controls

The **Kubernetes Access** tab is visible only to a live
`magicstick-admin` session while local Keycloak identity management is
available. It assigns one direct top-level Keycloak group to an existing human
identity:

| Dashboard level | Keycloak group | Kubernetes authorization |
|---|---|---|
| Viewer | `magicstick-kubernetes-viewer` | Built-in cluster-wide `view`; Secrets remain excluded by Kubernetes. |
| Operator | `magicstick-kubernetes-operator` | Built-in `view` plus CRUD in `ai-system` only for `ModuleActivation`, `ModelActivation`, and `AppInstance`. |
| Cluster Administrator | `magicstick-kubernetes-admin` | Built-in `cluster-admin`; the UI presents an explicit warning. |

Only one of these groups is retained as direct membership. Removing access
removes all three. Protected recovery identities cannot be changed, and a
disabled identity cannot receive a new grant. Every change requests a Keycloak
logout and emits a structured `magicstick.kubernetes-access` audit line without
credentials or request bodies. Download and clipboard copy use the same audited,
read-only kubeconfig retrieval endpoint.

The downloaded or copied kubeconfig contains the Kubernetes cluster CA, the public local
identity CA, issuer/client metadata, and a `client.authentication.k8s.io/v1`
exec stanza for `kubectl oidc-login get-token`. It deliberately contains no
bearer token, refresh token, password, or OAuth client secret. On first use the
plugin starts the Keycloak authorization-code/PKCE login in a browser. This is
the same local Keycloak login for both local users and users brokered from
Entra ID, Google, AWS, or another configured upstream provider.

On appliance K3s, `clusters[].cluster.server` uses the current private
control-plane IP rather than the `.local` hostname. This works in OpenLens and
other clients whose proxy does not use the operating system mDNS resolver. The
OIDC issuer continues to use `id.<mdns-domain>` and its embedded public CA.
Download the kubeconfig again after the appliance receives a different DHCP
address.

Kubeconfig download and clipboard copy remain disabled until the Kubernetes API server has OIDC
enabled and the host or platform administrator has published the non-secret
`identity-system/magicstick-kubernetes-access-info` ConfigMap. Assignment and
download lists are loaded lazily rather than during the dashboard's periodic
refresh.
