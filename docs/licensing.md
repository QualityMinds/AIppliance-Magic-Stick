# Offline license management

The first AIMS-005 increment adds **MIT-licensed infrastructure**, not Enterprise
business features. The React dashboard, CLI and TUI use the same admin-only API
and persistent Kubernetes state. No existing Community operation requires a
license. The old ConfigMap-rendered frontend is unchanged.

## Current scope

`License & Enterprise` in Dashboard 2 provides status, file selection, validation,
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

## 1. Prepare the issuer outside the appliance

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

## 2. Install the public trust store

Select the intended kubeconfig context explicitly. Use the public output from
the previous step, never the private PEM. From the repository root:

```bash
kubectl --context "$CONTEXT" -n identity-system create configmap magicstick-license-trust \
  --from-file=trusted-keys.json=/path/to/public/trusted-keys.json \
  --dry-run=client -o yaml | \
  kubectl --context "$CONTEXT" apply -f -
```

The base installs an empty trust store with Flux `ssa: IfNotPresent` and
`prune: disabled`. Flux therefore does not replace an administratively installed
trust store with the empty default. This intentionally replaces the public-key
set: review the existing store and retain old keys during a planned rotation.
Coordinate with any other configuration owner before changing it. The mounted
ConfigMap is reread for each check. Kubelet propagation
is asynchronous; the existing reloader also observes this ConfigMap. Wait until
the new key ID appears in the status before issuing/importing a matching file.

The public store is deployment configuration, not an upload option. Its default
has **no production or test verification keys**. An empty store leaves Community
usable and rejects license activation.

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

As an appliance administrator, open **Dashboard 2 → License & Enterprise**.
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

For key rotation, first distribute a store containing old and new public keys,
then issue replacement licenses with the new key ID. Remove an old key only
after the replacement plan is complete; removing it invalidates licenses signed
by that key on the next check. Replacing a license replaces its entire entitlement
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
service and ephemeral signing keys. It covers authenticated import, rejection,
export, Pod restart and the built CLI. `--serve` additionally starts a
loopback-only built-React fixture for manual Chrome verification until Ctrl+C.
It is not a full Keycloak/Envoy, Flux lifecycle, physical-console, multi-node or
Enterprise-business-feature acceptance test. Abrupt termination may require
removing the printed test namespace; never reset the entire cluster.

The API image is built for amd64/arm64 by the dashboard-image workflow with
PyJWT and cryptography pinned in `requirements.txt`. Production manifests should
use its published `api-sha-<commit>` tag when advancing the runtime; changing only
the mounted backend ConfigMap does not update the packaged verification module.
