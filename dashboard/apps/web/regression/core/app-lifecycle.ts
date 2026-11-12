import type {ModulesPayload} from '@magicstick/dashboard-contracts';
import type {KubeObject} from './observer.ts';
import type {JournalEntry,ResourceJournal} from './journal.ts';
import {ownedJournalName} from './journal.ts';
import {requireSafe} from './errors.ts';
import {journalFile,readPrivate,writePrivate} from './private-files.ts';
import {poll} from './poll.ts';
import {lstat} from 'node:fs/promises';

/** No Secret reads and no additional delete permissions. Every known workload
 * kind is observed; the current catalog supplies native operator CR kinds. */
export const appRuntimeResources=['deployments.apps','statefulsets.apps','daemonsets.apps','replicasets.apps',
  'replicationcontrollers','jobs.batch','cronjobs.batch','pods','services','endpoints','endpointslices.discovery.k8s.io',
  'httproutes.gateway.networking.k8s.io','securitypolicies.gateway.envoyproxy.io','referencegrants.gateway.networking.k8s.io',
  'networkpolicies.networking.k8s.io','configmaps','helmreleases.helm.toolkit.fluxcd.io','controllerrevisions.apps',
  'persistentvolumeclaims'] as const;
export interface AppRuntimeObject {resource:string;object:KubeObject}
interface RuntimeReference {resource:string;name:string;namespace:string;uid:string;keep?:true}
export interface AppRuntimeReceipt {version:1;runId:string;applianceUid:string;name:string;uid:string;generation:number;
  resources:string[];runtime:RuntimeReference[];persistent:RuntimeReference[];state:'observed'|'removed';
  verification?:{runtimeAbsent:true;persistent:Array<RuntimeReference&{state:'retained'|'removed'}>};removedAt?:string}
const nativeResource=/^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*){2,}$/;
const referenceKey=(item:RuntimeReference)=>[item.resource,item.namespace,item.name].join('/');
const referenceOrder=(a:RuntimeReference,b:RuntimeReference)=>referenceKey(a).localeCompare(referenceKey(b))||a.uid.localeCompare(b.uid);
const reference=(item:AppRuntimeObject):RuntimeReference=>{
  requireSafe(item.object.metadata.name&&item.object.metadata.namespace&&item.object.metadata.uid,'OWNERSHIP');
  return {resource:item.resource,name:item.object.metadata.name,namespace:item.object.metadata.namespace,uid:item.object.metadata.uid,
    ...(item.object.metadata.annotations?.['helm.sh/resource-policy']==='keep'?{keep:true as const}:{})};
};

export function appRuntimeResourceKinds(payload:ModulesPayload,type:string):string[] {
  const catalog=payload.catalogJson,application=catalog?.applications?.[type];
  requireSafe(application&&catalog?.modules&&Array.isArray(application.requiredModules),'PREREQUISITE');
  const resources=new Set<string>(appRuntimeResources),visited=new Set<string>();
  const add=(values:unknown)=>{requireSafe(Array.isArray(values),'CONFIG');for(const value of values){
    requireSafe(typeof value==='string'&&nativeResource.test(value),'CONFIG');resources.add(value);}};
  add(application.requiredCrds??[]);
  const visit=(id:string)=>{if(visited.has(id))return;visited.add(id);const module=catalog.modules![id];requireSafe(module,'CONFIG');
    add(module.requiredCrds??[]);const dependencies=module.requires??[];requireSafe(Array.isArray(dependencies)&&dependencies.every(id=>typeof id==='string'),'CONFIG');
    for(const dependency of dependencies)visit(dependency);};
  for(const id of application.requiredModules)visit(id);
  return [...resources].sort();
}

/** Labels are only absence sentinels. They never authorize deletion. UIDs from
 * the pre-delete snapshot retain ownership of unlabelled descendants even after
 * the native root/HelmRelease has disappeared. */
export function appRuntimeAssociated(item:KubeObject,name:string,uid:string) {
  return item.metadata.ownerReferences?.some(owner=>owner.uid===uid)||
    item.metadata.labels?.['appliance.magicstick.dev/appinstance']===name||
    item.metadata.labels?.['app.kubernetes.io/instance']===name||
    item.metadata.annotations?.['meta.helm.sh/release-name']===name||
    item.metadata.namespace==='ai-system'&&item.metadata.name===name;
}
export function appRuntimeInventory(objects:readonly AppRuntimeObject[],name:string,uid:string,previous:readonly RuntimeReference[]=[]) {
  const owned=objects.filter(item=>appRuntimeAssociated(item.object,name,uid)),uids=new Set([uid,...previous.map(item=>item.uid),
    ...owned.map(item=>item.object.metadata.uid)]);
  for(let changed=true;changed;){changed=false;for(const item of objects)if(!owned.includes(item)&&
    (uids.has(item.object.metadata.uid)||item.object.metadata.ownerReferences?.some(owner=>uids.has(owner.uid)))){
    owned.push(item);uids.add(item.object.metadata.uid);changed=true;}}
  const persistent=owned.filter(item=>item.resource==='persistentvolumeclaims');
  return {runtime:owned.filter(item=>item.resource!=='persistentvolumeclaims'),persistent};
}
export function appRuntimeRemovalObserved(receipt:AppRuntimeReceipt,current:readonly AppRuntimeObject[]) {
  for(const previous of [...receipt.runtime,...receipt.persistent]) {
    const same=current.find(item=>referenceKey(reference(item))===referenceKey(previous));
    requireSafe(!same||same.object.metadata.uid===previous.uid,'OWNERSHIP');
  }
  const after=appRuntimeInventory(current,receipt.name,receipt.uid,[...receipt.runtime,...receipt.persistent]);
  for(const previous of receipt.persistent.filter(item=>item.keep)) {
    const retained=after.persistent.find(item=>item.object.metadata.uid===previous.uid);
    requireSafe(retained&&!retained.object.metadata.deletionTimestamp&&retained.object.metadata.annotations?.['helm.sh/resource-policy']==='keep','CLEANUP');
  }
  const persistent=after.persistent.map(reference);
  return {removed:after.runtime.length===0&&after.persistent.every(item=>!item.object.metadata.deletionTimestamp),
    persistent:[...receipt.persistent,...persistent.filter(item=>!receipt.persistent.some(previous=>previous.uid===item.uid))]
      .map(item=>({...item,state:persistent.some(current=>current.uid===item.uid)?'retained' as const:'removed' as const})).sort(referenceOrder)};
}
export function requireAppRuntimeReceipt(value:AppRuntimeReceipt,journal:Pick<ResourceJournal,'runId'|'prefix'>,applianceUid:string,entry:JournalEntry) {
  requireSafe(value?.version===1&&value.runId===journal.runId&&value.applianceUid===applianceUid&&value.name===entry.name&&
    value.uid===entry.uid&&value.generation===entry.generation&&ownedJournalName('app',value.name,journal.prefix)&&
    Array.isArray(value.resources)&&value.resources.length>=appRuntimeResources.length&&new Set(value.resources).size===value.resources.length&&
    appRuntimeResources.every(resource=>value.resources.includes(resource))&&value.resources.every(resource=>
      appRuntimeResources.includes(resource as typeof appRuntimeResources[number])||nativeResource.test(resource))&&
    Array.isArray(value.runtime)&&Array.isArray(value.persistent)&&[...value.runtime,...value.persistent].every(item=>
      value.resources.includes(item.resource)&&typeof item.name==='string'&&item.name.length>0&&typeof item.namespace==='string'&&item.namespace.length>0&&
      typeof item.uid==='string'&&item.uid.length>0&&(item.keep===undefined||item.keep===true))&&
    ['observed','removed'].includes(value.state),'RECOVERY');
  if(value.state==='removed')requireSafe(value.verification?.runtimeAbsent===true&&Number.isFinite(Date.parse(value.removedAt??''))&&
    Array.isArray(value.verification.persistent)&&value.verification.persistent.every(item=>['retained','removed'].includes(item.state)&&
      item.resource==='persistentvolumeclaims'&&typeof item.name==='string'&&typeof item.namespace==='string'&&typeof item.uid==='string')&&
    value.persistent.every(previous=>value.verification!.persistent.some(item=>referenceKey(item)===referenceKey(previous)&&item.uid===previous.uid&&
      (!previous.keep||item.state==='retained'))),'RECOVERY');
  return value;
}

interface AppCleanupLive {journal:ResourceJournal;guard():Promise<void>;config:{expected:{applianceUid:string}};
  observer:{list(resource:string):Promise<KubeObject[]>}}
export class AppRuntimeProof {
  private readonly live:AppCleanupLive;
  private readonly current:(name:string)=>Promise<KubeObject|null>;
  private readonly catalog:()=>Promise<ModulesPayload>;
  constructor(live:AppCleanupLive,current:(name:string)=>Promise<KubeObject|null>,catalog:()=>Promise<ModulesPayload>){
    this.live=live;this.current=current;this.catalog=catalog;
  }
  private filename(entry:JournalEntry){return journalFile(this.live.journal,'app-runtime-'+entry.name+'.json');}
  private async observe(resources:string[]) {
    // A missing CRD, failed list or forbidden permission is unknown, not [] and
    // not evidence that a native instance/controller was successfully removed.
    return (await Promise.all(resources.map(async resource=>(await this.live.observer.list(resource)).map(object=>({resource,object}))))).flat();
  }
  async capture(entry:JournalEntry):Promise<AppRuntimeReceipt> {
    const filename=this.filename(entry);await this.live.guard();
    const catalog=await this.catalog(),type=Object.keys(catalog.catalogJson?.applications??{}).find(type=>entry.name.startsWith(type+'-'+this.live.journal.prefix));
    requireSafe(type,'OWNERSHIP');const resources=appRuntimeResourceKinds(catalog,type);
    if(await lstat(filename).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;})) {
      const receipt=requireAppRuntimeReceipt(JSON.parse(await readPrivate(filename)),this.live.journal,this.live.config.expected.applianceUid,entry);
      requireSafe(JSON.stringify(receipt.resources)===JSON.stringify(resources),'CONFLICT');return receipt;
    }
    const current=await this.current(entry.name);
    requireSafe(entry.uid&&entry.generation&&current?.metadata.uid===entry.uid&&current.metadata.generation===entry.generation&&
      current.spec?.targetNamespace==='ai'&&typeof current.spec.application==='string','OWNERSHIP');
    requireSafe(current.spec.application===type,'OWNERSHIP');const objects=await this.observe(resources);
    const inventory=appRuntimeInventory(objects,entry.name,entry.uid),fresh=await this.current(entry.name);
    await this.live.guard();requireSafe(fresh?.metadata.uid===entry.uid&&fresh.metadata.generation===entry.generation,'OWNERSHIP');
    const receipt:AppRuntimeReceipt={version:1,runId:this.live.journal.runId,applianceUid:this.live.config.expected.applianceUid,
      name:entry.name,uid:entry.uid,generation:entry.generation,resources,runtime:inventory.runtime.map(reference).sort(referenceOrder),
      persistent:inventory.persistent.map(reference).sort(referenceOrder),state:'observed'};
    await writePrivate(filename,receipt,true);return receipt;
  }
  async verifyRemoved(entry:JournalEntry) {
    if(entry.uid===null) {
      const catalog=await this.catalog(),type=Object.keys(catalog.catalogJson?.applications??{}).find(type=>entry.name.startsWith(type+'-'+this.live.journal.prefix));
      requireSafe(type,'OWNERSHIP');const resources=appRuntimeResourceKinds(catalog,type);
      await poll(async()=>{await this.live.guard();const objects=await this.observe(resources),inventory=appRuntimeInventory(objects,entry.name,'unacknowledged');
        return !await this.current(entry.name)&&inventory.runtime.length===0;
      },Boolean,{timeoutMs:300_000,intervalMs:1000,stage:'cleanup'});return true;
    }
    const receipt=await this.capture(entry);
    const result=await poll(async()=>{await this.live.guard();const current=await this.current(entry.name);
      requireSafe(!current||current.metadata.uid===entry.uid,'OWNERSHIP');const result=appRuntimeRemovalObserved(receipt,await this.observe(receipt.resources));
      return {...result,removed:!current&&result.removed};
    },result=>result.removed,{timeoutMs:300_000,intervalMs:1000,stage:'cleanup'});
    if(receipt.state==='removed')requireSafe(JSON.stringify(receipt.verification?.persistent)===JSON.stringify(result.persistent),'CONFLICT');
    else await writePrivate(this.filename(entry),{...receipt,state:'removed',removedAt:new Date().toISOString(),
      verification:{runtimeAbsent:true,persistent:result.persistent}});
    return true;
  }
}
