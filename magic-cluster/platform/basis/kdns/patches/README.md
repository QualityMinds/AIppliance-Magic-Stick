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
- takes IP addresses from `Gateway.status.addresses` by default;
- for a current, programmed Gateway with `magicstick.dev/mdns-address-mode:
  host-link-ipv4`, advertises only IPv4 addresses on the physical link carrying
  each query; explicit route address overrides keep their existing behavior;
- derives the service type and port from the selected Gateway listener;
- passes hostnames to the DNS-SD library relative to the configured domain, so
  `magicstick.local` is published exactly once instead of as
  `magicstick.local.local`;
- removes records when the route is removed or no longer accepted; and
- keeps the existing Ingress and LoadBalancer Service support.

The pinned `dnssd` dependency (`v1.2.14`) is patched in a disposable vendor
tree. This keeps its multicast socket memberships current as links or DHCP
addresses change and permits link-local address selection without re-registering
every route. Virtual, inactive, and IPv6-only links are not candidates for the
managed IPv4 Gateway. The managed single-node host role must provide a stable
internal ServiceLB and API address before enabling this mode; discovery alone
cannot keep HTTPS working when an old node IP disappears.

Apply and test the patches against a clean upstream checkout:

```bash
git clone https://github.com/lab42/kdns.git /tmp/kdns
git -C /tmp/kdns checkout f956ab5d35564ee84e58ba155e78a17423cc835b
bash magic-cluster/platform/basis/kdns/patches/prepare-source.sh /tmp/kdns
bash magic-cluster/platform/basis/kdns/patches/test-source.sh /tmp/kdns
```

CI also runs the packet acceptance with `MAGICSTICK_TEST_LINUX_PACKETS=1`
inside an empty Linux network namespace with synthetic peers. It checks
membership after DHCP and hotplug, the exact A record on each link, and renewal
after renumbering. It never disconnects an existing host interface.

Pull-request checks also build both target images without publishing them.
The Dockerfile-specific ignore file retains the prepared `vendor/` tree that
upstream's default context would exclude, so these checks exercise the same
patched dependencies, packaging and license evidence as the publisher.

The cluster manifests already grant the required read-only Gateway API RBAC
and opt the local Keycloak, SSO pilot, dashboard, and generated AppInstance
routes into discovery. `.github/workflows/build-kdns-image.yml` checks out this
exact upstream commit, applies the patch, runs the Go tests and vet, and builds
an amd64/arm64 image as `ghcr.io/qualityminds/magicstick-kdns`. Publisher runs
publish an immutable `sha-<commit>` tag; `main` additionally publishes
`v0.2.22-gateway-api.2`. Deployments pin the resulting multi-architecture
manifest digest rather than either tag.

The opt-in GitOps promotion also adds `link-independent-network.json` beside
the HelmRelease. Its `version: 1`, `kdns`, and `dashboardApi` fields bind the
capability to the exact promoted image references in both manifests. Publish
and qualify those images before adding that declaration. Source without it
retains the legacy address selection and never implicitly migrates a node.

The image retains the source README, any supplied `LICENSE`, the patched
dependency's MIT license, and the upstream
revision under `/usr/share/licenses/kdns/`. The pinned README explicitly
declares MIT, so its currently empty `LICENSE` is a warning, not a build veto.
That warning is also retained as `MAGICSTICK-NOTICE.txt`; obtaining the complete
upstream copyright/license notice remains an open follow-up. The build never
invents attribution and fails if both a nonempty license file and the verified
README declaration are absent. Run the recipe's evidence-handling tests with
`python -m unittest tests/test_license_kdns.py` from the repository root.
See the [license audit](../../../../../docs/license-audit.md#kdns-evidence-checked-2026-09-23).

The currently deployed build is:

```text
ghcr.io/qualityminds/magicstick-kdns@sha256:6b8ed100b7b9da6b54b536895c99d3d7334ed0bb0f90d091168ca40f95c1461b
```

Package visibility is managed once in the GitHub package settings. The
workflow token intentionally only builds and publishes immutable images.

Rancher Desktop runs Kubernetes in a Linux VM and does not reliably forward
multicast DNS packets to macOS. For that development environment, run the
host-side bridge in a separate terminal:

```bash
magic-cluster/platform/basis/kdns/publish-rancher-desktop-mdns.sh
```

The bridge reads the same accepted and annotated `HTTPRoute` resources and
publishes them through the native macOS mDNS responder. It is not required on a
normal host-local K3s appliance.
