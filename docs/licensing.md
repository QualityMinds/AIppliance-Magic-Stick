# Offline license management

The first AIMS-005 increment adds **MIT-licensed infrastructure**, not Enterprise
business features. The React dashboard, CLI and TUI use the same admin-only API
and persistent Kubernetes state. No existing Community operation requires a
license. The React frontend is the standard browser dashboard.

## Current scope

`License & Enterprise` in the dashboard provides status, file selection, validation,
an explicit replacement preview, activation and export. The maximum file size
is 64 KiB. Uploads never supply trusted keys. A license is rechecked on activation
and every status/capability read; there is no process-local entitlement cache.

The seven stable entitlement IDs are:

| ID | Planned business capability |
|---|---|
| `resource-sharing` | Targeted user/group resource access |
| `team-administration` | Delegated team administration |
| `resource-budgets` | Team/project resource budgets |
| `fleet-management` | Central operation of independent Magic Sticks |
| `federated-sso` | Dashboard-managed federation |
| `multi-gpu` | Additional Multi-GPU management workflows |
| `k3s-multi-node` | Additional k3s multi-node management workflows |

All seven currently report `implemented: false` and `available: false`, even
with a valid entitlement. These names do not put existing GPU, k3s or SSO
capabilities behind a paywall. Multi-GPU and multi-node support boundaries still
need their own review. Future business code belongs behind the separately
documented [Enterprise boundary](../enterprise/README.md).

## Customer workflow

Official installations receive the manufacturer's public verification keys with
Magic Stick. Customers do not generate keys or configure a trust store: they
open **License & Enterprise**, select their signed JSON, validate it, and
explicitly activate it. The issuer's private key is never part of the appliance.

The release prerequisite below must be completed before shipping a license-ready
build. CI rejects an official bundle with no active public keys; temporary test
keys are not a substitute for the approved manufacturer key.

The bundled manufacturer key is `issuer-2026`, an Ed25519 public key. Its SHA-256
fingerprint (DER SubjectPublicKeyInfo) is
`93f4bd3b664fea576fdd0b32ad9be44525b5a98207885b6cc251919ee1878182`.
It is public release material, not a secret. Customers need neither this file
nor access to the manufacturer's signing workstation to activate a license.

## 1. Prepare the issuer outside the appliance (manufacturer, once)

Use Python 3.9+ with a virtual environment on a controlled signing workstation.
The example variables must point **outside the checkout**. Do not put private
keys, customer claims or issued licenses into Git, containers or chat messages.

```bash
python3 -m venv /path/to/private/issuer-venv
/path/to/private/issuer-venv/bin/pip install -r dashboard/apps/api/requirements.txt

/path/to/private/issuer-venv/bin/python dashboard/apps/api/license_issuer.py keygen \
  --directory /path/to/private/issuer-key-2026 \
  --kid issuer-2026 \
  --password-file /path/to/private/key-password
```

Supply a nonempty password file using your protected credential workflow; the
password itself is never a command argument. The new directory is mode `0700`;
the private PKCS8 Ed25519 key and generated files are mode `0600`. Existing
directories/files are not overwritten. Omitting `--password-file` deliberately
creates an unencrypted private key and emits a warning; file permissions alone
are not a substitute for protected storage and backup.

Keep `signing-key.pem` private. Distribute **only** `trusted-keys.json`, which
contains the public verification key and its `kid`. The issuer script is not
copied into the customer API image. Assign an issuer owner and an issuance,
renewal, backup and key-rotation process before issuing customer licenses.

## 2. Publish the public trust bundle (manufacturer)

After reviewing the public-key fingerprint and securely backing up the private
key, put only the public `keys` mapping from `trusted-keys.json` into
`magic-cluster/apps/dashboard/license-official-trust.yaml`. The release-owned
bundle may additionally contain `retiredKeyIds`, an initially empty list. Key IDs
are stable: never reuse an existing ID for a different key. Check the bundle:

```bash
python dashboard/apps/api/check_license_trust.py --manifest \
  magic-cluster/apps/dashboard/license-official-trust.yaml
```

This check requires PyYAML for `--manifest` and prints only IDs and public-key
fingerprints. JSON input needs no YAML dependency. The public-release and image
build workflows run this gate before publishing artifacts.

The shared dashboard base deploys
`identity-system/magicstick-license-official-trust` on every installation path:
USB/cloud-init, existing Linux and existing Kubernetes. Flux owns and updates
this separate ConfigMap; it deliberately has no `ssa: IfNotPresent` annotation.
The API mounts it read-only and reads it via `LICENSE_OFFICIAL_TRUST_STORE`.
No API permission to create or patch trust ConfigMaps is added.

Publish the matching API image as well as the manifests: an older verifier
image does not read the new official store. After the release is installed,
confirm the expected key ID in **License & Enterprise** or `magicstick license
status`. Mounted ConfigMap propagation is asynchronous; each license check
rereads the files, and reloader also observes both stores.

### Upgrades and optional local trust

The original `magicstick-license-trust` ConfigMap remains the optional local
trust store. Its `ssa: IfNotPresent` and `prune: disabled` annotations preserve
administratively installed keys. Existing installations with an empty local
store automatically gain the official keys by mounting the new release-owned
store; no manual patch, migration Job, Secret reset or host reinstall is needed.

The API combines the official and local key sets. Identical keys under the same
ID are deduplicated; different keys under the same ID fail closed. An official
`retiredKeyIds` entry also removes that ID from the effective local set, so an
old local copy cannot silently restore a retired issuer ID. The local ConfigMap
itself and the installed license Secret are never rewritten by this merge.
Malformed or missing configured stores fail license verification instead of
silently falling back to another source. Community remains available.

Independent distributors may maintain their own public bundle. Cluster
administrators may deliberately add local issuers to `magicstick-license-trust`
using its existing `{"keys":{...}}` format; this is an advanced trust decision,
not part of customer license activation. Never accept keys supplied inside a
license upload and never put private signing keys into either store.

## 3. Issue a license

Create a private claims JSON file with these exact fields:

| Field | Contract |
|---|---|
| `version` | Integer `1` |
| `product`, `issuer` | Both `magicstick` |
| `licenseId` | Unique issuer-managed ID; letters, digits, `.`, `_`, `-`, at most 128 characters |
| `customer` | Nonempty customer reference, at most 160 characters; minimize personal data |
| `issuedAt`, `notBefore`, `expiresAt` | Integer Unix seconds, with `issuedAt <= notBefore < expiresAt` |
| `features` | Unique list of known entitlement IDs from the table above |
| `installationId` | Optional canonical UUID copied from the target's license status |

The issuance tool checks the claims and permits only a currently valid license.
No default duration, pricing metric, grace period or hardware limit is invented.
Use the actual agreed validity interval, not example timestamps.

```bash
/path/to/private/issuer-venv/bin/python dashboard/apps/api/license_issuer.py issue \
  --claims /path/to/private/customer-claims.json \
  --private-key /path/to/private/issuer-key-2026/signing-key.pem \
  --password-file /path/to/private/key-password \
  --kid issuer-2026 \
  --output /path/to/private/customer-license.json
```

The output is a JSON envelope with `format: magicstick-license/v1` and a compact
JWS `token`. Its protected header is exactly `alg: EdDSA`,
`typ: magicstick-license+jwt`, and `kid`. PyJWT performs JWS validation and
cryptography verifies Ed25519. Duplicate JSON members, unknown claim fields,
unknown/duplicate capabilities, alternate algorithms and externally supplied
key URLs are rejected. Signed data is authenticated, **not encrypted**.

## 4. Import through the dashboard, CLI or TUI

As an appliance administrator, open **Dashboard → License & Enterprise**.
Select the file, choose **Validate license**, review the customer, validity,
entitlements and current/replacement license IDs, then **Activate license**.
Changing the file discards the preview. A concurrent change requires a fresh
preview. Invalid, expired, future-dated and incorrectly bound files cannot
replace the persisted license. Export remains available for an existing file,
including an expired license.

The built CLI uses the same authenticated API:

```bash
magicstick license status
magicstick license status --json
magicstick license inspect /path/to/customer-license.json
magicstick license import /path/to/customer-license.json --yes
magicstick license export /path/to/new-backup-license.json
```

`--yes` explicitly approves replacing the current entitlements; files are not
merged. Export creates a mode-`0600` file and never overwrites an existing file.
In the TUI, administrators use the **License** tab: `a` selects a local file,
validates and opens a separate confirmation; `e` exports to a new local file.
Paths are relative to the machine/container running the CLI/TUI, not the browser.
On the physical-appliance TUI, prefer browser upload when the file is on another
computer. The read-only demo cannot import or export licenses.

## API and storage contract

All four routes require `magicstick-admin`; hiding the tab is not authorization.
Mutations also use the existing CSRF and browser same-origin validation.

| Method/path | Request/response |
|---|---|
| `GET /api/license` | Sanitized verification, installation ID, `revision`, trusted key IDs and distinct licensed/implemented/available states |
| `POST /api/license/validate` | `{document: string}` → `{candidate, current}`; no license replacement |
| `PUT /api/license` | `{document: string, expectedRevision: string}` → freshly read persisted status |
| `GET /api/license/export` | `{filename, content}` containing the original file |

Every response uses `Cache-Control: no-store`. Verification failures expose no
unverified claims. HTTP `409` means the storage revision changed; `413` means
the size limit was exceeded; storage/trust failures do not confirm a write.

The authoritative record is the runtime-created Secret
`identity-system/magicstick-enterprise-license`. Its data contains
`installationId` and, after activation, `license.json`. The random license
installation ID is initialized on the first admin status/preview request; it is
independent of IP, hostname and the first-run setup ID. The Secret has no Pod
owner and no Git manifest, so Pod replacement and ordinary Flux reconciliation
do not remove or reset it. Replacement uses Kubernetes `resourceVersion` (CAS).
If a response is lost after a write, refresh status before retrying; the client
does not assume that a network failure proves the write never occurred.

The dedicated namespace Role grants `get/update` only on the named Secret and
`create` for Secrets in that namespace. Kubernetes cannot restrict `create` by
`resourceNames`; this limitation is explicit. This role grants no list, delete,
workload, cluster-wide or trust-store modification permissions. Existing API
roles remain separate. `Appliance/local.spec` stays Git-owned.

Back up the Secret, including the installation ID, through the secured cluster
backup process. Exporting only the license file does not preserve the binding ID.
After losing the cluster/Secret, restore the secured record or reissue a bound
license for the new ID. A reinstall is not automatic license recovery. Secrets
are not encrypted merely by Base64 encoding: datastore protection/encryption at
rest is an installation responsibility, not enabled by this feature.

## Rotation, expiry and security boundary

For key rotation, first publish the official bundle with old and new public keys,
then issue replacement licenses with the new key ID. Remove an old key only
after the replacement plan is complete, and add its ID to `retiredKeyIds` so
legacy local copies do not re-enable it. The update invalidates licenses signed
under that ID on the next check after the mounted bundle changes. Keep retirement
IDs in future releases and inspect any separately configured aliases when
responding to a compromised signing key. Offline appliances need the update;
this is not immediate online revocation. Replacing a license replaces its entire entitlement
set. The first version has one active file, no scheduled replacements, online
revocation service, billing, audit ledger or configurable grace period.

Expired or unverifiable licenses produce no licensed capabilities. Community
routes do not call the Enterprise gate. Existing business features are not
changed and no running workload is stopped. Future Enterprise code must preserve
protective access policies and recovery on expiry; those business semantics need
their own implementation and tests, not just this foundation's tests.

`LicenseService.require_capability(feature, authorized=...)` is the future
server-side integration hook. It fails unless caller authorization, a verified
entitlement and an actually implemented/available capability all permit the
operation. At present it rejects every planned capability as unimplemented or
unlicensed. Future extensions must register their implementation and use the
same decision in applicable API and controller mutation paths; no existing
Community path is gated by this hook.

There is no promise of tamper-proof DRM. A local root/cluster administrator can
modify source code, keys, clock and datastore. Signatures stop forged license
claims in the unmodified product; they do not prevent a modified build from
removing its checks. Fully offline operation also cannot provide immediate
central revocation. Enterprise commercial terms and any additional enforcement
are separate decisions. The trust store, signing process and future commercial
boundary require their own operational/security review before customer use.

## Reproduce the local checks

```bash
python3 -m venv /tmp/magicstick-license-test-venv
/tmp/magicstick-license-test-venv/bin/pip install -r dashboard/apps/api/requirements.txt pyyaml
/tmp/magicstick-license-test-venv/bin/python -m unittest discover -s dashboard/apps/api

cd dashboard
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build
docker --context rancher-desktop build -t magicstick-api:license-test -f apps/api/Dockerfile .
cd ..
/tmp/magicstick-license-test-venv/bin/python dashboard/apps/api/rancher_license_test.py
```

The opt-in integration test uses only context `rancher-desktop`, creates its own
random namespace and removes that namespace afterward. It exercises the actual
API image and Kubernetes Secret/CAS/RBAC behavior with a synthetic userinfo
service and ephemeral signing keys, substituting only test public keys into the
isolated official ConfigMap for rotation. Initially it retains the shipped public
keys and adds an ephemeral test issuer; no manufacturer private key is used.
It covers automatic official trust with an unchanged
empty legacy store, local-key preservation, mounted-bundle rotation/retirement,
authenticated import, rejection, export, Pod restart and the built CLI. `--web`
also tests signed-file upload, preview and activation in Chrome through the
standard frontend Service. `--serve` additionally starts a
loopback-only built-React fixture for manual Chrome verification until Ctrl+C.
It is not a full Keycloak/Envoy, Flux lifecycle, physical-console, multi-node or
Enterprise-business-feature acceptance test. Abrupt termination may require
removing the printed test namespace; never reset the entire cluster.

The API image is built for amd64/arm64 by the dashboard-image workflow with
PyJWT and cryptography pinned in `requirements.txt`. Production manifests should
use its published `api-sha-<commit>` tag when advancing the runtime; changing only
the mounted backend ConfigMap does not update the packaged verification module.
