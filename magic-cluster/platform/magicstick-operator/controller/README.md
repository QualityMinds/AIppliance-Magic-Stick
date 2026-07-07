# Magic Stick Operator Controller

The live controller is packaged as Python code in
`../controller-configmap.yaml` and mounted into the
`magicstick-operator-controller` Deployment.

This directory is intentionally kept small. Public controller behavior is
documented in:

- [../../../../docs/operator-orchestration.md](../../../../docs/operator-orchestration.md)
- [../../../../docs/appliance-crd.md](../../../../docs/appliance-crd.md)
- [../../../../docs/modules.md](../../../../docs/modules.md)

Keep detailed behavior documentation in `docs/` so contributors have one
public source of truth.
