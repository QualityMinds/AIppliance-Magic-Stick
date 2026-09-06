# Enterprise boundary

This directory contains the optional `resource-sharing` business implementation
in `magicstick_enterprise/`. Its source headers refer to the scoped
[Enterprise licensing notice](LICENSE), identified as
`LicenseRef-MagicStick-Enterprise`. The notice is provisional and is included
for review, not a completed customer agreement. Commercial distribution and
combined release images remain an **open release gate** until the terms are approved.
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
3. Keep Community builds usable without importing Enterprise code.
4. Check signed entitlement, implemented capability and caller authorization
   on the relevant backend and controller paths, not only in the UI.
5. Preserve protective policies, ordinary Community use and recovery on expiry.

A public source repository does not make future commercially licensed code
MIT automatically. Conversely, this boundary does not relicense any existing
code. The default API image and CI build stay Community-only. An explicit local
`--target enterprise` build includes the package for validation; no private key
or customer license is bundled. `--target community` never imports it.

Offline signatures prevent forged entitlements in the unmodified application;
they cannot prevent a host/cluster administrator from modifying the software,
trust store, clock or datastore. See [license operation and integration](../docs/licensing.md).
