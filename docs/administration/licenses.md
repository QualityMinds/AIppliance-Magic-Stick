# License management

Magic Stick is source-available under [BSL 1.1](../../LICENSE), with the
[Additional Use Grant and three editions](../../LICENSING.md). The same API, CLI,
TUI and browser dashboard serve every edition. Resource Sharing, Private Mesh,
local identity, model runtimes and GPU management have no license-file gate.

## Editions and entitlements

| Technical edition | Signed claims | Entitlements |
|---|---|---|
| Free | No valid active file | None required for core functionality |
| Free Registered | `edition: free-registered` | `federated-sso` |
| Commercial | `edition: commercial` | `commercial-production`, `federated-sso` |

Commercial-production is a signed record of commercial production permission,
not a CPU/model startup switch. The software does not inspect revenue or decide
legal eligibility. Companies outside the grant must obtain a commercial
agreement even when the technical status says Free. Registration is free for
eligible users; a request is not itself an issued license or contract.

Only Federated SSO is feature-gated. The broker-only gateway route performs a
fail-closed entitlement check on every external login/callback. If verification
or its API is unavailable, that route denies access; it has no cached allow state.
Without a valid entitlement, the enforcement loop also disables all external
brokers, including social/custom providers, without deleting providers, mappings,
local users or credentials. Local Keycloak login, local roles, component OIDC and
recovery remain available. Viewing managed federation and recovery deletion
remain administrator-only operations; provider activation and changes require
the entitlement. Existing sessions obey their ordinary token/session lifetime;
disabling a provider is not an immediate revocation of every issued token.

## Customer workflow

Open **System → License** to see the technical edition, verify an uploaded file,
review replacement, explicitly activate it, or export the active document.
The screen embeds LICENSE, LICENSING.md, the MIT Change License and third-party
notices for offline reading/download. Those notices do not require the license
API to be healthy.

To request a license:

1. Enter a customer reference (maximum 160 characters; minimize personal data).
2. Select **Free Registered** or **Commercial**. Entitlements follow the edition.
3. Set a positive whole-number TTL in hours or days.
4. Download unsigned JSON and privately send it to the authorized issuer.

The default request TTL of 30 days is a convenience, not a trial or business
duration policy. The request is bound to the appliance and starts its validity
at download generation. A day means 86,400 seconds. The issuer reviews and may
adjust customer, dates, binding and eligibility before signing. Downloading a
request never replaces the active file and cannot activate a feature.

## Offline license operation

Dashboard administrators use **System → License**; terminal administrators
use `magicstick license status` or the TUI's **License** tab. Free requires no
file. Free Registered enables Federated SSO, and Commercial records
`commercial-production` plus `federated-sso`. Local identity, models, Resource
Sharing and Private Mesh remain independent of license-file validity.
Production-use eligibility follows [the BSL Additional Use Grant](../../LICENSING.md);
software does not assess revenue.

In **System → License → Request license**, enter the customer reference, select
the edition and set the TTL in hours or days, then download the JSON for signing.
The file is bound to the installation and uses absolute validity times starting
when generated; the editable 30-day initial TTL is only a request. The issuer
reviews and signs it outside the appliance with the existing `--claims` workflow.
Downloading leaves current entitlements unchanged. Upload and validate the signed
result separately; an unsigned request is not an activation file.

Official releases deliver the issuer's public keys automatically. Customers
upload only their signed JSON; there is no manual trust-store installation step.
Follow [licensing.md](licenses.md) for manufacturer key publication, issuance
outside the appliance, rotation and runtime Secret backups. On upgrade, the new
release-owned official store works alongside the preserved local store without
rewriting it. Confirm the expected key ID with `magicstick license status`.
If keys are unavailable, check that the official ConfigMap and matching API image
have both reconciled; never resolve this by importing a key from the license file.
The private signing key must never enter the cluster. Back up both the original
license and its installation ID; a bound file alone cannot restore a lost ID.
After an ambiguous write failure, refresh status before retrying. Never delete
the Secret as a routine troubleshooting step, and do not copy its contents into
logs/issues. A Pod restart preserves it; a deleted cluster does not.
