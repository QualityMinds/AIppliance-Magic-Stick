# Magic Stick licensing

Magic Stick's own code is source-available under the **Business Source License
1.1** (`BUSL-1.1`). The binding parameters, Additional Use Grant and unmodified
license terms are in [LICENSE](LICENSE). BSL is not an Open Source license.
Each version changes to the [MIT Change License](licenses/MIT-CHANGE.txt) three
years after that version's first public distribution. Redistribution does not
restart that period. Release artifacts must identify their exact dates.

## Use and editions

| Edition | Eligible use | Signed file | Functions |
|---|---|---|---|
| Free | Personal use; non-profit organizations; education/research; businesses with Group revenue at most EUR 2,000,000 under the Additional Use Grant | None | All core functions except Federated SSO |
| Free Registered | The same eligible production uses | Free signed license | All core functions and Federated SSO |
| Commercial | Production use outside the grant, including businesses above the threshold and excluded commercial third-party services | Commercial signed license and corresponding agreement | All core functions, Federated SSO and commercial-production entitlement |

The revenue threshold applies to the entire controlling group, without counting
intra-group revenue twice. New groups use a reasonable documented good-faith
first-year forecast. Subsidiaries do not receive separate thresholds.
See LICENSE for the precise scope, currency conversion and definitions.

Productive OEM/appliance, SaaS, hosting and managed-service offerings for third
parties, where Magic Stick is material to the offering, are not covered by the
free production-use grant regardless of revenue. Contractors administering it
solely for an eligible customer's internal benefit may act under that customer's
permission. BSL's copying, modification, redistribution and non-production-use
rights are not restricted by the grant; resale alone is not a licensing trigger.

## Technical activation

Only **Federated SSO** is feature-gated by a signed file. Local Keycloak, local
users/groups/roles/login, component OIDC, Resource Sharing, Private Mesh,
multi-GPU management, model engines and Realtime work without a license file.
Normal authentication, authorization, isolation and membership checks apply
in every edition.

The two entitlement IDs are `commercial-production` and `federated-sso`.
An offline-verified file contains the edition, customer, validity, entitlements
and optionally an installation binding. No online activation server or revenue
inspection is required. A missing/expired file is not a determination that the
operator legally qualifies for Free use. Revenue and use-case eligibility are
the operator's responsibility. The signed file is a technical record; commercial
rights, fees and contractual terms are agreed separately with the Licensor.

Without a valid Federated SSO entitlement, external providers are disabled without
deleting configuration; local login and recovery remain available. Resource
Sharing ACLs and Mesh security do not depend on license validity.
See [offline license management](docs/licensing.md).

## Scope, notices and release control

The same source tree and images serve all editions; business functions reside
in `core/magicstick_core/`. There is no separate paid source package.
Magic Stick-owned file headers and package/image metadata use `BUSL-1.1`.
Files without headers are covered by LICENSE unless third-party provenance or a
more specific notice says otherwise. Do not relabel third-party files.

Third-party packages, base images, charts, fonts, models and adapted upstream
code retain their own licenses. An image's Magic Stick license label does not
relicense its dependencies. Preserve all applicable copyright, license, NOTICE,
source-offer and modification notices; see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md).

The Additional Use Grant, release-date mechanism, contribution ownership,
commercial agreement and distribution-specific dependency obligations remain
legal-review topics. The [release audit](docs/license-audit.md) records technical
evidence and open items, not legal clearance. Normal CI reports these items
without requiring a blanket manual approval; an explicit strict distribution
review is optional. This workflow policy does not change any license terms or
waive actual notice, source or usage obligations.

Primary license references: [MariaDB BSL 1.1](https://mariadb.com/bsl11/),
[BSL adopter FAQ](https://mariadb.com/bsl-faq-adopting/),
[SPDX BUSL-1.1](https://spdx.org/licenses/BUSL-1.1.html).
