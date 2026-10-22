import catalog from '../../../../../magic-cluster/apps/regression/diagnostics.json' with {type:'json'};
import {requireSafe} from './errors.ts';

// The same Git-owned catalog is served by the API and copied into the runner.
// It is never a browser-supplied expression, path or command.
requireSafe(catalog.version===1&&catalog.profiles.length>0&&catalog.profiles.length<=16,'CONFIG');
export const diagnosticSelections=catalog.profiles;
export function diagnosticSelection(value:unknown,phases:number[],mode:string,operation='tests') {
  if(value===undefined)return;
  const selected=typeof value==='string'?diagnosticSelections.find(p=>p.id===value):undefined;
  requireSafe(selected&&operation==='tests'&&mode==='full'&&phases.length===1&&phases[0]===4,'CONFIG');
  return selected;
}
export const diagnosticMetadata=(selected:typeof diagnosticSelections[number])=>
  ({id:selected.id,title:selected.title,caseIds:[...selected.caseIds]});
