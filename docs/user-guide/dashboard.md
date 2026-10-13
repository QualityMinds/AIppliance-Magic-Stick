# Dashboard overview

[![Overview cards showing appliance readiness and counts for modules, instances and models.](../assets/screenshots/dashboard-overview.webp)](../assets/screenshots/dashboard-overview.webp)

*Overview on the test appliance, captured 24 September 2026. The URL list below
the cards is outside this crop. Select any screenshot to open it at full size.*

## UI Areas

| Area | Purpose |
|---|---|
| Overview | Shows appliance health, module/instance/model counts, and the complete local, public, or direct URLs discovered for modules and app instances from Ingress, Gateway API `HTTPRoute`, and instance status. |
| Models | Creates and edits Ollama, vLLM and experimental Omni models in one local configuration form with shared CPU controls and engine-specific hardware and memory options. Starts, stops and removes local and external models; discovers Hugging Face repositories and Ollama Library models with selectable artifacts/tags; retains tested presets and direct references; shows per-device memory gauges and bounded runtime logs. |
| Services | Combines modules and instances: application cards contain their instances, shared AI runtime services stay compact, and technical platform modules are collapsed by default. The create dialog first selects an application and then shows only its configuration. |
| API Access | Lets administrators create multiple named LiteLLM API keys, view their non-secret metadata, and revoke individual keys. |
| Mesh | Administrator-only page directly below API Access for Private Mesh setup, membership, invitations, local-model sharing, and relay settings. Existing Settings Mesh links open this page. |
| Kubernetes Access | Lets administrators assign Viewer, Operator, or Cluster Administrator access to existing SSO identities and download or copy token-free OIDC kubeconfigs. |
| System → Settings → Federated SSO | Free Registered or Commercial: validates OIDC discovery or SAML metadata, stores providers in Keycloak, and maps exact upstream claim/attribute values to fixed Magic Stick roles. |
| System | Groups Settings, License, Users, Hardware, Model cache, Regression tests, System Status, and Computer power behind one primary navigation item. Settings contains the Domains, Federated SSO, Network, and Updates subtabs. Administration areas retain their role, identity, and entitlement restrictions; Hardware and System Status remain available to every dashboard role. Model cache and Regression tests are administrator-only; Computer power is an administrator-only tab immediately after System Status. |

Mesh has a direct link at `#/mesh`. Settings subtabs have direct links at `#/system/settings/<section>`; Domains
is the default at `#/system/settings`. Former `#/system/network` and
`#/system/updates` links redirect to the corresponding Settings subtab. Former
`#/settings/mesh`, `#/system/mesh`, and `#/system/settings/mesh` links redirect to Mesh.
Only the selected subtab mounts its page; opening Settings does not apply
network, update, domain, or identity configuration changes.

## Regression tests

On a dedicated disposable test server, open **System → Regression tests**.
Enable the optional runner and register the Appliance once, then choose
**Start regression tests**. The suite runs in Kubernetes and survives leaving or
reloading the page. It can stop models and change test-server state; never
register a production Appliance.

The page shows current phase/check, progress and separate executable-scenario
and case/layer counts. Expand **Failures and blocked checks** for the reason,
phase, variant, check layer, stage, next action and available filtered trace
location. **Download report** saves the full sanitized archive; **HTML summary**
and **JUnit XML** are also available. Cancel requests bounded teardown, not a
claim of successful restoration. See the [short runner guide](../development/regression-remaining-p0.md).
