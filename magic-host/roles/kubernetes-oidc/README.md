# kubernetes-oidc

This role enables Keycloak OIDC authentication on the appliance-owned K3s API
server after Flux has installed the identity stack. It installs only the public
identity CA on the host, re-renders K3s, waits for the restarted API server and
publishes non-secret discovery data for the dashboard.

The published Kubernetes API endpoint uses the host's current default private
IPv4 address instead of the appliance `.local` name. This keeps downloaded
kubeconfigs usable in OpenLens and other clients whose internal proxy bypasses
the operating system's mDNS resolver. The OIDC issuer remains
`https://id.<mdns-domain>/realms/magicstick` because it is the stable identity
of the Keycloak realm.

Fresh installations allow the dependency graph and identity stack up to
fifteen minutes to become ready. The retry ends immediately once the CA,
Keycloak discovery endpoint, and restarted Kubernetes API server are available.

No user password, bearer token, client secret or private certificate key is
written by this role. Existing or managed Kubernetes clusters must configure
equivalent API-server OIDC flags outside this role and publish the documented
`identity-system/magicstick-kubernetes-access-info` ConfigMap themselves.
