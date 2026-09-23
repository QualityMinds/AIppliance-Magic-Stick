# Access and identity troubleshooting

## Instance sharing checks

Administrators configure **Dashboard → Services → instance → Sharing**.
Ordinary users receive only their granted instances. Inspect
`AppInstance.status.accessGuardReady` and the current Envoy `SecurityPolicy`
conditions before changing an existing instance's sharing. The operator leaves
routes without a backend until their guard is accepted for the current generation.
The packaged API, backend ConfigMap, CRD, controller and Envoy filter order must
be upgraded together. An API outage fails instance edge authorization closed.

If an authorized user is denied, check the live user enabled state, minimum role,
stable selected IDs, current group membership and access-guard readiness. Resource
Sharing does not depend on license validity; an access error never makes an instance public. Do not delete its sharing policy to silence an error. Active streams are
not retroactively disconnected. Cluster/port-forward/workload privileges remain
outside this browser-level sharing boundary. See [instance-sharing.md](../../user-guide/sharing.md).

## User Administration Checks

The dashboard **System → Users** tab is available only to `magicstick-admin` while local
Keycloak identity management is enabled. Opening the tab performs a live
Keycloak request; it is intentionally not included in the normal 30-second
dashboard refresh.

Check the dashboard API, dedicated Secret, and narrowly scoped Secret RBAC
without decoding any credentials:

```bash
kubectl -n dashboard get deploy ai-appliance-dashboard
kubectl -n identity-system get deploy,service ai-appliance-dashboard-api
kubectl -n identity-system get role,rolebinding ai-appliance-dashboard-user-admin-client
kubectl -n identity-system get secret magicstick-user-admin-client
kubectl -n identity-system logs deploy/ai-appliance-dashboard-api -c api --tail=200
```

The Role must grant `get` only for
`Secret/magicstick-user-admin-client`. It must not grant `list` or `watch`, and
the API ServiceAccount must not be able to read the bootstrap or setup client
Secrets. The frontend Deployment must keep
`automountServiceAccountToken: false`.

User mutations emit structured `magicstick.user-admin` audit lines containing
the request ID, actor, target, action, result, and status. They deliberately omit
passwords, request bodies, client secrets, and tokens. A `403` on the user API
can mean that the browser token lacks `magicstick-admin` or that a live
Keycloak check found the actor disabled or demoted. A `409` normally indicates
a duplicate identity, an unsupported action on an external or protected user,
or the last-local-administrator guard. A `503` indicates that Keycloak or the
dedicated client configuration is unavailable.

After disabling a user, changing direct access, or resetting a local password,
verify that a new Keycloak login reflects the change. Keycloak logout ends the
server-side session, but an already issued JWT may remain valid at Envoy until
its expiry. The user-administration API itself performs a live actor check and
therefore immediately denies a disabled or demoted administrator. Never
troubleshoot by printing or decoding the client Secret. If a deployment uses
the direct external-provider escape-hatch overlay instead of local Keycloak,
identity management is unavailable and the **System → Users** tab stays hidden.

## Federated SSO checks

The **System → Settings → Federated SSO** tab requires a live `magicstick-admin`, local Keycloak and
a valid `federated-sso` entitlement for validation or save. Keep a tested local
recovery administrator signed in while introducing a provider. Configure the
displayed provider-specific callback at the upstream IdP, validate metadata,
start with a `user` or `viewer` mapping, and verify a fresh private-browser login
before adding an administrator mapping.

Inspect components without decoding either generated client Secret:

```bash
kubectl -n identity-system get deploy keycloak ai-appliance-dashboard-api
kubectl -n identity-system get secret magicstick-federation-admin-client
kubectl -n identity-system get role,rolebinding ai-appliance-dashboard-federation-admin-client
kubectl -n identity-system logs deploy/keycloak --tail=200
kubectl -n identity-system logs deploy/ai-appliance-dashboard-api -c api --tail=200
```

The Keycloak service account must have only `manage-identity-providers`,
`view-identity-providers` and `view-realm`. Its Kubernetes Role must grant only
`get` on `magicstick-federation-admin-client`. The browser and API responses must
never contain its Secret or an upstream OIDC client secret. Structured
`magicstick.federated-sso` audit lines intentionally contain no request body.

Saving stages a provider disabled and enables it only after all generated role
mappers exist. A failed update leaves an existing provider disabled; correct the
configuration and save again. Missing, expired, invalid or currently
unverifiable entitlement causes the
API's periodic enforcement to disable dashboard-managed providers within its
next check interval, without deleting configuration or local users. Deletion is
still available to a live administrator for recovery. Providers created outside
the dashboard are neither listed nor changed.

## API Access Checks

The dashboard **API Access** tab is available only to `magicstick-admin`. It
uses LiteLLM's virtual-key API and the existing generated master key to create
multiple named client keys. The raw client key is shown once after creation;
only its name and hashed identifier remain visible later.

Check the participating services without decoding either the master key or any
client key:

```bash
kubectl -n identity-system get deploy,service ai-appliance-dashboard-api
kubectl -n ai get deploy,service litellm
kubectl -n ai get pods -l app=litellm
kubectl -n ai get secret litellm-masterkey-secret
kubectl -n identity-system logs deploy/ai-appliance-dashboard-api -c api --tail=200
kubectl -n ai logs deploy/litellm --tail=200
```

The dashboard list contains only keys marked as created by the Magic Stick
dashboard. Keys provisioned directly through LiteLLM or another automation are
intentionally neither listed nor revocable there. If a raw key was not saved,
create a replacement and revoke the old named access; do not attempt to recover
it from Kubernetes or logs. A `403` means the actor is not an administrator or
the same-origin mutation check failed. A `503` means the LiteLLM service,
master-key configuration, or PostgreSQL-backed key management is unavailable.

## Kubernetes SSO Access Checks

The dashboard **Kubernetes Access** tab is available only to a live
`magicstick-admin` session while local Keycloak identity management is enabled.
User assignment may be prepared before host OIDC is ready, but kubeconfig
download and clipboard copy stay disabled until the cluster publishes its
verified configuration.

Check the non-secret contract without decoding any client Secret:

```bash
kubectl -n identity-system get configmap magicstick-kubernetes-access-info -o yaml
kubectl -n identity-system get certificate identity-pilot-ca identity-pilot
kubectl get clusterrolebinding \
  magicstick-kubernetes-viewer \
  magicstick-kubernetes-operator-view \
  magicstick-kubernetes-admin
kubectl -n ai-system get rolebinding magicstick-kubernetes-operator-runtime
kubectl -n ai-system get role magicstick-kubernetes-operator -o yaml
kubectl -n identity-system logs deploy/ai-appliance-dashboard-api -c api --tail=200
```

On an appliance-owned K3s host, confirm the arguments without printing any
credentials:

```bash
sudo grep '^  - "oidc-' /etc/rancher/k3s/config.yaml
sudo test -r /etc/rancher/k3s/magicstick-oidc-ca.crt
sudo k3s kubectl get --raw=/readyz
```

On the administrator workstation, install
[`kubelogin`](https://github.com/int128/kubelogin). Download the kubeconfig or
copy it from the dashboard into a protected local file, then test it:

```bash
chmod 0600 ./magicstick-USER.kubeconfig
KUBECONFIG=./magicstick-USER.kubeconfig kubectl auth whoami
KUBECONFIG=./magicstick-USER.kubeconfig kubectl auth can-i list pods --all-namespaces
KUBECONFIG=./magicstick-USER.kubeconfig kubectl auth can-i get secrets --all-namespaces
```

The last command must return `no` for Viewer and Operator. Operator may mutate
only the three Magic Stick runtime CR kinds in `ai-system`. Every assignment and
kubeconfig retrieval, whether downloaded or copied, emits a
`magicstick.kubernetes-access` audit event without a token, password, kubeconfig
body, or client secret.
