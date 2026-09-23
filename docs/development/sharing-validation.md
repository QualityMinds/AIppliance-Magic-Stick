# Instance sharing validation

## Verification

Unit/API tests: `dashboard/apps/api/test_instance_access.py`; operator guard
tests: `magic-cluster/platform/magicstick-operator/controller/test_controller.py`;
React and CLI tests live next to their client code. The opt-in integration test
uses real Keycloak, Chrome OIDC login, Envoy, API, CRD validation and
ACL enforcement without a license file:

```bash
docker --context rancher-desktop build -f dashboard/apps/api/Dockerfile \
  -t magicstick-api:sharing-test .
PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright \
  /path/to/venv/bin/python dashboard/apps/api/rancher_sharing_test.py
```

Install `dashboard/apps/api/requirements.txt` and `pyyaml` in that virtualenv.
Node.js, Playwright, Chrome, kubectl and Helm are also required. The browser
helper keeps ephemeral session cookies in a private subprocess pipe, never the
test report. A separate synthetic-fixture Chrome layout/interaction test is
available after `cd dashboard && pnpm build`:

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright \
  node dashboard/apps/api/sharing_browser_test.cjs
```

Run the commands above from the repository root. The frontend fixture test is
not evidence of backend authorization; the Rancher test covers that separately.
The test creates a random namespace/class/release, ephemeral signing keys and
test identities, and removes its resources. It does not replace existing CRDs
or contact the physical server. Abrupt termination can require cleanup of the
printed namespace and its explicitly named test cluster resources. A full Flux
upgrade of an existing physical appliance remains a separate release check.

The test commands are acceptance procedures, not a claim that a physical
appliance or production multi-tenant deployment has passed. Record the exact
revision and environment for each release. License validity must never grant
an unauthorized user access or prevent an otherwise authorized sharing decision.
