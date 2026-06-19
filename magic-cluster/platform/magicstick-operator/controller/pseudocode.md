# Magic Stick Operator Pseudocode

```text
for each reconcile loop:
  read Appliance/local for source and aggregate status target
  load module catalog from ai-system/magicstick-module-catalog
  list ModuleActivation resources
  list AppInstance resources
  desiredModules = enabled ModuleActivation resources

  for each enabled AppInstance:
    mapping = catalog.instanceMappings[spec.type]
    if mapping is missing:
      record InstanceUnsupported condition
      continue
    create missing ModuleActivation resources for mapping.requiredModules

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

  for each disabled ModuleActivation:
    patch generated Flux Kustomization spec.suspend = true

  for each enabled AppInstance:
    wait until every mapping.requiredCrds entry exists
    if any required CRD is missing:
      record WaitingForCRD status for the instance
      continue

    build specialized resource:
      openclaw -> openclaw.rocks/v1alpha1 OpenClawInstance
      hermes -> hermes.agent/v1 HermesInstance
      paperclip -> paperclip.inc/v1alpha1 Instance
      kubeopencode -> kubeopencode.io/v1alpha1 AgentTemplate and related resources

    create or patch the resource in spec.targetNamespace
    set appliance.magicstick.dev labels

  update ModuleActivation status from Flux Kustomization readiness
  update AppInstance status from generated specialized resource state
  update Appliance/local status as an aggregate read model
```

The MVP is implemented as a dependency-free Python controller in a ConfigMap.
A future implementation should use a controller framework, typed clients for
the `Appliance` API, and dynamic clients for specialized resources that may not
exist until their operators install CRDs.
