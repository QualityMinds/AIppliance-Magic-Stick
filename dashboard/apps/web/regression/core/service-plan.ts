import type {ModulesPayload} from '@magicstick/dashboard-contracts';
import {serviceMatrix,servicesRequirements,requireServiceMatrix,type ServiceMatrix,type ReviewedServiceCapabilities} from './service-matrix.ts';
import {serviceRegressionEnabled} from './service-selection.ts';
import {readPrivate} from './private-files.ts';
import {requireSafe} from './errors.ts';

/** Review adapters, not a parallel inventory. Future catalog additions remain
 * present with blocked capabilities until their native contract is reviewed. */
export function automaticServiceMatrix(payload:ModulesPayload):ServiceMatrix {
  const inventory=serviceMatrix(payload),reviewed:ReviewedServiceCapabilities={};
  const providers=new Set(Object.values(payload.catalogJson?.applications??{}).flatMap(app=>app.requiredModules??[]));
  for(const entry of inventory.entries) {
    if(entry.kind==='module')reviewed['module:'+entry.id]={installation:{state:'supported'},
      ...(providers.has(entry.id)?{access:{state:'not-applicable',code:'INSTANCE_PROVIDER'}}:
        entry.id==='anything-llm'?{access:{state:'supported'}}:{})};
    else if(['openclaw','paperclip','kubeopencode','pi-coding','odysseus'].includes(entry.id))
      reviewed['application:'+entry.id]={installation:{state:'supported'},access:{state:'supported'}};
  }
  return serviceMatrix(payload,reviewed);
}
export interface ServicePlan {version:1;catalog:NonNullable<ModulesPayload['catalogJson']>;matrix:ServiceMatrix;modules:Array<{approveOptionalModule:true;id:string;parameters:Record<string,string>}>}
export async function loadServicePlan():Promise<ServicePlan> {
  requireSafe(serviceRegressionEnabled()&&process.env.REGRESSION_REMAINING_PROFILE,'CONFIG');
  const profile=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE)),plan=profile.services as ServicePlan;
  requireSafe(plan?.version===1&&Array.isArray(plan.modules)&&plan.matrix?.version===1&&plan.catalog?.modules&&plan.catalog.applications,'CONFIG');
  // The accepted catalog snapshot is separate from selection metadata. Rebuild
  // reviewed capabilities here so a saved plan cannot authorize its own adapter
  // or omit Pi/new entries. Live execution checks the fresh catalog again.
  requireServiceMatrix(plan.matrix,automaticServiceMatrix({modules:{},catalogJson:plan.catalog}));
  servicesRequirements(plan.matrix);
  requireSafe(plan.modules.length===plan.matrix.entries.filter(entry=>entry.kind==='module').length&&
    new Set(plan.modules.map(item=>item.id)).size===plan.modules.length&&plan.modules.every(item=>item.approveOptionalModule===true&&
      plan.matrix.entries.some(entry=>entry.kind==='module'&&entry.id===item.id)&&item.parameters&&
      Object.entries(item.parameters).every(([key,value])=>/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)&&typeof value==='string'&&value.length<128)),'CONFIG');
  return plan;
}
