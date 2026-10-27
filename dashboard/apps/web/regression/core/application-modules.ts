import type {ModulesPayload} from '@magicstick/dashboard-contracts';
import {requireSafe} from './errors.ts';
import {applicationRegressionEnabled,liveWorkflowEnabled} from './engine-policy.ts';

export const protectedModule=(id:string)=>/^(?:identity|dashboard|basis|kubeai|gpu|amd-gpu|nvidia-gpu|intel-gpu|litellm|private-mesh|model-catalog|magicstick-operator|regression)$/.test(id);
export function applicationModuleIds(modules:ModulesPayload,types:string[]):string[] {
  const ids=new Set<string>();
  for(const type of types) {
    const definition=modules.catalogJson?.applications?.[type];requireSafe(definition?.requiredModules,'PREREQUISITE');
    for(const id of definition.requiredModules) {
      requireSafe(/^[a-z0-9-]{1,63}$/.test(id)&&modules.catalogJson?.modules?.[id],'CONFIG');ids.add(id);
    }
  }
  return [...ids].sort();
}
/** Effective setup selection, including retained pre-exclusion input profiles.
 * Do not even resolve dependencies for a deferred workflow. Pending old setup
 * receipts are reconciled separately, never treated as permission for new work. */
export function fixtureModuleIds(modules:ModulesPayload,profile:{modules?:{id?:string};applications?:{fixtures?:Array<{type:string}>}}):string[] {
  const service=liveWorkflowEnabled('modules')&&profile.modules?.id?[profile.modules.id]:[];
  const types=liveWorkflowEnabled('applications')?(profile.applications?.fixtures??[]).map(f=>f.type).filter(applicationRegressionEnabled):[];
  return [...new Set([...service,...applicationModuleIds(modules,types)])];
}
