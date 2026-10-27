import catalog from '../../../../../magic-cluster/apps/regression/diagnostics.json' with {type:'json'};
import {requireSafe} from './errors.ts';

// The same Git-owned catalog is served by the API and copied into the runner.
// It is never a browser-supplied expression, path or command.
export interface DiagnosticSelection {id:string;title:string;caseIds:string[];grep:string;phase:2|3|4;variants?:string[]}
requireSafe(catalog.version===2&&catalog.profiles.length>0&&catalog.profiles.length<=16&&
  new Set(catalog.profiles.map(p=>p.id)).size===catalog.profiles.length&&catalog.profiles.every(p=>
    [2,3,4].includes(p.phase)&&/^[a-z][a-z0-9-]{0,39}$/.test(p.id)&&p.caseIds.length>0&&
    p.caseIds.every(id=>/^[A-Z][A-Z0-9]+-\d{2}$/.test(id))&&p.grep===p.caseIds.join('|')&&
    (!('variants' in p)||Array.isArray(p.variants)&&p.variants.length>0&&
      new Set(p.variants).size===p.variants.length&&p.variants.every(v=>/^(?:p[234]-[a-z0-9-]+|external-route)$/.test(v)))),'CONFIG');
export const diagnosticSelections=catalog.profiles as DiagnosticSelection[];
export function diagnosticSelection(value:unknown,phases:number[],mode:string,operation='tests') {
  if(value===undefined)return;
  const selected=typeof value==='string'?diagnosticSelections.find(p=>p.id===value):undefined;
  requireSafe(selected&&operation==='tests'&&mode==='full'&&phases.length===1&&phases[0]===selected.phase,'CONFIG');
  return selected;
}
export const diagnosticMode=(selected:DiagnosticSelection)=>selected.phase===2?'phase2-models':selected.phase===3?
  selected.caseIds.every(id=>id==='HW-06')?'phase3-validation':'phase3-gpu':'phase4-sharing';
/** Preparation and recovery inherit the selection, but are never filtered by it. */
export function diagnosticForMode(mode?:string,value:unknown=process.env.REGRESSION_DIAGNOSTIC_SELECTION??
  (mode==='phase4-sharing'?process.env.REGRESSION_GPU_CASE||undefined:undefined)) {
  if(value===undefined)return;
  const profile=typeof value==='string'?diagnosticSelections.find(p=>p.id===value):undefined;
  requireSafe(profile,'CONFIG');
  return diagnosticMode(profile)===mode?diagnosticSelection(value,[profile.phase],process.env.REGRESSION_TEST_MODE??'full'):undefined;
}
export const diagnosticMetadata=(selected:typeof diagnosticSelections[number])=>
  ({id:selected.id,title:selected.title,caseIds:[...selected.caseIds],phase:selected.phase});
