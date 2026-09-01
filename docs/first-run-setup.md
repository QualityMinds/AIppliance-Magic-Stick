# First-Run Setup

A newly installed appliance does not contain a human default password. It
starts in `ApplianceSetup/local` phase `Pending` and exposes a temporary setup
service only on the local network. Existing installations are initialized as
`CompletedLegacy`; a missing setup resource never enables setup access.

Flux reconciles the `identity-system` namespace and `ApplianceSetup` CRD in an
early bootstrap stage that does not depend on Envoy Gateway readiness. The
temporary setup application and routes remain part of the later identity
stage.

## Open the Setup Screen

The appliance waits until cloud-init has finished and then switches the
physical display from the boot-log console to a dedicated first-run virtual
console. Installation logs remain on virtual console 1 and are therefore never
mixed with the setup details on virtual console 9. The page is refreshed
periodically so that a delayed certificate, a changed LAN address, or the
completed setup state replaces the previous display.

The dedicated page uses the Magic Stick color scheme and a centered appliance
panel. Local access, the eight-character claim, the compact SHA-256
fingerprint, and the three setup steps are visually separated so that the
security-relevant values remain readable from the physical display.

The console deliberately shows only the configured mDNS name and one primary
private LAN address. Loopback, CNI, Flannel, container bridge, and virtual
Ethernet addresses are hidden. Open either:

- `https://magicstick.local` when mDNS is available
- `https://<private-node-ip>:9443/setup` when mDNS is unavailable

The second address is the required fallback and does not depend on DNS. If no
usable private address has been assigned yet, the console says so and adds it
on a later refresh. The temporary certificate is self-signed and includes the
current private node IP addresses. Compare its SHA-256 fingerprint with the
fingerprint printed on the physical console before accepting the browser
warning.

The setup gateway accepts only private, unique-local, and link-local source
addresses. No setup route is created for the public dashboard hostname.

## Complete the Wizard

The wizard asks for appliance name, `.local` name, timezone, language, optional
public domain, and the first administrator. Passwords are sent directly to
Keycloak and are neither stored in Kubernetes nor written to logs.

On completion, save the one-time recovery username and code. Both the primary
and recovery users receive `magicstick-user` and `magicstick-admin`. The setup
claim, session, temporary certificate, gateway, and routes are then removed;
the local address returns to the normal OIDC-protected dashboard. The physical
console is cleared again and no longer displays the claim code.

The recovery user is marked as a protected local recovery account. The normal
dashboard user administration cannot edit, disable, demote, reset, or delete
it. Keep its one-time credentials offline and use the primary administrator for
daily administration. After signing in as that primary administrator, the
dashboard **Users** tab can create additional local users and assign their
MagicStick access level without storing human passwords in Kubernetes.

Continue with the user guide
[After installation: configure Magic Stick in the dashboard](installation/after-installation-dashboard.md)
to select domains, modules, models, and application instances.

## Console Recovery Before Completion

Run these commands as root on the appliance:

```bash
magicstick setup show
magicstick setup reissue
```

`show` prints the same concise status, URLs, claim code, and certificate
fingerprint in the current shell without clearing it. `reissue` invalidates the
previous claim and browser session and refreshes the physical console. It is
available only before setup completes. A completed appliance cannot be
reopened with these commands; factory reset is intentionally a separate future
workflow.

Use SSH when a shell is needed. On a directly attached keyboard,
`Ctrl`+`Alt`+`F1` returns to the boot/login console and `Ctrl`+`Alt`+`F9`
returns to the first-run page.

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
