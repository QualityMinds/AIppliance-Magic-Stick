# Enterprise boundary

This directory contains the license-gated `resource-sharing` business implementation
in `magicstick_enterprise/`. Its source headers refer to the scoped
[Enterprise licensing notice](LICENSE), identified as
`LicenseRef-MagicStick-Enterprise`. The notice is provisional and is included
for review, not a completed customer agreement. Commercial distribution remains
an **open release gate** until the terms are approved.
This README, integration contracts, UI and license-management infrastructure
remain under the repository's [MIT license](../LICENSE). The repository-wide
[licensing overview](../LICENSING.md) makes that distinction explicit.

The shared foundation lives in `dashboard/apps/api`, the shared API contracts,
the React dashboard and the CLI/TUI. License upload, offline verification,
storage and status are Community infrastructure, not paid business features.

Before commercially releasing the first Enterprise implementation:

1. Define its boundary without restricting existing MIT functionality.
2. Approve final commercial terms with an explicit scope for that new code;
   identify the applicable license in its files and combined-image notices.
3. Keep Community operation usable without a license even though the standard
   API image contains the Enterprise package.
4. Check signed entitlement, implemented capability and caller authorization
   on the relevant backend and controller paths, not only in the UI.
5. Preserve protective policies, ordinary Community use and recovery on expiry.

A public source repository does not make future commercially licensed code
MIT automatically. Conversely, this boundary does not relicense any existing
code. CI publishes one combined API image with the identifier
`MIT AND LicenseRef-MagicStick-Enterprise`; it contains no private key or
customer license. Without a valid signed entitlement, its Enterprise capability
stays unavailable and ordinary Community behavior remains usable.

Offline signatures prevent forged entitlements in the unmodified application;
they cannot prevent a host/cluster administrator from modifying the software,
trust store, clock or datastore. See [license operation and integration](../docs/licensing.md).
