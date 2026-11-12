import type {ModulesPayload} from '@magicstick/dashboard-contracts';
import type {Evidence,TestLayer} from './evidence.ts';
import {protectedModule} from './application-modules.ts';
import {requireSafe} from './errors.ts';
import {canonical} from './borrowed-sharing.ts';

/** This is an inventory of the installed catalogs, not a second product catalog.
 * An unreviewed adapter stays visible and blocks its applicable stage. */
export const serviceStages=['installation','access'] as const;
export type ServiceStage=typeof serviceStages[number];
export type ServiceKind='module'|'application';
export type ServiceCapabilityCode='ADAPTER_UNREVIEWED'|'INSTANCE_PROVIDER'|'NO_ROUTE';
export type ServiceCapability={state:'supported'}|{state:'blocked'|'not-applicable';code:ServiceCapabilityCode};
export type ServiceCapabilities=Record<ServiceStage,ServiceCapability>;
export interface ServiceMatrixEntry {
  kind:ServiceKind;id:string;title:string;requiredModules:string[];uninstallPolicy?:string;
  capabilities:ServiceCapabilities;
}
export interface ServiceMatrixExclusion {kind:ServiceKind;id:string;reason:'PROTECTED_MODULE'|'STATIC_MODULE'|'SEPARATE_HERMES'}
export interface ServiceMatrix {version:1;entries:ServiceMatrixEntry[];excluded:ServiceMatrixExclusion[]}
export type ReviewedServiceCapabilities=Record<string,Partial<ServiceCapabilities>>;
const idPattern=/^[a-z][a-z0-9-]{0,62}$/;
const codes:ServiceCapabilityCode[]=['ADAPTER_UNREVIEWED','INSTANCE_PROVIDER','NO_ROUTE'];
const capabilities=(review:Partial<ServiceCapabilities>|undefined):ServiceCapabilities=>Object.fromEntries(serviceStages.map(stage=>{
  const value=review?.[stage]??{state:'blocked',code:'ADAPTER_UNREVIEWED'};
  requireSafe(value&&typeof value==='object'&&!Array.isArray(value)&&
    (value.state==='supported'&&Object.keys(value).length===1||['blocked','not-applicable'].includes(value.state)&&
      Object.keys(value).length===2&&'code' in value&&codes.includes(value.code)),'CONFIG');
  return [stage,{...value}];
})) as ServiceCapabilities;

/** Keys in the reviewed map are `module:<catalog ID>` or
 * `application:<catalog ID>`. Presence never follows from a friendly title.
 * Callers must retain the blocked rows in their reports and selection matrix. */
export function serviceMatrix(payload:ModulesPayload,reviewed:ReviewedServiceCapabilities={}):ServiceMatrix {
  const catalog=payload.catalogJson;
  requireSafe(catalog?.modules&&catalog.applications,'PREREQUISITE');
  const entries:ServiceMatrixEntry[]=[],excluded:ServiceMatrixExclusion[]=[];
  const dependencies=(value:unknown)=>{
    requireSafe(Array.isArray(value)&&value.every(id=>typeof id==='string'&&idPattern.test(id)&&Object.hasOwn(catalog.modules!,id)),'CONFIG');
    requireSafe(new Set(value).size===value.length,'CONFIG');return [...value].sort() as string[];
  };
  for(const [id,item] of Object.entries(catalog.modules)) {
    requireSafe(idPattern.test(id),'CONFIG');
    if(protectedModule(id)){excluded.push({kind:'module',id,reason:'PROTECTED_MODULE'});continue;}
    if(item.activationMode!=='moduleactivation'){excluded.push({kind:'module',id,reason:'STATIC_MODULE'});continue;}
    if(id==='hermes-operator'){excluded.push({kind:'module',id,reason:'SEPARATE_HERMES'});continue;}
    entries.push({kind:'module',id,title:typeof item.displayName==='string'?item.displayName:id,
      requiredModules:dependencies(item.requires??[]),
      ...(typeof item.uninstallPolicy==='string'?{uninstallPolicy:item.uninstallPolicy}:{}),
      capabilities:capabilities(reviewed['module:'+id])});
  }
  for(const [id,item] of Object.entries(catalog.applications)) {
    requireSafe(idPattern.test(id),'CONFIG');
    if(id==='hermes'){excluded.push({kind:'application',id,reason:'SEPARATE_HERMES'});continue;}
    entries.push({kind:'application',id,title:typeof item.displayName==='string'?item.displayName:id,
      requiredModules:dependencies(item.requiredModules),capabilities:capabilities(reviewed['application:'+id])});
  }
  for(const key of Object.keys(reviewed))requireSafe(entries.some(entry=>entry.kind+':'+entry.id===key),'CONFIG');
  const order=(a:{kind:ServiceKind;id:string},b:{kind:ServiceKind;id:string})=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id);
  return {version:1,entries:entries.sort(order),excluded:excluded.sort(order)};
}

/** A saved plan is selection data, not authority to omit a catalog entry or
 * declare a new adapter supported. Compare it with a freshly reviewed inventory. */
export function requireServiceMatrix(value:unknown,expected:ServiceMatrix):ServiceMatrix {
  requireSafe(expected.version===1&&canonical(value)===canonical(expected),'CONFLICT');
  return expected;
}

/** Existing case IDs are kept, but each catalog entry has a separate required
 * tuple. One service passing a stage cannot stand in for another service. */
const stageCases:Record<ServiceStage,Record<ServiceKind,Array<[string,string]>>>={
  installation:{module:[['MOD-03','AE'],['MOD-04','AE']],application:[['APP-02','AE'],['APP-10','AE']]},
  access:{module:[['MOD-03','AE']],application:[['APP-05','AE'],['APP-07','AE'],['ACL-01','AE'],['ACL-02','AE'],['ACL-04','AE'],['ACL-06','A']]},
};
export function serviceStageEvidence(stage:ServiceStage,entry:ServiceMatrixEntry):Evidence[] {
  requireSafe(serviceStages.includes(stage)&&['module','application'].includes(entry.kind)&&idPattern.test(entry.id),'CONFIG');
  if(entry.capabilities[stage].state==='not-applicable')return [];
  return stageCases[stage][entry.kind].flatMap(([id,layers])=>layers.split('').map(layer=>({
    id,variant:`p5-services-${entry.kind}-${entry.id}-${stage}-${id.toLowerCase()}`,layer:layer as TestLayer})));
}
export function servicesRequirements(matrix:ServiceMatrix) {
  requireSafe(matrix.version===1&&matrix.entries.length>0,'PREREQUISITE');
  requireSafe(matrix.entries.length<=128&&new Set(matrix.entries.map(row=>row.kind+':'+row.id)).size===matrix.entries.length,'CONFIG');
  for(const entry of matrix.entries) {
    requireSafe(idPattern.test(entry.id)&&['module','application'].includes(entry.kind)&&Array.isArray(entry.requiredModules)&&
      entry.requiredModules.every(id=>typeof id==='string'&&idPattern.test(id))&&entry.capabilities&&
      Object.keys(entry.capabilities).length===serviceStages.length&&
      Object.keys(entry.capabilities).every(key=>serviceStages.includes(key as ServiceStage)),'CONFIG');
    capabilities(entry.capabilities);
  }
  return serviceStages.flatMap(stage=>matrix.entries.flatMap(entry=>serviceStageEvidence(stage,entry)
    .map(item=>({...item,environment:'live' as const,phase:5 as const}))));
}
export const servicesCaseIds=[...new Set(serviceStages.flatMap(stage=>
  [...stageCases[stage].module,...stageCases[stage].application].map(([id])=>id)))];

/** Dynamic catalog names are allowed only inside this bounded, reviewed
 * variant grammar; an arbitrary label cannot impersonate another case. */
export function serviceVariantCase(variant:string):string|undefined {
  const match=variant.match(/^p5-services-(module|application)-([a-z][a-z0-9-]{0,62})-(installation|access)-([a-z]+-\d{2})$/);
  if(!match)return;
  const id=match[4]!.toUpperCase();
  return stageCases[match[3] as ServiceStage][match[1] as ServiceKind].some(([caseId])=>caseId===id)?id:undefined;
}
