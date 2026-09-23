# Share an application

Resource Sharing adds user/group allow-lists to **AppInstance**
resources. It supplements existing SSO, minimum-role and local/public exposure
settings; these core functions remain available without a license.
This increment does not add module ACLs, team delegation or resource budgets.

## Dashboard workflow

1. Install the standard API image. Resource Sharing needs no license file.
2. In **Dashboard → Services**, expand an application's instances and select
   **Sharing**. Administrators can also select sharing while creating an instance.
3. Keep **All users with the required role**, or select **Selected users or groups**.
4. Search the Keycloak directory, add existing users/groups, review the selection
   and confirm **Save sharing**. A concurrent change requires reopening the dialog
   and reviewing the latest state.

Only a currently enabled, live-verified `magicstick-admin` can change sharing.
The picker uses stable Keycloak IDs, never usernames, emails or group names as
authority. Renaming an identity does not remove its grant; deleting/recreating
one with the same name does not inherit the old grant. Disabled users and service
accounts cannot be selected. Group creation remains in Keycloak, not this UI.
Membership in a subgroup also counts as membership in its parent groups.

A selected user **or** a member of any selected group is granted access, provided
the existing minimum role also allows it. An empty selected list denies everyone.
Selected sharing requires SSO; `authentication: none` cannot bypass it.
Administrators retain the management view but do **not** automatically receive
app access or private instance credentials. Ordinary viewers/operators see only
their permitted instances; membership lists are not disclosed to them.
The basic `magicstick-user` role receives a minimal **My instances** launchpad,
not access to the control-plane/status/admin APIs.
