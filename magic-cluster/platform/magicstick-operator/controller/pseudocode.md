# Magic Stick Operator Pseudocode

```text
for each Appliance:
  load module catalog from ai-system/magicstick-module-catalog
  normalize spec.modules keys to canonical module names
  desiredModules = enabled modules + catalog defaults

  for each enabled spec.instances entry:
    mapping = catalog.instanceMappings[type]
    if mapping is missing:
      record InstanceUnsupported condition
      continue
    add mapping.requiredModules to desiredModules
    mark auto-enabled modules in status

  for each desired module in dependency order:
    ensure required dependency modules are also desired
    create or patch Flux Kustomization in flux-system:
      name = module.kustomizationName
      path = "./" + module.path
      interval = "10m0s"
      prune = true
      sourceRef = appliance.spec.source
      dependsOn = module.requires.kustomizationName values
      postBuild = ai-appliance-settings when module.postBuildSubstitution

  for each previously generated module that is no longer desired:
    if module.uninstallPolicy == "keep-data":
      patch Flux Kustomization spec.suspend = true
    else:
      delete Flux Kustomization

  for each enabled instance:
    wait until every mapping.requiredCrds entry exists
    if any required CRD is missing:
      record WaitingForCRD status for the instance
      continue

    build specialized resource:
      openclaw -> openclaw.rocks/v1alpha1 OpenClawInstance
      hermes -> hermes.agent/v1 HermesInstance
      paperclip -> paperclip.inc/v1alpha1 Instance
      kubeopencode -> kubeopencode.io/v1alpha1 AgentTemplate and related resources

    create or patch the resource in instance.namespace
    set ownerReference to the Appliance when namespace matches
    set appliance.magicstick.dev labels

  update status.observedGeneration
  update status.modules from Flux Kustomization readiness
  update status.instances from specialized resource readiness where available
  set Ready condition true only when modules and enabled instances are ready
```

The MVP deliberately stops at this contract. A future implementation should
use a controller framework, typed clients for the `Appliance` API, and dynamic
clients for specialized resources that may not exist until their operators
install CRDs.
