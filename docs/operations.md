# Operations

This page collects common day-2 checks for a running appliance.

## Host Checks

On the appliance host:

```bash
sudo systemctl status k3s
sudo journalctl -u k3s -n 200 --no-pager
sudo /usr/local/sbin/ai-appliance-converge
```

Check the host metadata that drives the converge runner:

```bash
sudo sed -n '1,160p' /etc/default/ai-appliance-repo
```

Do not paste secret values from that file into issues or public logs.

## Kubernetes Checks

With host-local K3s:

```bash
sudo k3s kubectl get nodes -o wide
sudo k3s kubectl get namespaces
sudo k3s kubectl -A get pods
```

With any configured kubeconfig:

```bash
kubectl get nodes -o wide
kubectl -A get pods
```

## Flux Checks

```bash
kubectl -n flux-system get gitrepositories
kubectl -n flux-system get kustomizations
kubectl -n flux-system get helmreleases
```

Inspect a failing reconciliation:

```bash
kubectl -n flux-system describe kustomization flux-system
kubectl -n flux-system describe kustomization magicstick-operator
kubectl -n ai-system get moduleactivations,appinstances
```

Trigger reconciliation after pushing a fix:

```bash
flux -n flux-system reconcile source git flux-system
flux -n flux-system reconcile kustomization flux-system --with-source
flux -n flux-system reconcile kustomization magicstick-operator --with-source
```

If the Flux CLI is not available locally, annotate the resource:

```bash
kubectl -n flux-system annotate gitrepository flux-system \
  reconcile.fluxcd.io/requestedAt="$(date +%s)" --overwrite
kubectl -n flux-system annotate kustomization magicstick-operator \
  reconcile.fluxcd.io/requestedAt="$(date +%s)" --overwrite
```

## App Checks

```bash
kubectl -n ai get pods
kubectl -n ai get svc,ingress
kubectl -n dashboard get pods,service,referencegrant
kubectl -n identity-system get httproute,securitypolicy
kubectl -n observability get pods
kubectl -n identity-system get httproutes,securitypolicies
```

## Identity Pilot Checks

```bash
kubectl -n flux-system get kustomizations envoy-gateway identity-pilot
kubectl -n envoy-gateway-system get helmrelease,pods
kubectl -n identity-system get pods,pvc,gateway,httproute,securitypolicy
kubectl -n identity-system logs deploy/keycloak
```

Envoy Gateway is the installed application gateway and exposes the HTTPS
listener through a `LoadBalancer` service. Follow
[authentication.md](authentication.md) for local name resolution, login
validation, and generated credential handling.

Common public hostnames use `AI_APPLIANCE_DOMAIN`:

| Service | Default public host pattern |
|---|---|
| Dashboard | `magicstick.example.com` |
| AnythingLLM | `anythingllm.magicstick.example.com` |
| LiteLLM | `litellm.magicstick.example.com` |
| Grafana | `grafana.magicstick.example.com` |
| Prometheus | `prometheus.magicstick.example.com` |
| Alertmanager | `alertmanager.magicstick.example.com` |

AppInstance hostnames include the instance name:

| Instance type | Example public host | Example local host |
|---|---|---|
| OpenClaw | `default.openclaw.magicstick.example.com` | `default.openclaw.magicstick.local` |
| Hermes | `default.hermes.magicstick.example.com` | `default.hermes.magicstick.local` |
| Odysseus | `default.odysseus.magicstick.example.com` | `default.odysseus.magicstick.local` |
| Paperclip | `default.paperclip.magicstick.example.com` | `default.paperclip.magicstick.local` |
| KubeOpenCode | `default.kubeopencode.magicstick.example.com` | `default.kubeopencode.magicstick.local` |

Local mDNS hostnames use `AI_APPLIANCE_MDNS_DOMAIN`, for example
`magicstick.local` for the dashboard and `anythingllm.magicstick.local` for
AnythingLLM. Instance-local hostnames use the same instance-name pattern with
the mDNS domain.

Gateway-backed names are published only when their `HTTPRoute` has
`lab42.io/mdns.enabled: "true"`, the selected parent reports `Accepted=True`,
and the referenced `Gateway` has an IP address. Check discovery with:

```bash
kubectl get gateway,httproute -A
kubectl -n kdns logs deploy/kdns-kdns
```

LiteLLM, AnythingLLM, Grafana, Prometheus, and Alertmanager use static routes in
`identity-system` and narrowly scoped backend grants in their service
namespaces. Inspect the complete contract with:

```bash
kubectl -n identity-system get httproutes,securitypolicies \
  -o custom-columns=KIND:.kind,NAME:.metadata.name
kubectl -n ai get referencegrants
kubectl -n observability get referencegrants
```

LiteLLM and AnythingLLM require `magicstick-user` or a higher role. Grafana,
Prometheus, and Alertmanager require `magicstick-viewer`, `magicstick-operator`,
or `magicstick-admin`. Every static policy uses an exact callback path on the
shared dashboard host, so it remains inside the redirect URI patterns of the
single human gateway client.

Envoy forwards the Keycloak access token to Grafana. Grafana validates the JWT
against Keycloak and maps `magicstick-viewer` to Viewer,
`magicstick-operator` to Editor, and `magicstick-admin` to GrafanaAdmin. Its
basic login form is disabled, so the gateway login is the only browser login.

Rancher Desktop isolates Kubernetes multicast traffic inside its Linux VM. On
macOS, keep the host bridge running in a separate terminal while testing:

```bash
magic-cluster/platform/basis/kdns/publish-rancher-desktop-mdns.sh
```

Host-local K3s appliances do not need this development bridge.

## AppInstance Gateway Access

The operator publishes enabled instances through Envoy Gateway and removes the
routes again when an instance is suspended or deleted. Inspect the generated
contract with:

```bash
kubectl -n ai-system get appinstances
kubectl -n identity-system get httproutes,securitypolicies \
  -l appliance.magicstick.dev/appinstance
kubectl -n ai get referencegrants
```

An SSO route must report `Accepted=True`, its SecurityPolicy must be accepted,
and its backend ReferenceGrant must name the application Service. `403` after a
successful login means the account does not have the minimum role selected in
`spec.access.role`. Each protected application route has a companion callback
route with an exact `/oauth2/callback/<route-name>` match on the shared local or
public dashboard host; both routes must be accepted by the same SecurityPolicy.

## Model Catalog

```bash
kubectl -n ai get configmap ai-model-catalog \
  -o jsonpath='{.data.AI_APPLIANCE_MODEL_CATALOG_READY}{"\n"}{.data.AI_APPLIANCE_MODEL_CATALOG_HASH}{"\n"}'

kubectl -n ai logs deploy/ai-model-catalog-controller
```

For schema details and model troubleshooting, see
[model-catalog.md](model-catalog.md).

## GPU And KubeAI

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}'
kubectl -n gpu-operator get pods
kubectl -n ai get models.kubeai.org
kubectl -n ai get pods -l app.kubernetes.io/name=kubeai
```

If model pods fail to start, check:

- NVIDIA GPU Operator pods
- node GPU allocatable resources
- KubeAI `Model` status
- vLLM model pod logs
- model cache space under the host cache path

## Storage

```bash
kubectl get pvc -A
kubectl -n observability get pvc
kubectl -n ai get pvc
```

Storage sizes in the public template default to small values. Private
deployments should patch or substitute production sizes before relying on the
appliance for persistent data.

## Logs

```bash
kubectl -n ai logs deploy/litellm
kubectl -n ai logs deploy/anything-llm
kubectl -n ai logs deploy/ai-model-catalog-controller
kubectl -n ai logs statefulset/paperclip
kubectl -n observability logs deploy/loki
```

For operator-backed apps, also check the operator namespace:

```bash
kubectl -n hermes-operator-system logs deploy/hermes-operator-controller-manager
kubectl -n openclaw-operator-system logs deploy/openclaw-operator-controller-manager
kubectl -n paperclip-operator-system logs deploy/paperclip-operator-controller-manager
```

Deployment names can vary by chart version. Use `kubectl -n <namespace> get
deploy,pods` if a command does not match the running resource name.

## Common Failures

| Symptom | First checks |
|---|---|
| Flux Kustomization is `False` | `kubectl -n flux-system describe kustomization <name>` and render the same path locally with `kubectl kustomize`. |
| HelmRelease is not ready | `kubectl -n flux-system describe helmrelease <name>` and inspect chart values. |
| Custom legacy Ingress has no endpoint | The nginx controller is intentionally not installed. Bundled surfaces already use Envoy; migrate custom applications to an authenticated `HTTPRoute`. |
| App waits for model catalog | Check `ai-model-catalog-controller` logs and `AI_APPLIANCE_MODEL_CATALOG_READY`. |
| LiteLLM Prisma reports `P1000` authentication failed | The PostgreSQL PVC may be older than `litellm-postgresql-secret`. Keep generated DB credentials prune-disabled and rotate the DB user password to match the current Secret. |
| Paperclip login origin fails | Confirm `BETTER_AUTH_TRUSTED_ORIGINS` on the Paperclip `Instance` and restart the app pod after changes. |
| Paperclip task creates no Sandbox | Check `sandboxes.agents.x-k8s.io`, the Agent Sandbox controller, `spec.adapters.execution.kubernetes.backend`, and the selected adapter runtime image. |
| Paperclip sandbox cannot call a model | Check `opencode-providers.json`, `litellm-masterkey-secret`, LiteLLM on port 4000, and NetworkPolicies in the Paperclip tenant namespace. |
| Generated Secret missing | Check the secret generator HelmRelease and Secret annotations. |
| OIDC route does not redirect | Check the `SecurityPolicy` and `HTTPRoute` status, Keycloak readiness, the Envoy data-plane logs, and whether the identity and requested application hostnames resolve to the Envoy LoadBalancer address. |
| AppInstance route returns `403` after SSO | Compare `spec.access.role` with the user's `magicstick-user`, `magicstick-viewer`, `magicstick-operator`, or `magicstick-admin` realm roles. |
| Static AI or observability route returns `403` after SSO | AI routes require at least `magicstick-user`; observability routes require at least `magicstick-viewer`. Check the user's realm roles and the corresponding static `SecurityPolicy`. |
| Dashboard returns `403` after login | Confirm the user has `magicstick-viewer`, `magicstick-operator`, or `magicstick-admin`; configuration changes need operator or admin as documented in `authentication.md`. |
| GPU model never starts | Check GPU Operator, allocatable GPU resources, KubeAI model status, and vLLM logs. |
