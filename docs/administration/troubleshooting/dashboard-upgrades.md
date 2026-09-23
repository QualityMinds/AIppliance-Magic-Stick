# Dashboard upgrade recovery

### Dashboard upgrade cleanup

The standard Deployment and Service keep the name `ai-appliance-dashboard`.
The frontend Pod now has one `web` container on port 8080; the Service still
exposes port 80 and resolves its named `http` target. API/CLI resources and
runtime data are not replaced. The ConfigMap-based renderer and its nginx
configuration are no longer deployed. `index.html` is served with `no-store`;
hashed assets are immutable and missing assets return 404 rather than HTML.

Flux installations with pruning enabled remove the retired preview and
renderer resources from their inventory. The old `dashboard2` hostname is no
longer advertised by kdns and is removed from certificate and Keycloak
allowlists. Existing bookmarks must use the primary local or public root URL.
The Keycloak startup reconciliation updates existing clients as well as fresh
realm imports; no realm reset or user recreation is needed.

If `apps` reports `HealthCheckFailed` and a new frontend Pod is stuck at
`FailedMount` for `ai-appliance-dashboard-renderer` or
`ai-appliance-dashboard-nginx`, inspect the Deployment's container names and
managed fields. A previous manual/server-side apply can still own the old
`nginx` and `renderer` containers. Flux then adds `web` but cannot automatically
remove fields owned by that other manager. Resource pruning alone does not
clean up those fields, even with `prune: true`.

After reconciling the current React manifest, use the opt-in
[frontend migration helper](../../../dashboard/apps/api/migrate_frontend.py) from the
repository root. It requires an explicit context and defaults to a dry-run:

```bash
kubectl --context "$CONTEXT" -n dashboard get deployment ai-appliance-dashboard --show-managed-fields -o yaml
python3 dashboard/apps/api/migrate_frontend.py --context "$CONTEXT"
# Review the patch, then apply only the legacy-field cleanup:
python3 dashboard/apps/api/migrate_frontend.py --context "$CONTEXT" --apply
kubectl --context "$CONTEXT" -n dashboard rollout status deployment/ai-appliance-dashboard --timeout=120s
```

On a K3s host, run the helper with the appropriate administrator permissions
and `--kubectl 'k3s kubectl'`. It validates the new `web` container, preserves
unrelated containers, mounted volumes and PVCs, and removes only the known
legacy containers, unused legacy volumes and obsolete frontend annotations.
An atomic resource-version test stops the patch if another writer changes the
Deployment concurrently; review a fresh dry-run before retrying. Repeating the
helper after a successful migration makes no changes. The helper is an
administrator tool, not an API endpoint; dashboard RBAC is not expanded.

After the new Pod is `1/1 Ready`, allow the next Flux reconciliation or request
one for `flux-system/apps`, then check `apps` and `Appliance/local` readiness.
Do not recreate the missing renderer ConfigMaps or reset the appliance to work
around this upgrade issue.

If an external GitOps installation deliberately uses `prune: false`, first
reconcile identity and dashboard resources and verify the primary frontend is
Ready. Then remove only the retired objects, using the intended context:

```bash
kubectl --context "$CONTEXT" -n dashboard rollout status deployment/ai-appliance-dashboard --timeout=120s
kubectl --context "$CONTEXT" -n dashboard delete deployment,service ai-appliance-dashboard-next --ignore-not-found
kubectl --context "$CONTEXT" -n dashboard delete configmap ai-appliance-dashboard-renderer ai-appliance-dashboard-nginx --ignore-not-found
kubectl --context "$CONTEXT" -n dashboard delete referencegrant allow-identity-dashboard-next --ignore-not-found
kubectl --context "$CONTEXT" -n identity-system delete httproute dashboard-next-local --ignore-not-found
kubectl --context "$CONTEXT" -n identity-system delete securitypolicy dashboard-next-local-oidc --ignore-not-found
```

Do not delete the primary dashboard, shared API, identity namespace, runtime
resources, Secrets or PVCs. A migration does not require reinstalling the host.
