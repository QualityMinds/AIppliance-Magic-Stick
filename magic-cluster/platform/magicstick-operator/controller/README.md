# Magic Stick Operator Controller

The live controller is packaged as Python code in
`../controller-configmap.yaml` and mounted into the
`magicstick-operator-controller` Deployment.

Application deployment templates live in
`../../../apps/instances/<application>` as Helm charts. Their dependencies and
chart paths are declared in `../app-catalog.yaml`; do not add application
manifest builders to the controller.

Run the embedded-controller unit tests with:

```sh
python3 -m unittest magic-cluster/platform/magicstick-operator/controller/test_controller.py
```

This directory is intentionally kept small. Public controller behavior is
documented in:

- [../../../../docs/operator-orchestration.md](../../../../docs/operator-orchestration.md)
- [../../../../docs/appliance-crd.md](../../../../docs/appliance-crd.md)
- [../../../../docs/modules.md](../../../../docs/modules.md)

Keep detailed behavior documentation in `docs/` so contributors have one
public source of truth.
