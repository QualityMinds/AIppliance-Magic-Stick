import {test} from '@playwright/test';
import {componentSuite,pythonSuite} from '../components/owning.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {remainingPhase,remainingVariants,remainingVariantEnabled,validateRemainingRegistry} from '../profiles/remaining-p0.ts';
import {HarnessError} from '../core/errors.ts';
import {freeTokenRegressionEnabled} from '../core/engine-policy.ts';

const api='../../../magic-cluster/apps/dashboard';
const identity='../../../magic-cluster/platform/identity/tests';
const operator='../../../magic-cluster/platform/magicstick-operator/controller';
const host='../../../magic-host/roles/host-management/tests';
const mesh='../../../magic-cluster/apps/ai/private-mesh';
type Proof={python?:Array<[string,string[]]>; components?:Array<[string,string[]]>};
/** Owning suites run once; each case retains separate catalogue/layer evidence. */
const proofs:Record<string,Proof>={
  modules:{python:[[operator,['test_controller.HelmAppInstanceTests.test_waiting_module_suspends_kustomization_without_deleting_resources',
    'test_controller.HelmAppInstanceTests.test_model_module_dependencies_separate_local_and_external_models']],
    [api,['test_module_parameters.ModuleParameterTests','test_gpu_sharing_api.GpuSharingApiTests']]],components:[['src/FeatureParity.test.tsx',['Services restores grouping, nested instances, credentials and every Paperclip field']]]},
  apps:{python:[[operator,['test_controller.HelmAppInstanceTests.test_generates_helmrelease_from_app_definition',
    'test_controller.HelmAppInstanceTests.test_generates_sso_protected_local_and_public_routes_by_default',
    'test_controller.HelmAppInstanceTests.test_paperclip_tenant_runtime_resources_are_instance_scoped',
    'test_controller.HelmAppInstanceTests.test_guard_is_bound_to_instance_uid_and_checks_before_backend_is_exposed']],
    ['../../../magic-cluster/apps/ai/model-catalog',['test_controller.OpenCodeModelLimitTests','test_controller.OpenClawCatalogTests']]],
    components:[['src/FeatureParity.test.tsx',['Services restores grouping, nested instances, credentials and every Paperclip field']]]},
  credentials:{python:[[api,['test_dashboard_api.ModuleCredentialTests']]],components:[['src/FeatureParity.test.tsx',['Services restores grouping, nested instances, credentials and every Paperclip field']]]},
  access:{python:[['../api',['test_instance_access.SharingTests']],
    [operator,['test_controller.HelmAppInstanceTests.test_sharing_reconciliation_has_no_license_probe',
      'test_controller.HelmAppInstanceTests.test_explicit_public_local_instance_keeps_guard_but_omits_oidc']]],components:[['src/InstanceSharing.test.tsx',[]]]},
  users:{python:[[api,['test_dashboard_api.UserAdministrationTests']]],components:[['src/FeatureParity.test.tsx',['Users restores filters, pagination, roles and safe user dialogs']]]},
  kubernetes:{python:[[api,['test_dashboard_api.KubernetesAccessTests']],[identity,['test_user_admin_identity.UserAdminIdentityTests']]],
    components:[['src/FeatureParity.test.tsx',['Kubernetes Access restores level guidance, OIDC readiness and edit/export actions']]]},
  licensing:{python:[['../api',['test_licensing.LicenseTests']],[api,['test_license_api.LicenseHttpTests']]],components:[['src/LicensePage.test.tsx',[]]]},
  federation:{python:[['../api',['test_federated_sso.FederatedSsoPolicyTests','test_federated_sso.FederatedSsoLifecycleTests','test_federated_sso.FederatedSsoHttpTests']],
    [identity,['test_federation_license_route.FederationRouteTests']]],components:[['src/FederatedSsoPage.test.tsx',[]]]},
  authentication:{python:[[api,['test_dashboard_api.UserAdministrationTests.test_admin_access_is_rejected_for_viewer_and_operator',
    'test_dashboard_api.UserAdministrationTests.test_live_actor_recheck_rejects_demoted_admin',
    'test_dashboard_api.UserAdministrationTests.test_request_body_is_limited_and_requires_json',
    'test_dashboard_api.UserAdministrationTests.test_mutations_require_csrf_header_and_same_origin']],
    ['../api',['test_federated_sso.FederatedSsoHttpTests']]],components:[['src/InstanceSharing.test.tsx',[]]]},
  keys:{python:[[api,['test_dashboard_api.ApiAccessManagementTests']]],components:[['src/pages/ApiAccessPage.test.tsx',[]]]},
  logs:{python:[[api,['test_model_logs.ModelLogsTests']]]},
  host:{python:[[api,['test_host_management_api.HostManagementApiTests','test_host_management_api.HostStatusTests','test_host_management_api.HostRbacTests']],
    [host,['test_host_management.PlanTests','test_host_management.RequestTests','test_host_management.WorkerTests']]],components:[['src/pages/HostManagement.test.tsx',[]]]},
  'gpu-host':{python:[[api,['test_host_management_api.GpuMemoryApiTests']],
    [host,['test_gpu_memory.MemoryEvidenceTests','test_gpu_memory.MemoryRequestTests','test_gpu_memory.MemoryWorkerTests']]],components:[['src/pages/HostGpuMemory.test.tsx',[]]]},
  network:{python:[[api,['test_network_api.NetworkApiTests']],
    [host,['test_network.NetworkContractTests','test_network.NetplanTests','test_network.NetworkRollbackTests','test_network.NetworkWorkerTests']]],components:[['src/pages/NetworkPage.test.tsx',[]]]},
  updates:{python:[[api,['test_updates_api.UpdatesApiTests']],
    [host,['test_updates.ContractTests','test_updates.ExecutionTests','test_updates.PackageTests','test_updates.WorkerTests']]],components:[['src/pages/UpdatesPage.test.tsx',[]]]},
  channel:{python:[[api,['test_software_channel_api.SoftwareChannelApiTests']],
    [host,['test_software_channel.ContractTests','test_software_channel.HostTests']]],components:[['src/pages/SoftwareChannelEditor.test.tsx',[]]]},
  cache:{python:[[api,['test_model_cache_api.ModelCacheApiTests']],
    [host,['test_model_cache.ModelCacheTests']], [operator,['test_model_cache.ModelCacheGateTests','test_freetoken_runtime.FreeTokenRuntimeTests']]],components:[['src/pages/ModelCachePage.test.tsx',[]]]},
  boot:{python:[[host,['test_host_management.WorkerTests','test_gpu_memory.MemoryWorkerTests']],
    ['../../../magic-host/roles/k3s/tests',['test_role']], ['../../../magic-host/roles/nvidia-display/tests',['test_role']],
    [identity,['test_nginx_workers.NginxWorkerContractTests']]]},
  mesh:{python:[[api,['test_private_mesh_api.PrivateMeshApiTests']],
    [mesh,['test_mesh.MeshTests','test_mesh_core.MeshCoreTests']]],components:[['src/pages/MeshPage.test.tsx',[]]]},
  companion:{python:[[mesh,['test_desktop.DesktopBoundaryTests','test_desktop.RuntimeLifecycleTests',
    'test_desktop.NativeEnvironmentTests','test_desktop.FrozenLaunchCheckTests','test_build_companion.CompanionPackagingTests',
    'test_archive_companion.CompanionArchiveTests']]]},
  realtime:{python:[[api,['test_realtime_api.RealtimeApiTests']],[operator,['test_realtime_runtime.RealtimeRuntimeTests']]],
    components:[['src/RealtimeModelForm.test.tsx',[]]]},
  security:{python:[[api,['test_dashboard_api.UserAdministrationTests','test_model_logs.ModelLogsTests',
    'test_dashboard_api.HuggingFaceDiscoveryTests.test_fetcher_allows_only_bounded_huggingface_model_api_responses',
    'test_dashboard_api.OllamaDiscoveryTests.test_ollama_fetcher_is_host_pinned_redirect_safe_and_bounded']],
    ['../api',['test_instance_access.SharingTests','test_federated_sso.FederatedSsoPolicyTests']],
    [identity,['test_user_admin_identity.UserAdminIdentityTests']]],components:[['src/ModelLogs.test.tsx',[]],['src/InstanceSharing.test.tsx',[]]]},
  'supply-chain':{python:[['../../../tests',['test_release.ReleaseTests','test_runtime_image_updates.RuntimeImageTests','test_license_release.ReleaseMetadataTests','test_license_ci','test_regression_security','test_regression_launcher','test_regression_inputs']]],components:[['src/CoreSafety.test.ts',[]]]},
  forms:{components:[['src/pages/GpuSharingControls.test.tsx',[]],['src/pages/SoftwareChannelEditor.test.tsx',[]],
    ['src/pages/HostGpuMemory.test.tsx',[]],['src/pages/NetworkPage.test.tsx',[]],['src/pages/UpdatesPage.test.tsx',[]],
    ['src/pages/SettingsPage.test.tsx',[]],['src/pages/MeshPage.test.tsx',[]],['src/FreeToken.test.tsx',[]],['src/RealtimeModelForm.test.tsx',[]]]},
  repeat:{python:[[operator,['test_model_lifecycle.ModelLifecycleTests','test_freetoken_runtime.FreeTokenRuntimeTests',
    'test_realtime_runtime.RealtimeRuntimeTests']], [api,['test_model_update.ModelUpdateTests']]]},
};
const cache=new Map<string,Promise<void>>();
function execute(group:string) {
  let result=cache.get(group);
  if(!result) {
    result=(async()=>{
      const proof=proofs[group]; if(!proof) throw new HarnessError('CONFIG');
      for(const [cwd,tests] of proof.python ?? []) {
        const selected=tests.filter(name=>freeTokenRegressionEnabled || !name.startsWith('test_freetoken_'));
        if(selected.length)pythonSuite(cwd,selected);
      }
      for(const [file,titles] of proof.components ?? [])if(freeTokenRegressionEnabled || file !== 'src/FreeToken.test.tsx')
        await componentSuite(file,titles);
    })(); cache.set(group,result);
  }
  return result;
}
validateRemainingRegistry();
const phase=remainingPhase(process.env.REGRESSION_MODE);
for(const group of new Set(Object.values(remainingVariants).filter(item=>remainingVariantEnabled(item) && item.phase === phase && item.layers.some(layer=>['U','C'].includes(layer))).map(item=>item.group))) {
  const cases=Object.entries(remainingVariants).filter(([,item])=>remainingVariantEnabled(item) && item.phase === phase && item.group === group);
  test(`${cases[0]![1].id} owning ${group} safety and behavior contracts`,
    evidenceAnnotations(...cases.flatMap(([variant,item])=>item.layers.filter(layer=>layer === 'U' || layer === 'C').map(layer=>({id:item.id,variant,layer})))),()=>execute(group));
}
