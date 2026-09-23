# Identity validation

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

Resolve the configured identity, pilot and dashboard names to the reported
LoadBalancer address with local DNS or temporary hosts-file entries. Replace
`<GATEWAY_IP>` and the example names below with your test environment's values:

```text
<GATEWAY_IP> id.example.local auth-pilot.example.local example.local
```

For a new installation, complete the physical-console claim flow described in
[first-run-setup.md](../installation/first-run-setup.md). There is no Kubernetes Secret that
contains the first administrator's password.

Open the configured auth-pilot URL. Verify the expected certificate/CA through an
independent trusted channel and install its public trust material in the isolated
test client. Do not use bypassed certificate validation as a passing trust test.
The request must redirect to Keycloak and return to the protected success page
after login. See [certificate handling](../administration/certificates.md).

Open the configured dashboard URL to validate the real dashboard route. After
login, the administrator created during first-run setup can use all dashboard
operations. `/logout` clears the Envoy browser session.

On a host-local K3s appliance, Gateway-aware kdns publishes the annotated local
routes automatically. Rancher Desktop keeps multicast inside its Linux VM; use
`magic-cluster/platform/basis/kdns/publish-rancher-desktop-mdns.sh` on macOS
while testing so the same accepted routes are published through the host mDNS
responder.
