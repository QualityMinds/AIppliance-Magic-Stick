# Certificates and identity trust

## Local and public trust

The appliance already provisions a local identity CA and certificates for its
managed local names. Initial setup uses a temporary certificate whose fingerprint
must be compared with the console before entering the claim. After setup, distribute
only the public CA to trusted clients; never distribute the CA private key.

Public DNS names need certificates appropriate for those names and the chosen
deployment. A local `.local` certificate is not automatically a publicly trusted
certificate. Follow the deployment's certificate issuer configuration and verify
the hostname and trust chain from the actual client network.

When changing a domain or trust configuration, keep independent console access
and a local recovery account. Verify dashboard login, Keycloak callbacks,
application routes and Kubernetes SSO after the change. Do not disable certificate
verification to make a broken trust chain appear healthy.

<a id="production-migration"></a>

Federated SSO is a separate optional configuration under
[System → Settings → Federated SSO](federated-sso.md). The local certificate
and recovery model does not depend on an external identity provider.

All bundled browser surfaces are represented by Envoy `HTTPRoute` resources.
An additional Envoy API gateway is not needed for the authentication layer.

## Secret and Recovery Rules

- Secrets are generated at runtime and never committed.
- Identity database storage must be backed up before production use.
- Realm configuration changes after the first import must be managed through a
  reviewed realm export or an administration workflow; restarting Keycloak does
  not overwrite an existing realm. The scoped startup reconciliation is the
  reviewed exception for the human gateway callback patterns and web origins.
- Save and test the one-time recovery administrator created by first-run setup.
- A cloud identity provider outage must not prevent local break-glass login.
- Never grant the human dashboard client or user-administration client
  `realm-admin`, `manage-clients`, `manage-realm`, `impersonation`, or
  identity-provider administration. Only the dedicated federation service
  account receives the two identity-provider roles described above.
