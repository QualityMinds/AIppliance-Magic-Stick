import type {HostOperationRequest,ManagedHost} from '@magicstick/dashboard-contracts';
import type {LabConfig} from './config.ts';
import type {HostDrill} from './host-drill.ts';
import {requireSafe} from './errors.ts';
import {hostDrillIds} from '../profiles/remaining-p0.ts';

export interface HostDrillRecipes {
  version:2; applianceUid:string; nodeUid:string; nodeName:string;
  approveDestructive:true; independentRecoveryAvailable:true;
  cases:Record<string,{recipe:Partial<HostOperationRequest>;expected:HostDrill['expected']}>;
}
export function recipeBundle(value:unknown,applianceUid:string,nodeUid:string):HostDrillRecipes {
  const plan=value as HostDrillRecipes;
  requireSafe(plan?.version === 2 && plan.applianceUid === applianceUid && plan.nodeUid === nodeUid &&
    plan.approveDestructive === true && plan.independentRecoveryAvailable === true &&
    typeof plan.nodeName === 'string' && plan.cases && typeof plan.cases === 'object' && !Array.isArray(plan.cases) &&
    Object.keys(plan.cases).every(id=>hostDrillIds.includes(id)),'PREREQUISITE');
  for(const [id,item] of Object.entries(plan.cases)) {
    requireSafe(item?.recipe && item.expected && Object.keys(item).sort().join(',') === 'expected,recipe' &&
      Object.keys(item.recipe).every(key=>['action','allowExperimental','experimentMode','gpuMemory','network','updatePolicy','updateScope','softwareChannel'].includes(key)) &&
      !/"(?:command|path|password|packages|repository|script)"\s*:/.test(JSON.stringify(item)) && JSON.stringify(item).length < 8192 &&
      typeof item.expected.kernel === 'string' && ['Succeeded','Failed','Interrupted','RolledBack'].includes(item.expected.terminal) &&
      [0,1,2].includes(item.expected.bootChanges),'CONFIG');
    requireSafe(Object.keys(item.expected).every(key=>['bootChanges','kernel','dynamicLimitMi','carveoutMi','ipv4','sourceCommit','freeCacheIds','terminal','images'].includes(key)),'CONFIG');
    const action=id.startsWith('BOOT-') ? 'reboot' : id.startsWith('GPUHOST-') ? 'configure-gpu-memory' :
      id.startsWith('HOST-') ? 'prepare-gpu' : id.startsWith('NET-') ? 'configure-network' :
      id.startsWith('CHANNEL-') ? 'apply-software-channel' : id.startsWith('CACHE-') ? 'clear-model-cache' : id === 'UPD-05' ? 'install-updates' : 'configure-updates';
    requireSafe(item.recipe.action === action && typeof item.recipe.allowExperimental === 'boolean' && typeof item.recipe.experimentMode === 'boolean','CONFIG');
    if(action === 'configure-gpu-memory')requireSafe(!item.recipe.experimentMode,'CONFIG');
    else if(action !== 'prepare-gpu')requireSafe(!item.recipe.allowExperimental && !item.recipe.experimentMode,'CONFIG');
  }
  return plan;
}

/** Compile one saved, explicitly approved test recipe from current product
 * evidence. Never inherit a new physical identity or an unexplained reboot. */
export function materializeHostDrill(value:unknown,id:string,host:ManagedHost,lab:LabConfig):HostDrill {
  const plan=recipeBundle(value,lab.expected.applianceUid,host.nodeUid);
  const selected=plan.cases[id];requireSafe(selected && host.name === plan.nodeName && host.available &&
    lab.expected.nodes.some(node=>node.uid === host.nodeUid && node.name === host.name && node.bootId === host.bootId),'IDENTITY');
  const recipe=structuredClone(selected.recipe);
  const request={...recipe,nodeName:host.name,nodeUid:host.nodeUid,bootId:host.bootId,confirmation:host.name,
    requestId:'',acknowledgeDisruption:true} as HostOperationRequest;
  switch(request.action) {
    case 'prepare-gpu': request.planId=(request.experimentMode ? host.plan?.experiment : host.plan)?.id;break;
    case 'configure-gpu-memory':request.planId=host.gpuMemory?.id;break;
    case 'configure-network':request.planId=host.network?.id;break;
    case 'install-updates':case 'configure-updates':request.planId=host.updates?.id;break;
    case 'clear-model-cache':request.planId=host.modelCache?.id;break;
    case 'apply-software-channel':request.planId=host.software?.id;request.softwarePreviewId=host.software?.preview?.id;break;
  }
  if(request.action !== 'reboot')requireSafe(/^[a-f0-9]{64}$/.test(request.planId ?? ''),'HOST');
  return {caseId:id,acknowledgeDisruption:true,independentRecoveryAvailable:true,request,expected:structuredClone(selected.expected)};
}
