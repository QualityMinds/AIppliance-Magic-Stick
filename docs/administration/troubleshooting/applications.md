# Application troubleshooting

## App Checks

```bash
kubectl -n ai get pods
kubectl -n ai get svc,ingress
kubectl -n dashboard get pods,service,referencegrant
kubectl -n identity-system get httproute,securitypolicy
kubectl -n identity-system get httproutes,securitypolicies
```

The dashboard's **Services** tab combines the former Modules and Instances
views. Application instances appear below their parent application, shared AI
runtime modules have their own compact section, and technical platform modules
are collapsed by default. Each application's nested instances also start
collapsed and can be expanded independently without changing runtime state.
In the React dashboard, expand the application to see its instance URLs; the
parent card displays only the module's own URLs to avoid duplicate links.
These are presentation groups only: module actions still reconcile
`ModuleActivation` resources and instance actions still reconcile `AppInstance`
resources. When an entry appears in the wrong group, inspect the module catalog
and application `requiredModules` before changing a runtime resource.
Hardware-backed entries use the appliance hardware-provider state, not merely
the Flux apply result. NVIDIA therefore remains `Installing` until both an
allocatable `nvidia.com/gpu` resource and readable DCGM telemetry are available.

## AppInstance Gateway Access

The operator publishes enabled instances through Envoy Gateway and removes the
routes again when an instance is suspended or deleted. Inspect the generated
contract with:

```bash
kubectl -n ai-system get appinstances
kubectl -n identity-system get httproutes,securitypolicies \
  -l appliance.magicstick.dev/appinstance
kubectl -n ai get referencegrants
```

An SSO route must report `Accepted=True`, its SecurityPolicy must be accepted,
and its backend ReferenceGrant must name the application Service. `403` after a
successful login means the account does not have the minimum role selected in
`spec.access.role`. Each protected application route has a companion callback
route with an exact `/oauth2/callback/<route-name>` match on the shared local or
public dashboard host; both routes must be accepted by the same SecurityPolicy.
