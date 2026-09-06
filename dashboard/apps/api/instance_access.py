# SPDX-License-Identifier: MIT
"""Community integration and fail-closed boundary for optional instance sharing.

No Enterprise module is required for unrestricted instances. Missing code,
licenses or identity data never convert a restriction into public access.
"""
import copy
import importlib
import json
import re
import urllib.error
import urllib.parse

from licensing import LicenseError

ID = re.compile(r"[A-Za-z0-9._:-]{1,160}")


def restricted(instance):
    access = (instance.get("spec") or {}).get("access") or {}
    if "sharing" not in access:
        return False
    policy = access["sharing"]
    return not (isinstance(policy, dict) and policy.get("mode") == "all"
                and set(policy) <= {"mode", "users", "groups"}
                and policy.get("users", []) == [] and policy.get("groups", []) == [])


def plugin():
    try:
        return importlib.import_module("magicstick_enterprise.sharing")
    except ImportError as error:
        raise LicenseError("not_implemented", "Instance sharing is not installed.", 503) from error


def redact_hidden(payload, hidden):
    """Remove instance identifiers, links and derived workload names from read APIs."""
    markers = set()
    for instance in hidden:
        metadata = instance.get("metadata") or {}
        spec = instance.get("spec") or {}
        status = instance.get("status") or {}
        for value in (metadata.get("name"), metadata.get("uid"), (spec.get("values") or {}).get("name"),
                      status.get("name"), status.get("url"), status.get("localURL"), status.get("publicURL")):
            if isinstance(value, str) and value:
                markers.add(value.rstrip("/"))
    if not markers:
        return payload
    patterns = [re.compile(r"(?<![A-Za-z0-9])" + re.escape(marker) + r"(?![A-Za-z0-9])") for marker in markers]
    def private(value):
        return isinstance(value, str) and any(pattern.search(value) for pattern in patterns)
    def visit(value):
        if isinstance(value, list):
            return [clean for item in value if (clean := visit(item)) is not None]
        if isinstance(value, dict):
            if any(private(value.get(key)) for key in ("name", "url", "localURL", "publicURL", "uid")):
                return None
            if any(private(host) for key in ("hosts", "hostnames") if isinstance(value.get(key), list) for host in value[key]):
                return None
            return {key: clean for key, item in value.items() if not private(key) and (clean := visit(item)) is not None}
        return None if private(value) else value
    return visit(payload) or {}


class InstanceAccess:
    def __init__(self, *, license_service, user, groups, roles, identity, admin, request, namespace):
        self.license = license_service
        self.user = user
        self.groups = groups
        self.roles = roles
        self.identity = identity
        self.admin = admin
        self.request = request
        self.namespace = namespace

    def require_license(self):
        self.license.require_capability("resource-sharing", authorized=True)

    def require_admin(self, principal):
        self.admin(principal)  # A live Keycloak lookup, not a stale token role.

    def policy(self, instance):
        raw = ((instance.get("spec") or {}).get("access") or {}).get("sharing", {"mode": "all"})
        return plugin().validate_policy(raw)

    def group_ids(self, subject):
        # Membership in a subgroup also grants access to its parent groups.
        pending = list(self.groups(subject))
        seen = set()
        while pending:
            group = pending.pop()
            identifier = group.get("id")
            if not isinstance(identifier, str) or not ID.fullmatch(identifier):
                raise LicenseError("identity_unavailable", "Group membership could not be verified.", 503)
            if identifier in seen:
                continue
            if len(seen) >= 1000:
                raise LicenseError("identity_unavailable", "Group membership exceeds the supported bound.", 503)
            seen.add(identifier)
            detail = self.identity("GET", "/groups/" + urllib.parse.quote(identifier, safe=""))
            parent = detail.get("parentId")
            if parent:
                pending.append({"id": parent})
        return seen

    def can_use(self, instance, principal):
        if not restricted(instance):
            return True
        try:
            self.require_license()
            access = (instance.get("spec") or {}).get("access") or {}
            if access.get("authentication", "sso") != "sso":
                return False
            policy = self.policy(instance)
            subject = principal.get("subject", "")
            user = self.user(subject)
            if user.get("id") != subject:
                return False
            minimum = access.get("role", "user")
            levels = {"user": {"user", "viewer", "operator", "admin"}, "viewer": {"viewer", "operator", "admin"},
                      "operator": {"operator", "admin"}, "admin": {"admin"}}
            if not {"magicstick-" + role for role in levels.get(minimum, set())}.intersection(self.roles(subject)):
                return False
            groups = self.group_ids(subject) if policy["groups"] else set()
            return plugin().permits(policy, user, groups)
        except (LicenseError, ValueError):
            return False

    def visible(self, instances, principal):
        if "magicstick-admin" in principal.get("roles", []):
            self.require_admin(principal)
            return instances  # Administration is not permission to use the app.
        return [instance for instance in instances if self.can_use(instance, principal)]

    def prepare(self, principal, policy, authentication="sso"):
        self.require_admin(principal)
        self.require_license()
        policy = plugin().validate_policy(policy)
        if policy["mode"] == "selected" and authentication != "sso":
            raise ValueError("Selected-user access requires SSO.")
        for identifier in policy["users"]:
            user = self.user(identifier)
            if user.get("id") != identifier or user.get("enabled") is not True or user.get("serviceAccountClientId"):
                raise ValueError("Select enabled human users only.")
        for identifier in policy["groups"]:
            group = self.identity("GET", "/groups/" + urllib.parse.quote(identifier, safe=""))
            if group.get("id") != identifier:
                raise ValueError("Selected group does not exist.")
        return policy

    def describe(self, principal, instance):
        self.require_admin(principal)
        status = self.license.status()
        feature = next(item for item in status["features"] if item["id"] == "resource-sharing")
        metadata = instance.get("metadata") or {}
        access = (instance.get("spec") or {}).get("access") or {}
        labels = {"users": [], "groups": []}
        policy = access.get("sharing") or {}
        for kind in labels:
            for identifier in policy.get(kind, []):
                try:
                    value = self.identity("GET", "/" + kind + "/" + urllib.parse.quote(identifier, safe=""))
                    name = value.get("username") if kind == "users" else value.get("path") or value.get("name")
                except Exception:
                    name = None  # Deleted identities remain removable by their immutable ID.
                labels[kind].append({"id": identifier, "name": name or identifier})
        return {"name": metadata.get("name"), "revision": metadata.get("resourceVersion"),
                "sharing": access.get("sharing", {"mode": "all", "users": [], "groups": []}),
                "authentication": access.get("authentication", "sso"),
                "guardReady": (instance.get("status") or {}).get("accessGuardReady") is True,
                "feature": feature, "principals": labels}

    def update(self, principal, instance, payload):
        if not isinstance(payload, dict) or set(payload) != {"sharing", "expectedRevision"}:
            raise ValueError("Specify sharing and expectedRevision.")
        metadata = instance.get("metadata") or {}
        revision = payload["expectedRevision"]
        if not isinstance(revision, str) or revision != metadata.get("resourceVersion"):
            raise LicenseError("conflict", "Instance changed. Reload and review the sharing policy.", 409)
        if (instance.get("status") or {}).get("accessGuardReady") is not True:
            raise LicenseError("guard_not_ready", "Wait for the instance access guard to become ready.", 409)
        access = copy.deepcopy((instance.get("spec") or {}).get("access") or {})
        policy = self.prepare(principal, payload["sharing"], access.get("authentication", "sso"))
        access["sharing"] = policy
        path = f"/apis/appliance.magicstick.dev/v1alpha1/namespaces/{self.namespace}/appinstances/{metadata['name']}"
        resource = copy.deepcopy(instance)
        resource.pop("status", None)
        resource["metadata"].pop("managedFields", None)
        resource["spec"]["access"] = access
        try:
            result = self.request("PUT", path, resource)
        except urllib.error.HTTPError as error:
            if error.code == 409:
                raise LicenseError("conflict", "Instance changed. Reload and review the sharing policy.", 409) from error
            raise LicenseError("storage_unavailable", "Sharing was not confirmed; reload the instance.", 503) from error
        # Audit identity/action only; never log tokens or full policy membership.
        print(json.dumps({"event": "magicstick.instance-sharing", "actor": principal.get("subject"),
                          "instance": metadata.get("name"), "mode": policy["mode"], "result": "updated"}), flush=True)
        return self.describe(principal, result)

    def principals(self, principal, query):
        self.require_admin(principal)
        self.require_license()
        kind = query.get("kind", ["users"])[0]
        search = query.get("search", [""])[0].strip()
        if kind not in {"users", "groups"} or len(search) > 128:
            raise ValueError("Use kind=users or groups and a search of at most 128 characters.")
        first = int(query.get("first", ["0"])[0])
        if first < 0 or first > 10000:
            raise ValueError("Invalid result offset.")
        params = {"search": search, "first": first, "max": 51, "briefRepresentation": "true"}
        if kind == "groups":
            params["populateHierarchy"] = "false"
        items = self.identity("GET", "/" + kind + "?" + urllib.parse.urlencode(params))
        if not isinstance(items, list):
            raise LicenseError("identity_unavailable", "Identity search is unavailable.", 503)
        entries = []
        for item in items[:50]:
            identifier = item.get("id")
            if not identifier or not ID.fullmatch(identifier):
                continue
            if kind == "users" and (item.get("enabled") is not True or item.get("serviceAccountClientId") or str(item.get("username", "")).startswith("service-account-")):
                continue
            entries.append({"id": identifier, "name": item.get("username") if kind == "users" else item.get("path") or item.get("name")})
        return {"kind": kind, "items": entries, "next": first + 50 if len(items) > 50 else None}
