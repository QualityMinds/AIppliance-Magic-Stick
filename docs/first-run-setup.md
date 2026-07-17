# First-Run Setup

A newly installed appliance does not contain a human default password. It
starts in `ApplianceSetup/local` phase `Pending` and exposes a temporary setup
service only on the local network. Existing installations are initialized as
`CompletedLegacy`; a missing setup resource never enables setup access.

## Open the Setup Screen

The physical text console shows the local addresses, certificate fingerprint,
and one-time claim code. Open either:

- `https://magicstick.local` when mDNS is available
- `https://<private-node-ip>:9443/setup` when mDNS is unavailable

The second address is the required fallback and does not depend on DNS. The
temporary certificate is self-signed and includes the current private node IP
addresses. Compare its SHA-256 fingerprint with the fingerprint printed on the
physical console before accepting the browser warning.

The setup gateway accepts only private, unique-local, and link-local source
addresses. No setup route is created for the public dashboard hostname.

## Complete the Wizard

The wizard asks for appliance name, `.local` name, timezone, language, optional
public domain, and the first administrator. Passwords are sent directly to
Keycloak and are neither stored in Kubernetes nor written to logs.

On completion, save the one-time recovery username and code. Both the primary
and recovery users receive `magicstick-user` and `magicstick-admin`. The setup
claim, session, temporary certificate, gateway, and routes are then removed;
the local address returns to the normal OIDC-protected dashboard.

## Console Recovery Before Completion

Run these commands as root on the appliance:

```bash
magicstick setup show
magicstick setup reissue
```

`show` redraws the URLs, claim code, and certificate fingerprint.
`reissue` invalidates the previous claim and browser session. It is available
only before setup completes. A completed appliance cannot be reopened with
these commands; factory reset is intentionally a separate future workflow.

The plaintext claim exists only in `/var/lib/magicstick/setup/claim`, owned by
root with mode `0600`. Kubernetes stores its SHA-256 hash. A host timer removes
the file after completion.

## State and Troubleshooting

```bash
sudo magicstick setup show
sudo k3s kubectl -n identity-system get appliancesetup local
sudo k3s kubectl -n identity-system get gateway,httproute,securitypolicy
```

Phases are `Pending`, `Claimed`, `Applying`, `Completed`, `Failed`, and
`CompletedLegacy`. A restart during `Applying` is safe: submitting the same
form again updates the same Keycloak users rather than creating duplicates.
Use `magicstick setup reissue` after an abandoned claim or failed browser
session.
