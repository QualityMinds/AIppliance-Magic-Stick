import type {ModulesPayload} from '@magicstick/dashboard-contracts';
import {requireSafe} from './errors.ts';

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
