# kdns Gateway API patch

Magic Stick uses Envoy Gateway and Gateway API instead of an ingress
controller. Upstream `lab42/kdns` currently discovers only `Ingress` and
`LoadBalancer` `Service` resources. The patch in this directory adds opt-in
discovery for `gateway.networking.k8s.io/v1` `Gateway` and `HTTPRoute`
resources.

The patch is based on upstream commit
`f956ab5d35564ee84e58ba155e78a17423cc835b` (`v0.2.22`). It:

- lists `Gateway` and `HTTPRoute` resources every 15 seconds;
- publishes only routes annotated with `lab42.io/mdns.enabled: "true"`;
- requires the referenced route parent to report `Accepted=True`;
- takes IP addresses from `Gateway.status.addresses`;
- derives the service type and port from the selected Gateway listener;
- removes records when the route is removed or no longer accepted; and
- keeps the existing Ingress and LoadBalancer Service support.

Apply and test the patch against a clean upstream checkout:

```bash
git clone https://github.com/lab42/kdns.git /tmp/kdns
git -C /tmp/kdns checkout f956ab5d35564ee84e58ba155e78a17423cc835b
git -C /tmp/kdns apply \
  "$PWD/magic-cluster/platform/basis/kdns/patches/gateway-api.patch"
docker run --rm -v "$(cd /tmp/kdns && pwd -P):/src" -w /src golang:1.26 \
  sh -ec 'gofmt -w handler/gateway_api_handler.go handler/gateway_api_handler_test.go watcher/watcher.go cmd/root.go && go test ./... && go vet ./...'
```

The cluster manifests already grant the required read-only Gateway API RBAC
and opt the local Keycloak, SSO pilot, and dashboard routes into discovery.
The patched image must be released and pinned before replacing the upstream
image in the HelmRelease.

Rancher Desktop runs Kubernetes in a Linux VM and does not reliably forward
multicast DNS packets to macOS. For that development environment, run the
host-side bridge in a separate terminal:

```bash
magic-cluster/platform/basis/kdns/publish-rancher-desktop-mdns.sh
```

The bridge reads the same accepted and annotated `HTTPRoute` resources and
publishes them through the native macOS mDNS responder. It is not required on a
normal host-local K3s appliance.
