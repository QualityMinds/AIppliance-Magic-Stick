import {test, expect} from '@playwright/test';
import {evidenceAnnotations} from '../core/evidence.ts';
import {pythonSuite} from '../components/owning.ts';
import {recordedApi} from '../fixtures/api-client.ts';

const dashboard = '../../../magic-cluster/apps/dashboard';
const controller = '../../../magic-cluster/platform/magicstick-operator/controller';

test('DISC-01 LIFE-02 shared client keeps local and external create contracts distinct', evidenceAnnotations(
  {id: 'DISC-01', variant: 'create-choice-contract', layer: 'C'},
  {id: 'LIFE-02', variant: 'local-create-contract', layer: 'C'}), async () => {
  const local = {name: 'fixture-ollama', enabled: true, targetNamespace: 'ai', local: {
    engine: 'OLlama', computeTarget: 'cpu', url: 'ollama://fixture:latest', modelType: 'chat',
    contextWindow: 2048, maxNumSeqs: 1, kvCacheType: 'f16', memoryRequiredMi: 3072,
  }};
  const external = {name: 'fixture-external', enabled: true, targetNamespace: 'ai', external: {
    model: 'provider/fixture', apiBase: 'https://provider.invalid/v1', modelType: 'chat', contextWindow: 4096,
  }};
  const first = recordedApi({metadata: {name: local.name}}); await first.api.createLocalModel(local);
  expect(first.requests).toHaveLength(1); expect(first.requests[0]?.path).toBe('/api/models/local');
  expect(JSON.parse(String(first.requests[0]?.init.body))).toEqual(local);
  const second = recordedApi({metadata: {name: external.name}}); await second.api.createExternalModel(external);
  expect(second.requests).toHaveLength(1); expect(second.requests[0]?.path).toBe('/api/models/external');
  expect(JSON.parse(String(second.requests[0]?.init.body))).toEqual(external);
});

test('DISC-03 DISC-04 backend discovery normalizes pagination and enforces direct artifact policy', evidenceAnnotations(
  {id: 'DISC-03', variant: 'hf-search-contract', layer: 'C'},
  {id: 'DISC-04', variant: 'hf-policy-contract', layer: 'C'}), () => pythonSuite(dashboard, [
  'test_dashboard_api.HuggingFaceDiscoveryTests.test_search_normalizes_query_filters_private_models_and_paginates',
  'test_dashboard_api.HuggingFaceDiscoveryTests.test_search_applies_metadata_filters_and_engine_compatibility',
  'test_dashboard_api.HuggingFaceDiscoveryTests.test_artifacts_include_only_direct_quantized_base_model_relations',
]));

test('LIFE-07 LIFE-09 LIFE-13 edit contract preserves identity and rejects stale concurrent intent', evidenceAnnotations(
  {id: 'LIFE-07', variant: 'edit-contract', layer: 'C'},
  {id: 'LIFE-09', variant: 'conflict-contract', layer: 'C'},
  {id: 'LIFE-13', variant: 'persistence-contract', layer: 'C'}), () => pythonSuite(dashboard, [
  'test_model_update.ModelUpdateTests.test_local_update_is_revision_bound_and_preserves_identity',
  'test_model_update.ModelUpdateTests.test_generation_revision_accepts_status_updates_but_rejects_spec_or_identity_changes',
  'test_model_update.ModelUpdateTests.test_status_only_patch_conflict_retries_once_with_fresh_atomic_revision',
  'test_model_update.ModelUpdateTests.test_patch_conflict_never_retries_a_concurrent_spec_edit',
  'test_vllm_deployment.VllmDeploymentApiTests.test_edit_preserves_configuration_and_explicit_auto_resets_the_choice',
]));

test('ENG-01 ENG-03 ENG-09 ENG-10 server admission is engine-specific, compatible and fail-closed', evidenceAnnotations(
  {id: 'ENG-01', variant: 'engine-create-contract', layer: 'C'},
  {id: 'ENG-03', variant: 'kv-contract', layer: 'C'},
  {id: 'ENG-09', variant: 'legacy-default-contract', layer: 'C'},
  {id: 'ENG-10', variant: 'injection-contract', layer: 'C'}), () => pythonSuite(dashboard, [
  'test_dashboard_api.LocalRuntimeTests.test_local_model_payload_is_compute_target_aware_and_sanitized',
  'test_dashboard_api.LocalRuntimeTests.test_cpu_vllm_payload_derives_cache_server_side_and_enforces_minimum',
  'test_dashboard_api.LocalRuntimeTests.test_incompatible_cache_type_is_rejected_against_target_contract',
  'test_dashboard_api.LocalRuntimeTests.test_unknown_local_engine_is_rejected',
  'test_vllm_deployment.VllmDeploymentApiTests.test_legacy_creation_does_not_add_a_deployment_override',
  'test_vllm_deployment.VllmDeploymentApiTests.test_validation_is_engine_and_target_specific_and_fail_closed',
]));

test('ENG-02 Ollama alias blocks publication until the downloaded source is callable by activation name', evidenceAnnotations(
  {id: 'ENG-02', variant: 'ollama-alias-contract', layer: 'C'}), () => pythonSuite(controller, [
  'test_controller.HelmAppInstanceTests.test_ollama_alias_is_created_after_source_download_finishes',
  'test_controller.HelmAppInstanceTests.test_ollama_model_stays_starting_until_runtime_alias_is_available',
]));

test('LIFE-11 LIFE-12 controller reports bounded Pod creation stalls and terminal failure recovery', evidenceAnnotations(
  {id: 'LIFE-11', variant: 'pod-stall-contract', layer: 'C'},
  {id: 'LIFE-12', variant: 'failure-stage-contract', layer: 'C'}), () => pythonSuite(controller, [
  'test_model_pod_status.ModelPodStatusTests.test_missing_pod_becomes_degraded_after_two_minutes_and_keeps_timer',
  'test_model_pod_status.ModelPodStatusTests.test_terminal_owned_pod_is_replaced_with_identity_preconditions_and_failure_detail',
  'test_model_pod_status.ModelPodStatusTests.test_recovery_backoff_and_max_attempts_survive_reconciliation',
]));

test('MEM-01 MEM-05 memory estimates expose their terms and risk remains explicit', evidenceAnnotations(
  {id: 'MEM-01', variant: 'memory-contract', layer: 'C'},
  {id: 'MEM-05', variant: 'risk-contract', layer: 'C'}), () => pythonSuite(dashboard, [
  'test_memory_calculations.MemoryCalculationTests.test_all_ollama_targets_explain_reserves_totals_and_download',
  'test_memory_calculations.MemoryCalculationTests.test_all_vllm_targets_and_cpu_hybrid_safety',
  'test_cpu_offloading.CpuOffloadingTests.test_explicit_memory_risk_acceptance_preserves_small_and_unverifiable_budgets',
  'test_cpu_offloading.CpuOffloadingTests.test_risk_acceptance_does_not_bypass_invalid_values_or_replica_limits',
]));

test('MEM-07 MEM-10 shared-memory arithmetic uses host counters once and preserves allocation domains', evidenceAnnotations(
  {id: 'MEM-07', variant: 'shared-free-contract', layer: 'C'},
  {id: 'MEM-10', variant: 'accounting-contract', layer: 'C'}), () => pythonSuite(dashboard, [
  'test_memory_telemetry.MemoryTelemetryTests.test_38_2_gib_available_and_78_7_gib_used_leave_29_3_gib_shared_free',
  'test_gpu_compatibility_api.GPUCompatibilityApiTests.test_fixed_pool_one_gpu_and_no_double_host_charge',
  'test_gpu_compatibility_api.GPUCompatibilityApiTests.test_linux_capped_shared_capacity_below_fixed_reservation_keeps_budget',
]));

test('ROUTE-02 local publication waits for both runtime readiness and generated catalog presence', evidenceAnnotations(
  {id: 'ROUTE-02', variant: 'catalog-contract', layer: 'C'}), () => pythonSuite(controller, [
  'test_controller.HelmAppInstanceTests.test_local_model_is_ready_only_after_kubeai_and_catalog_are_ready',
]));

test('ROUTE-05 external update and stop preserve the provider configuration and credential reference', evidenceAnnotations(
  {id: 'ROUTE-05', variant: 'external-contract', layer: 'C'}), () => {
  pythonSuite(dashboard, [
    'test_model_update.ModelUpdateTests.test_external_update_keeps_the_existing_secret',
    'test_model_update.ModelUpdateTests.test_external_key_replacement_switches_revision_bound_secret',
  ]);
  pythonSuite(controller, [
    'test_model_lifecycle.ModelLifecycleTests.test_external_stop_preserves_provider_configuration_and_does_not_delete_a_local_runtime',
  ]);
});

test('LOG-01 LOG-04 backend resolves bounded current, previous and init output from owned Pods only', evidenceAnnotations(
  {id: 'LOG-01', variant: 'log-stage-contract', layer: 'C'},
  {id: 'LOG-04', variant: 'pod-log-selection-contract', layer: 'C'}), () => pythonSuite(dashboard, [
  'test_model_logs.ModelLogsTests.test_logs_are_resolved_from_the_local_activation_and_owned_pods',
  'test_model_logs.ModelLogsTests.test_tail_is_bounded_and_missing_output_does_not_fail_the_dialog',
]));


test('DISC-01 server resolves automatic model tasks and rejects unknown tasks before saving', evidenceAnnotations(
  {id: 'DISC-01', variant: 'model-task-contract', layer: 'C'}), () => pythonSuite(dashboard, ['test_model_tasks.ModelTaskTests']));
