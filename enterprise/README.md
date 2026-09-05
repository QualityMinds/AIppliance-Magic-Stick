# Enterprise boundary

This directory reserves the location for **future** Enterprise business code.
There is no Enterprise implementation here yet. This README and the current
license-management infrastructure remain under the repository's [MIT license](../LICENSE).

The shared foundation lives in `dashboard/apps/api`, the shared API contracts,
the React dashboard and the CLI/TUI. License upload, offline verification,
storage and status are Community infrastructure, not paid business features.

Before adding the first Enterprise implementation:

1. Define its boundary without restricting existing MIT functionality.
2. Add reviewed commercial terms with an explicit scope for that new code;
   identify the applicable license in its files and combined-image notices.
3. Keep Community builds usable without importing Enterprise code.
4. Check signed entitlement, implemented capability and caller authorization
   on the relevant backend and controller paths, not only in the UI.
5. Preserve protective policies, ordinary Community use and recovery on expiry.

A public source repository does not make future commercially licensed code
MIT automatically. Conversely, this placeholder does not relicense any existing
code. No commercial terms or paid implementation are supplied by this change.

Offline signatures prevent forged entitlements in the unmodified application;
they cannot prevent a host/cluster administrator from modifying the software,
trust store, clock or datastore. See [license operation and integration](../docs/licensing.md).
