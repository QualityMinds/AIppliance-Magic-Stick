# SPDX-License-Identifier: MIT
import copy
import unittest

from migrate_frontend import migration_patch


def fixture():
    return {"kind": "Deployment", "metadata": {"name": "ai-appliance-dashboard", "resourceVersion": "7",
            "annotations": {"configmap.reloader.stakater.com/reload": "ai-appliance-dashboard-nginx,ai-appliance-dashboard-renderer"}},
            "spec": {"template": {"metadata": {"annotations": {"appliance.magicstick.dev/dashboard-config-revision": "old"}}, "spec": {
                "containers": [{"name": "nginx"}, {"name": "renderer"}, {"name": "web", "image": "ghcr.io/qualityminds/magicstick-dashboard:sha-test",
                                "volumeMounts": [{"name": "tmp", "mountPath": "/tmp"}]}],
                "volumes": [{"name": "html", "emptyDir": {}}, {"name": "scripts", "configMap": {"name": "ai-appliance-dashboard-renderer"}},
                            {"name": "nginx-config", "configMap": {"name": "ai-appliance-dashboard-nginx"}}, {"name": "tmp", "emptyDir": {}}]}}}}


def apply(document, patch):
    result = copy.deepcopy(document)
    for operation in patch:
        parts = [part.replace("~1", "/").replace("~0", "~") for part in operation["path"].split("/")[1:]]
        parent = result
        for part in parts[:-1]:
            parent = parent[int(part)] if isinstance(parent, list) else parent[part]
        key = int(parts[-1]) if isinstance(parent, list) else parts[-1]
        if operation["op"] == "test":
            assert parent[key] == operation["value"]
        elif operation["op"] == "remove":
            del parent[key]
        else:
            parent[key] = operation["value"]
    return result


class FrontendMigrationTests(unittest.TestCase):
    def test_removes_only_legacy_fields_and_is_idempotent(self):
        original = fixture()
        patch = migration_patch(original)
        self.assertEqual(patch[0], {"op": "test", "path": "/metadata/resourceVersion", "value": "7"})
        result = apply(original, patch)
        pod = result["spec"]["template"]["spec"]
        self.assertEqual(pod["containers"], original["spec"]["template"]["spec"]["containers"][2:])
        self.assertEqual(pod["volumes"], [{"name": "tmp", "emptyDir": {}}])
        self.assertEqual(migration_patch(result), [])
        self.assertEqual(len(original["spec"]["template"]["spec"]["containers"]), 3)

    def test_refuses_an_unmigrated_or_unexpected_frontend(self):
        for changes in ({"image": "example.invalid/web:test"}, {"volumeMounts": []}):
            original = fixture()
            original["spec"]["template"]["spec"]["containers"][2].update(changes)
            with self.assertRaises(ValueError):
                migration_patch(original)
        original["spec"]["template"]["spec"]["containers"].pop()
        with self.assertRaises(ValueError):
            migration_patch(original)

    def test_preserves_unrelated_containers_volumes_and_annotations(self):
        original = fixture()
        pod = original["spec"]["template"]["spec"]
        pod["containers"].append({"name": "sidecar", "volumeMounts": [{"name": "html"}]})
        pod["initContainers"] = [{"name": "init", "volumeMounts": [{"name": "scripts"}]}]
        pod["volumes"].append({"name": "user-data", "persistentVolumeClaim": {"claimName": "existing"}})
        original["metadata"]["annotations"]["configmap.reloader.stakater.com/reload"] += ",other-config"
        original["metadata"]["annotations"]["other"] = "preserved"
        result = apply(original, migration_patch(original))
        self.assertEqual([c["name"] for c in result["spec"]["template"]["spec"]["containers"]], ["web", "sidecar"])
        self.assertEqual([v["name"] for v in result["spec"]["template"]["spec"]["volumes"]], ["html", "scripts", "tmp", "user-data"])
        self.assertEqual(result["metadata"]["annotations"], {"configmap.reloader.stakater.com/reload": "other-config", "other": "preserved"})

    def test_rejects_wrong_resource_and_concurrent_update(self):
        original = fixture()
        original["metadata"]["name"] = "unrelated"
        with self.assertRaises(ValueError):
            migration_patch(original)
        original = fixture()
        patch = migration_patch(original)
        original["metadata"]["resourceVersion"] = "8"
        with self.assertRaises(AssertionError):
            apply(original, patch)

    def test_does_not_delete_persistent_volume_with_legacy_name(self):
        original = fixture()
        original["spec"]["template"]["spec"]["volumes"][0] = {"name": "html", "persistentVolumeClaim": {"claimName": "keep"}}
        result = apply(original, migration_patch(original))
        self.assertIn({"name": "html", "persistentVolumeClaim": {"claimName": "keep"}}, result["spec"]["template"]["spec"]["volumes"])


if __name__ == "__main__":
    unittest.main()
