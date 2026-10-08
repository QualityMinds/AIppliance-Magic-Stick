import {test,expect} from '@playwright/test';
import {spawnSync} from 'node:child_process';
import {componentSuite,pythonSuite} from '../components/owning.ts';
import {evidenceAnnotations,type TestLayer} from '../core/evidence.ts';
import {phase3Variants,phase4Variants} from '../profiles/gpu-p0.ts';
import {freeTokenRegressionEnabled} from '../core/engine-policy.ts';

const phase = process.env.REGRESSION_MODE === 'phase4-fast' ? 4 : 3;
const definitions:Record<string,{id:string;layers:readonly TestLayer[]}> = phase === 3 ? phase3Variants : phase4Variants;
function proof(keys:string[],layer:'U'|'C') {
  return evidenceAnnotations(...keys.map(variant => ({id:definitions[variant]!.id,variant,layer})));
}
function title(keys:string[],description:string) {return [...new Set(keys.map(key => definitions[key]!.id))].join(' ')+' '+description;}
const api = '../../../magic-cluster/apps/dashboard';
const operator = '../../../magic-cluster/platform/magicstick-operator/controller';

if (phase === 3) {
  const hardware = ['p3-inventory','p3-mixed-vendor','p3-readiness','p3-validation-single','p3-identity'];
  test(title(hardware,'owning physical GPU view separates node identity, providers, readiness and explicit diagnostic scope'),proof(hardware,'U'), () =>
    componentSuite('src/pages/HardwarePage.test.tsx',[
      'separates node facts from one named accordion per physical GPU, not per sharing slot',
      'keeps NVIDIA memory and configuration independent from AMD shared memory',
      'verifies only a selected NVIDIA GPU and leaves AMD out of the request',
      'keeps explicit unknown driver and memory values unknown',
    ]));
  const memory = ['p3-memory-denominators','p3-memory-unknown','p3-unified-memory','p3-slot-ring','p3-pending-slot'];
  test(title(memory,'owning gauges distinguish slots, physical pools, live counters and budget reservations'),proof(memory,'U'), () =>
    componentSuite('src/ComputeMemory.test.tsx',[
      'adds a segmented model-slot ring without changing memory readings',
      'never substitutes another node or missing counters for the selected shared pool',
      'uses driver-bounded shared free rather than Linux free or unreserved budget',
    ]));
  const ft = ['p3-ft-capability','p3-ft-telemetry','p3-ft-whole-device','p3-ft-vram','p3-ft-ram','p3-ft-edit','p3-ft-lifecycle','p3-ft-discovery'];
  if(freeTokenRegressionEnabled)test(title(ft,'owning FreeToken form uses device-specific budgets, distinct settings, logs and lifecycle'),proof(ft,'U'), () =>
    componentSuite('src/FreeToken.test.tsx',[
      'searches Hugging Face with the FreeToken engine context and selects a compatible result',
      'uses the engine-specific configuration and excludes KV/offloading fields',
      'does not fall back to cluster-wide CPU capacity when selected-node RAM telemetry is unavailable',
      'does not substitute total VRAM when live FreeToken GPU capacity is explicitly zero',
      'edits only FreeToken runtime settings for a deployed FreeToken model',
      'restarts a running FreeToken model with its current revision',
    ]));
  test('ENG-03 owning GPU cache controls offer only compatible formats',proof(['p3-kv-controls'],'U'), () =>
    componentSuite('src/Offloading.test.tsx',['offers compatible cache formats and recalculates for the selected value']));
  test('LOG-01 owning runtime output remains bounded and inert',proof(['p3-gpu-logs'],'U'), () =>
    componentSuite('src/ModelLogs.test.tsx',['opens bounded current and previous Pod output for a local model']));

  const compatibility = ['p3-mixed-vendor','p3-readiness','p3-identity','p3-memory-denominators','p3-memory-unknown','p3-unified-memory'];
  test(title(compatibility,'owning API contracts fail closed on stale identity and retain unified allocation domains'),proof(compatibility,'C'), () =>
    pythonSuite(api,['test_gpu_compatibility_api.GPUCompatibilityApiTests','test_memory_telemetry.MemoryTelemetryTests']));
  const diagnostics = ['p3-inventory','p3-validation-single','p3-validation-all'];
  test(title(diagnostics,'owning API/controller bind manual validation to independent physical GPUs and runtime images'),proof(diagnostics,'C'), () => {
    pythonSuite(api,['test_gpu_device_validation_api.DeviceValidationApiTests']);
    pythonSuite(operator,['test_gpu_devices.PhysicalGpuTests']);
  });
  test('SLOT-01 SLOT-02 owning intent and runtime allocations share one slot without double counting',proof(['p3-slot-ring','p3-pending-slot'],'C'), () =>
    pythonSuite(api,['test_gpu_slots.GpuSlotsTests']));
  const engines = ['p3-amd-ollama','p3-amd-vllm','p3-nvidia-ollama','p3-nvidia-vllm','p3-kv-controls'];
  test(title(engines,'owning engine/target/cache contracts retain normal KubeAI runtimes'),proof(engines,'C'), () =>
    pythonSuite(api,[
      'test_dashboard_api.LocalRuntimeTests.test_nvidia_requires_enabled_module_and_allocatable_gpu',
      'test_dashboard_api.LocalRuntimeTests.test_amd_and_intel_targets_require_vendor_resources_and_resolve_profile',
      'test_dashboard_api.LocalRuntimeTests.test_local_model_payload_is_compute_target_aware_and_sanitized',
      'test_dashboard_api.LocalRuntimeTests.test_incompatible_cache_type_is_rejected_against_target_contract',
      'test_dashboard_api.LocalRuntimeTests.test_gpu_model_payload_drops_cpu_memory_reservation',
    ]));
  const ftContracts = [...ft,'p3-ft-runtime'];
  if(freeTokenRegressionEnabled)test(title(ftContracts,'owning FreeToken admission, CUDA/whole-device entrypoint, health and lifecycle contracts'),proof(ftContracts,'C'), () => {
    pythonSuite(api,['test_freetoken_api.FreeTokenDashboardApiTests','test_freetoken_lifecycle.FreeTokenLifecycleTests']);
    pythonSuite(operator,['test_freetoken_runtime.FreeTokenRuntimeTests']);
  });
  test('LOG-01 owning API log resolver uses current model UID and authorized Pods',proof(['p3-gpu-logs'],'C'), () =>
    pythonSuite(api,['test_model_logs.ModelLogsTests']));
} else {
  const recovery=(titles:string[])=>{
    const result=spawnSync('/opt/magicstick/regression-runtime/amd-recovery.test',[
      '-test.v','-test.run',`^(${titles.join('|')})$`],{timeout:60_000,encoding:'utf8',maxBuffer:1024*1024,
      env:{...process.env,MAGICSTICK_TEST_LIVE_DISCOVERY:''}});
    const output=`${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    expect(result.error).toBeUndefined();expect(result.status,output).toBe(0);
    for(const name of titles) expect(output).toContain(`--- PASS: ${name}`);
    expect(output).not.toContain('--- SKIP:');
  };
  test('BOOT-04 owning AMD identity and volatile CDI recover against current physical mapping in isolated directories',{
    annotation:[...proof(['p4-cdi-identity'],'U').annotation,...proof(['p4-cdi-identity'],'C').annotation]},()=>recovery([
      'TestStableIdentitySurvivesMixedHostDRMRenumbering','TestHardwareIdentityFitsResourceSliceAttributeLimit']));
  test('BOOT-05 owning stale and malformed checkpoint recovery quarantines claims without preventing cleanup',{
    annotation:[...proof(['p4-stale-checkpoint'],'U').annotation,...proof(['p4-stale-checkpoint'],'C').annotation]},()=>recovery([
      'TestLegacyCheckpointQuarantinesWithoutPreventingCleanup','TestKnownMissingOrReplacedHardwareNeverRemaps',
      'TestMalformedClaimsAndDeviceFailureStayRecoverable','TestMultipleConsumersAreNotGarbageCollectedByPlugin',
      'TestChangedSysfsMappingRejectsPrepareAndQuarantinesRecovery']));
  const forms = ['p4-defaults','p4-dirty-confirmation','p4-rbac-admission','p4-provider-independence','p4-invalid-intent','p4-custom-config','p4-dra-unavailable'];
  test(title(forms,'owning sharing forms default exclusive, preserve provider drafts and require final confirmation'),proof(forms,'U'), () =>
    componentSuite('src/pages/GpuSharingControls.test.tsx',[
      'uses the restart confirmation instead of an additional sharing checkbox',
      'manages NVIDIA independently beside AMD on a mixed node',
      'disables invalid slot limits and unchanged managed settings',
      'keeps explanations in an info popover and unsupported DRA disabled',
    ]));
  const slots = ['p4-full','p4-draft-refresh','p4-release','p4-edit-own-slot'];
  test(title(slots,'owning model form preserves drafts across slot exhaustion and subsequent release'),proof(slots,'U'), () =>
    componentSuite('src/ModelSlots.test.tsx',[
      'keeps a full GPU visible but disabled, even with free memory',
      'disables submission if the selected GPU fills while keeping the form and selection',
    ]));
  const slotAlgorithms = ['p4-other-consumers','p4-last-slot-race'];
  test(title(slotAlgorithms,'owning slot-accounting units count intent, external, init and terminating consumers conservatively'),proof(slotAlgorithms,'U'), () =>
    pythonSuite(api,['test_gpu_slots.GpuSlotsTests']));
  const sharing = ['p4-defaults','p4-nvidia-transition','p4-amd-transition','p4-rbac-admission','p4-provider-independence',
    'p4-invalid-intent','p4-custom-config','p4-dra-unavailable','p4-restoration'];
  test(title(sharing,'owning sharing API/controller contracts enforce RBAC, identity, drain ordering and custom-profile boundaries'),proof(sharing,'C'), () => {
    pythonSuite(api,['test_gpu_sharing_api.GpuSharingApiTests']);
    pythonSuite(operator,['test_gpu_sharing.GpuSharingTests','test_nvidia_gpu_sharing.NvidiaGpuSharingTests']);
  });
  const accounting = ['p4-other-consumers','p4-full','p4-release','p4-edit-own-slot','p4-last-slot-race'];
  test(title(accounting,'owning admission contracts reject exhausted capacity, reuse only an activation’s slot and bound scheduler admission'),proof(accounting,'C'), () =>
    pythonSuite(api,['test_gpu_slots.GpuSlotsTests']));
}
