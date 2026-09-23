# License API

## Signed document contract

The existing Ed25519 JWS envelope is used:

```json
{"format":"magicstick-license/v1","token":"<Ed25519 compact JWS>"}
```

The header contains only `alg: EdDSA`, `typ: magicstick-license+jwt` and a
trusted `kid`. Keys embedded or linked in uploads are never trusted.

| Signed field | Contract |
|---|---|
| `version` | Integer 1 |
| `product`, `issuer` | Both `magicstick` |
| `edition` | `free-registered` or `commercial` |
| `licenseId` | Unique bounded identifier |
| `customer` | Nonempty customer/organization reference, at most 160 characters |
| `issuedAt`, `notBefore`, `expiresAt` | Integer Unix seconds; issuedAt <= notBefore < expiresAt |
| `features` | Unique entitlement ID list matching the edition above |
| `installationId` | Optional canonical UUID binding |

The wire field `features` represents entitlements; no separate boolean map is
needed. Unknown/duplicate fields and entitlement IDs fail closed. Future
entitlements are added centrally to the verifier, contracts and edition policy
with tests, not implicitly trusted from unknown signed claims. For example:

```json
{
  "version": 1,
  "product": "magicstick",
  "issuer": "magicstick",
  "edition": "free-registered",
  "licenseId": "example-registration",
  "customer": "Example organization",
  "issuedAt": 1798761600,
  "notBefore": 1798761600,
  "expiresAt": 1830297600,
  "features": ["federated-sso"]
}
```

Commercial claims use `edition: commercial` and both entitlement IDs. The issuer
can omit installationId for an unbound file. The browser request includes it.
Files are limited to 64 KiB. Invalid, expired, future-dated or incorrectly bound
uploads cannot replace the current license. Activation uses Kubernetes
resourceVersion for optimistic concurrency; there is one active file, no
scheduled replacement, billing system, online activation or grace period.

## Persistence, API and security

The runtime Secret `identity-system/magicstick-license` contains a random
`installationId` and, after activation, `license.json`. It is not Git-owned.
Back up the Secret through secured cluster backup; exporting only the document
does not preserve the binding identity. Secret data is base64, not encryption;
cluster encryption at rest is an installation responsibility.

| API | Purpose |
|---|---|
| GET /api/license | Sanitized status, edition, validity, installation ID, revision, capabilities |
| POST /api/license/request | Customer, edition, features, ttlSeconds → unsigned private request |
| POST /api/license/validate | Preview signed document against current installation |
| PUT /api/license | Activate document using expectedRevision |
| GET /api/license/export | Export exact stored document |

All routes require administrator authorization; mutations also require the
dashboard CSRF boundary. License payloads and secrets must not appear in audit
logs. CLI: `magicstick license status`, `validate FILE`, `import FILE --yes`,
`export FILE`; the TUI provides preview and explicit activation.

`LicenseService.require_capability` combines live caller authorization,
cryptographic entitlement and installed implementation. Federated SSO uses this
gate. Resource Sharing instead checks live local users, groups, roles and ACLs;
Mesh checks tokens, membership, signed rosters, invitations and role isolation.
A license never replaces these security checks.

Invalid or expired licenses grant neither entitlement. Core workloads, ACLs and
mesh policies remain intact. A local root/cluster administrator can alter code,
clock or trust stores; offline signature verification is not tamper-proof DRM.

## License Administration

The dashboard **System → License** tab and the CLI/TUI **License** area
use five admin-only routes: `GET /api/license`, `POST /api/license/request`,
`POST /api/license/validate`, `PUT /api/license`, and `GET /api/license/export`.
Mutations require the existing
CSRF/same-origin checks. Preview does not replace the license; activation
revalidates the signed file and the preview's expected Kubernetes revision.
Invalid files cannot overwrite a valid license. A valid entitlement does not
make an unimplemented feature available.

The **Request license** panel selects Free Registered or Commercial, a customer
reference and positive whole TTL in hours or days (initial draft: 30 days).
It downloads unsigned claims for the offline issuer, including the edition,
edition-specific entitlements and installation binding. Download never activates
a license. The entitlements are `federated-sso` and `commercial-production`.

**Software licenses** remains visible when the API is unavailable and embeds
`LICENSE`, `LICENSING.md`, `licenses/MIT-CHANGE.txt` and
`THIRD_PARTY_NOTICES.md` for offline inspection/download. A signed license is
technical activation, not a substitute for a commercial agreement.
See [the licensing overview](../../LICENSING.md).

The API image adds pinned verification libraries and combines the release-owned
`magicstick-license-official-trust` with the optional local
`magicstick-license-trust` ConfigMap. Both are read-only mounts; official keys
arrive with installation/updates, including when the preserved local store is
empty. Customers upload only their signed license file. Conflicting key IDs
fail closed, and retired official IDs cannot be restored by a local copy.
Its separate Role grants `get/update` on the named
`identity-system/magicstick-license` Secret plus namespace-scoped
Secret creation (Kubernetes cannot restrict create by name). It cannot list or
delete identity Secrets, edit trust keys or install workloads. The runtime
license Secret is not Git-owned and survives API Pod replacement.

See [licensing.md](../administration/licenses.md) for the complete contract, issuer commands,
key rotation, backup, expiry, tamper-resistance limits and local Rancher tests.
All core functions except Federated SSO remain usable without a license file.
