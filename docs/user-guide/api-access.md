# API access

## API Access Controls

The **API Access** tab is visible only when `/api/session` contains
`magicstick-admin`. It is independent of the Keycloak user-administration mode,
but LiteLLM and its PostgreSQL database must be available. Like System → Users,
its list is loaded only when opened or refreshed and is not part of the regular
30-second dashboard refresh.

Each access has a user-provided display name and an internal random LiteLLM key
alias. The table shows only the name, a shortened hash identifier, creation
time, status, and revoke action. The raw `sk-...` value is returned by the
backend only in the successful create response, displayed in a dedicated
one-time dialog, and cleared from the page when that dialog closes. LiteLLM
stores the key record in its PostgreSQL database; the dashboard does not create
a Kubernetes Secret for these user-facing keys and cannot recover an old raw
value. If a key is lost, revoke it and create a replacement.

Dashboard-created keys carry private ownership metadata. Listing filters out
all other LiteLLM keys, and deletion verifies this metadata before calling
LiteLLM, so the tab cannot modify keys provisioned by another tool. New keys
are restricted to LiteLLM's LLM API routes and currently receive access to all
model groups published by LiteLLM. Per-key model restrictions, budgets,
expiry, and team ownership are not exposed by this first dashboard contract.
