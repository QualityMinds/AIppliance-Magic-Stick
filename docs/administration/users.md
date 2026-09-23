# Users and roles

Sign in as an administrator and open **System → Users**.

1. Choose **Create User**, or select an existing local account to edit.
2. Give the account the least access it needs: User opens assigned applications;
   Viewer reads the dashboard; Operator manages workloads; Administrator manages
   system settings and identities.
3. Set a temporary password for a new local account. Share it through a private
   channel; the user must change it at first sign-in.
4. Check the user's effective access. Roles inherited from groups remain in place.

Disable an account to withdraw access without deleting it. Passwords and profiles
for external identities remain managed by their identity provider. The detailed
authorization and session behavior below explain the limits of these actions.

## Dashboard User Lifecycle

Administrators manage human identities from **System → Users** in the dashboard. The
dashboard backend uses its dedicated Keycloak client-credentials flow; the
browser never receives that client secret or a Keycloak Admin API token. The
dedicated API ServiceAccount
`identity-system/ai-appliance-dashboard-api` may read only
`Secret/magicstick-user-admin-client` and caches the short-lived admin token in
memory until shortly before expiry. The React/nginx frontend Pod has no
ServiceAccount token and therefore cannot read that Secret.

Local accounts can be created, edited, enabled, disabled, assigned one of the
four MagicStick access levels, reset to a temporary password, and deleted.
Passwords travel directly to Keycloak and are neither stored as Kubernetes
Secrets nor returned by the dashboard API. Service accounts are excluded from
the user list.

Identity-provider accounts become visible after Keycloak creates or links their
local broker identity. The dashboard identifies the provider and treats the
upstream profile and password as externally managed. It may administer direct
MagicStick roles and Keycloak's local enabled state, but does not modify or
delete the upstream directory account. Disabling is preferred to deleting a
brokered shadow user.

## User Controls

### Targeted instance sharing

Dashboard administrators use the **Sharing** button on each instance, or the
sharing fields in **Create Instance**, to choose selected Keycloak users/groups.
Resource Sharing is a core function and does not require a license file. The existing default remains all users with the required role.
The API filters instance lists, overview/module/status/event data and derived
URLs for non-admins. A separate edge check enforces app and credential access;
an admin's management visibility does not automatically grant app use. Basic
`magicstick-user` accounts see only the **My instances** launchpad, while the
full dashboard still requires viewer/operator/admin roles.

Existing groups (including their subgroups) can be selected; group creation and
federation management are not added here. The CLI supports `instance principals`,
`instance access` and confirmed `instance share --file ... --yes` commands.
See [instance-sharing.md](../user-guide/sharing.md) for the exact contract, expiry and
recovery behavior, rollout dependencies, limitations and local test procedure.

### User administration

The **System → Users** tab is hidden unless `/api/session` contains
`magicstick-admin` and does not report `identityManagementAvailable: false`.
This is only a presentation rule; the backend independently enforces the same
authorization. The user list is loaded lazily when an administrator opens the
sub-tab and after a mutation. It is not part of the global 30-second dashboard
refresh. A direct-external-provider overlay has no local Keycloak administration
surface, so it reports identity management unavailable and the sub-tab stays hidden.

The table shows username, display name, email, enabled state, identity source,
creation time, direct MagicStick roles, and effective access. Search is
server-side and bounded to 10, 25, or 50 results per page. Status and identity
source filters operate on the current page. The **Create User** button remains
visible at the top of the sub-tab while it is open.

The access selector maps to direct realm roles:

| Access level | Direct roles managed by the dashboard |
|---|---|
| User | `magicstick-user` |
| Viewer | `magicstick-user`, `magicstick-viewer` |
| Operator | `magicstick-user`, `magicstick-operator` |
| Administrator | `magicstick-user`, `magicstick-admin` |

Role updates preserve unrelated realm roles and roles inherited from groups.
The dashboard displays effective roles for orientation but does not attempt to
remove group-derived access.

Local users support profile changes, direct MagicStick role changes,
enable/disable, temporary-password reset, and deletion when the API capability
flags allow the action. Brokered or federated users are shown only after
Keycloak knows them. Their upstream profile and password remain read-only;
MagicStick roles and local enabled state may still be managed when permitted.
External users are disabled rather than deleted because deleting a Keycloak
shadow account neither deletes the upstream identity nor prevents it from
returning on a later broker login.

The server blocks self-disable, self-delete, self-demotion, recovery-account
changes, and any operation that would remove the last enabled administrator or
last enabled local administrator. The UI consumes per-user capability flags and
explains unavailable actions, but callers must rely on the backend response as
the authorization decision.

Passwords are accepted only in create and reset forms, sent directly to the
backend over the protected same-origin route, and immediately cleared from the
browser form after submission. They are never returned by the API or rendered
into the user list. Passwords created here are temporary and must be changed at
the next Keycloak login.

Disable, access reduction, password reset, and deletion request a server-side
Keycloak logout. This ends the Keycloak session, but an already issued JWT can
remain valid at Envoy's local JWT filter until that token expires. The
user-administration API itself performs a live actor lookup, so a disabled or
demoted administrator loses that API access immediately even while an older
edge token still exists.
