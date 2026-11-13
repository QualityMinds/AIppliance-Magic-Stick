import {basename,dirname,join} from 'node:path';
import {lstat} from 'node:fs/promises';
import type {KubeObject} from './observer.ts';
import type {ResourceJournal} from './journal.ts';
import {protectedModule} from './application-modules.ts';
import {canonical} from './borrowed-sharing.ts';
import {moduleRuntimeResources,moduleRuntimeInventory,moduleInstallationObserved,moduleRemovalObserved,observeModuleRuntime,type ModuleRuntimeObject,type ModuleReleaseBinding} from './module-lifecycle.ts';
import {readPrivate,writePrivate,journalFile} from './private-files.ts';
import {requireSafe} from './errors.ts';
import {poll} from './poll.ts';

interface Reference {resource:ModuleRuntimeObject['resource'];name:string;namespace:string;uid:string}
export interface ModuleRuntimeReceipt {version:1;runId:string;applianceUid:string;original:KubeObject;borrowedReceipt:string;
  kustomizationName:string;keepData:boolean;runtime:Reference[];persistent:Reference[];releaseBindings?:ModuleReleaseBinding[];state:'observed'|'verified';checkedAt?:string;restored?:KubeObject}
interface Live {journal:ResourceJournal;guard():Promise<void>;config:{expected:{applianceUid:string}};
  observer:{get(resource:string,namespace:string,name:string):Promise<KubeObject>;list(resource:string,namespace?:string):Promise<KubeObject[]>}}
const ref=(item:ModuleRuntimeObject):Reference=>{const {uid,name,namespace}=item.object.metadata;requireSafe(uid&&name&&namespace,'OWNERSHIP');
  return {resource:item.resource,uid,name,namespace};};
const object=(item:Reference):ModuleRuntimeObject=>({resource:item.resource,object:{metadata:{name:item.name,namespace:item.namespace,uid:item.uid}}});
const merge=(before:Reference[],after:Reference[])=>[...before,...after.filter(item=>!before.some(previous=>previous.uid===item.uid))]
  .sort((a,b)=>(a.resource+'/'+a.namespace+'/'+a.name+'/'+a.uid).localeCompare(b.resource+'/'+b.namespace+'/'+b.name+'/'+b.uid));
const bound=(value:KubeObject)=>({metadata:{name:value.metadata.name,namespace:value.metadata.namespace,uid:value.metadata.uid,
  generation:value.metadata.generation},spec:value.spec});
async function present(filename:string){return Boolean(await lstat(filename).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;}));}
export function requireModuleRuntimeReceipt(value:ModuleRuntimeReceipt,journal:Pick<ResourceJournal,'runId'>,applianceUid:string) {
  const original=value?.original,id=original?.spec?.module;
  requireSafe(value?.version===1&&value.runId===journal.runId&&value.applianceUid===applianceUid&&typeof id==='string'&&
    /^[a-z0-9-]{1,63}$/.test(id)&&!protectedModule(id)&&original.metadata.namespace==='ai-system'&&
    typeof original.metadata.name==='string'&&/^[a-z0-9-]{1,63}$/.test(original.metadata.name)&&typeof original.metadata.uid==='string'&&original.metadata.uid.length>0&&
    Number.isSafeInteger(original.metadata.generation)&&Number(original.metadata.generation)>0&&typeof original.spec?.enabled==='boolean'&&
    /^borrowed-module(?:-[a-z0-9-]{1,63})?\.json$/.test(value.borrowedReceipt)&&/^[a-z0-9-]{1,63}$/.test(value.kustomizationName)&&
    typeof value.keepData==='boolean'&&['observed','verified'].includes(value.state)&&Array.isArray(value.runtime)&&Array.isArray(value.persistent)&&
    [...value.runtime,...value.persistent].length<=2048&&[...value.runtime,...value.persistent].every(item=>moduleRuntimeResources.includes(item.resource)&&
      typeof item.name==='string'&&typeof item.namespace==='string'&&typeof item.uid==='string'&&item.name&&item.namespace&&item.uid),'RECOVERY');
  if(value.releaseBindings!==undefined)requireSafe(Array.isArray(value.releaseBindings)&&value.releaseBindings.length<=2048&&value.releaseBindings.every(item=>item&&
      value.runtime.some(ref=>ref.resource==='helmreleases.helm.toolkit.fluxcd.io'&&ref.uid===item.uid&&ref.name===item.name&&ref.namespace===item.namespace)&&
      typeof item.releaseName==='string'&&/^[a-z0-9][a-z0-9.-]{0,252}$/.test(item.releaseName)&&
      typeof item.releaseNamespace==='string'&&/^[a-z0-9][a-z0-9-]{0,62}$/.test(item.releaseNamespace))&&
    new Set(value.releaseBindings.map(item=>item.uid)).size===value.releaseBindings.length,'RECOVERY');
  if(value.state==='verified')requireSafe(Number.isFinite(Date.parse(value.checkedAt??''))&&value.restored?.metadata.uid===original.metadata.uid&&
    Number(value.restored.metadata.generation)>=Number(original.metadata.generation)&&canonical(value.restored.spec)===canonical(original.spec),'RECOVERY');
  return value;
}

/** Exact runtime closure evidence for new service lifecycle transactions only.
 * No native runtime deletion is added; the original BorrowedModule performs
 * the existing normal intent restoration before these independent reads. */
export class ModuleRuntimeProof {
  readonly filename:string;
  private readonly live:Live;
  private readonly initial:ModuleRuntimeReceipt;
  constructor(live:Live,original:KubeObject,borrowedReceipt:string,kustomizationName:string,keepData:boolean) {
    this.live=live;this.filename=journalFile(live.journal,'module-runtime-'+String(original.spec?.module)+'.json');
    this.initial={version:1,runId:live.journal.runId,applianceUid:live.config.expected.applianceUid,original,borrowedReceipt:basename(borrowedReceipt),
      kustomizationName,keepData,runtime:[],persistent:[],state:'observed'};
    requireModuleRuntimeReceipt(this.initial,live.journal,live.config.expected.applianceUid);
  }
  static async resume(live:Live,filename:string) {
    const value=requireModuleRuntimeReceipt(JSON.parse(await readPrivate(filename)),live.journal,live.config.expected.applianceUid);
    const proof=new ModuleRuntimeProof(live,value.original,value.borrowedReceipt,value.kustomizationName,value.keepData);
    requireSafe(proof.filename===filename,'OWNERSHIP');return proof;
  }
  private async receipt(){return await present(this.filename)?requireModuleRuntimeReceipt(JSON.parse(await readPrivate(this.filename)),this.live.journal,
    this.live.config.expected.applianceUid):this.initial;}
  private async current(restored=false) {
    await this.live.guard();let expected=this.initial.original;
    const filename=join(dirname(this.filename),this.initial.borrowedReceipt);
    if(await present(filename)) {
      const borrowed=JSON.parse(await readPrivate(filename));
      requireSafe(borrowed.version===1&&canonical(borrowed.original)===canonical(this.initial.original),'OWNERSHIP');
      if(restored)requireSafe(borrowed.state==='restored','CLEANUP');
      expected=borrowed.applied??borrowed.restored??borrowed.original;
    }
    const current=await this.live.observer.get('moduleactivations.appliance.magicstick.dev','ai-system',this.initial.original.metadata.name!);
    requireSafe(current.metadata.uid===expected.metadata.uid&&current.metadata.generation===expected.metadata.generation&&
      canonical(current.spec)===canonical(expected.spec),'CONFLICT');
    if(restored)requireSafe(canonical(current.spec)===canonical(this.initial.original.spec),'CLEANUP');return current;
  }
  async verifyRecoverable(){await this.current();}
  async capture(options:{timeoutMs?:number;intervalMs?:number}={}) {
    const receipt=await this.receipt();await this.current();
    const inventory=await poll(async()=>{
      const current=await this.current(),[objects,sources]=await Promise.all([observeModuleRuntime(this.live.observer),
        this.live.observer.list('kustomizations.kustomize.toolkit.fluxcd.io','flux-system')]);
      const source=sources.find(item=>item.metadata.name===receipt.kustomizationName),observed=moduleRuntimeInventory(objects,receipt.kustomizationName,'flux-system',source);
      // An enabled intent may not have materialized its root yet. An empty
      // workload list alone is not a closed snapshot of that pending install.
      return {...observed,inventoryKnown:observed.inventoryKnown&&(!current.spec?.enabled||Boolean(source))};
    },value=>value.inventoryKnown,{timeoutMs:options.timeoutMs??300_000,intervalMs:options.intervalMs??1000,stage:'recovery-module'});await this.current();
    for(const binding of inventory.releaseBindings){const previous=receipt.releaseBindings?.find(item=>item.uid===binding.uid);
      requireSafe(!previous||canonical(previous)===canonical(binding),'CONFLICT');}
    const releaseBindings=[...(receipt.releaseBindings??[]),...inventory.releaseBindings.filter(item=>!receipt.releaseBindings?.some(previous=>previous.uid===item.uid))];
    const next={...receipt,runtime:merge(receipt.runtime,inventory.runtime.map(ref)),persistent:merge(receipt.persistent,inventory.persistent.map(ref)),
      releaseBindings,state:'observed' as const};
    await writePrivate(this.filename,next);return next;
  }
  async verifyRestored(options:{timeoutMs?:number;intervalMs?:number}={}) {
    const receipt=await this.receipt();requireSafe(await present(this.filename),'RECOVERY');
    const restored=await poll(async()=>{
      const current=await this.current(true),[objects,sources]=await Promise.all([observeModuleRuntime(this.live.observer),
        this.live.observer.list('kustomizations.kustomize.toolkit.fluxcd.io','flux-system')]);
      const source=sources.find(item=>item.metadata.name===receipt.kustomizationName),before={runtime:receipt.runtime.map(object),persistent:receipt.persistent.map(object),
        inventoryReady:true,inventoryKnown:true,releaseBindings:receipt.releaseBindings??[],missingWorkloads:[]};
      if(!receipt.original.spec!.enabled)return {current,ready:!source&&moduleRemovalObserved(before,objects,receipt.kustomizationName,receipt.keepData)};
      const inventory=moduleRuntimeInventory(objects,receipt.kustomizationName,'flux-system',source);
      if(receipt.keepData)for(const previous of receipt.persistent)requireSafe(objects.some(item=>item.resource===previous.resource&&
        item.object.metadata.uid===previous.uid&&!item.object.metadata.deletionTimestamp),'CLEANUP');
      return {current,ready:Boolean(source)&&current.status?.phase==='Ready'&&current.status.observedGeneration===current.metadata.generation&&moduleInstallationObserved(inventory)};
    },value=>value.ready,{timeoutMs:options.timeoutMs??300_000,intervalMs:options.intervalMs??1000,stage:'recovery-module'});
    if(receipt.state==='verified')requireSafe(canonical(bound(receipt.restored!))===canonical(bound(restored.current)),'CONFLICT');
    else await writePrivate(this.filename,{...receipt,state:'verified',checkedAt:new Date().toISOString(),restored:bound(restored.current)});
  }
}
