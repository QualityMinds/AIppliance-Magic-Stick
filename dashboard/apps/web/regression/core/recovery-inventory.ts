import {lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ResourceJournal} from './journal.ts';
import {readPrivate} from './private-files.ts';
import {requireSafe} from './errors.ts';
import type {KubeObject} from './observer.ts';

export interface RecoveryIdentity {applianceUid:string;nodeUids:string[]}
export interface ModuleReceipt {filename:string;original:KubeObject;applied?:KubeObject;restored?:KubeObject;state:string}
export interface SharingReceipt {filename:string;identity:{runId:string;targetUid:string;nodeName:string;nodeUid:string};pending:boolean}
const auxiliary=/^(?:ollama|vllm|unsupported|sanitized|risk-reject|risk-accept|external|provider)-(reg-[0-9a-f-]{36})\.journal\.json$/;
const transaction=/^(?:borrowed-amd-profile|license-transaction(?:-lic-0[234])?|license-baseline(?:-(?:lic-01|sso-01))?|federation|mesh-membership|unmanaged-key-fixture|network-baseline-restore|host-drill-[a-z0-9-]+|kube-(?:configmaps|secrets|moduleactivations|appinstances|modelactivations))\.json$/;

/** This is the same finite inventory for recovery and clean-state verification.
 * Never search the cluster or unrelated run directories by a resource prefix. */
export async function recoveryPaths(directory:string) {
  const root=await lstat(directory);
  requireSafe(root.isDirectory()&&!root.isSymbolicLink()&&(root.mode&0o077)===0,'RECOVERY');
  const paths=[directory];
  for(const entry of await readdir(directory,{withFileTypes:true}))if(/^worker-/.test(entry.name)) {
    requireSafe(/^worker-(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(entry.name),'RECOVERY');
    const path=join(directory,entry.name),stat=await lstat(path);
    requireSafe(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'RECOVERY');paths.push(path);
  }
  return paths;
}
export async function recoveryInventory(directory:string,identity:RecoveryIdentity) {
  const paths=await recoveryPaths(directory),journals:ResourceJournal[]=[],modules:ModuleReceipt[]=[],sharing:SharingReceipt[]=[];
  const files=new Map<string,string>(),leases:Array<{filename:string;state:string;value:Record<string,unknown>}>=[];let unfinished=0;
  const record=async(filename:string)=>{const body=await readPrivate(filename);files.set(filename,body);return JSON.parse(body);};
  for(const path of paths) {
    const file=join(path,'journal.json');await record(file);
    const journal=await ResourceJournal.resume(file,identity.applianceUid);journals.push(journal);
    for(const name of (await readdir(path)).sort()) {
      const filename=join(path,name);
      if(name.endsWith('.journal.json')) {
        const match=auxiliary.exec(name);requireSafe(match&&journals.length<128,'RECOVERY');await record(filename);
        const extra=await ResourceJournal.resume(filename,identity.applianceUid);
        requireSafe(extra.runId===match[1]&&!journals.some(j=>j.runId===extra.runId),'RECOVERY');journals.push(extra);
      } else if(/^borrowed-module(?:-[a-z0-9-]{1,63})?\.json$/.test(name)) {
        const value=await record(filename);
        requireSafe(value.version===1&&value.original?.metadata?.namespace==='ai-system'&&
          typeof value.original.spec?.enabled==='boolean'&&typeof value.original.spec?.module==='string'&&
          !/identity|dashboard|basis|kubeai|gpu|amd|nvidia|intel|litellm|private-mesh|model-catalog|magicstick-operator|regression/.test(value.original.spec.module)&&
          ['requested','ambiguous','applied','unchanged','restored'].includes(value.state),'RECOVERY');
        modules.push({filename,original:value.original,applied:value.applied,restored:value.restored,state:value.state});
      } else if(/^(?:gpu|mesh|cache|realtime)-sharing\.json$/.test(name)) {
        const value=await record(filename);
        requireSafe(value.version===1&&/^reg-[0-9a-f-]{36}$/.test(value.runId)&&value.targetUid===identity.applianceUid&&
          identity.nodeUids.includes(value.nodeUid)&&typeof value.nodeName==='string'&&Array.isArray(value.entries)&&value.entries.length<=2&&
          value.entries.every((e:{state?:string})=>['borrowed','pending','restored'].includes(e.state??'')),'RECOVERY');
        sharing.push({filename,identity:{runId:value.runId,targetUid:value.targetUid,nodeName:value.nodeName,nodeUid:value.nodeUid},
          pending:value.entries.some((e:{state:string})=>e.state!=='restored')});
      } else if(/^lease-reg-[0-9a-f-]{36}\.json$/.test(name)) {
        const value=await record(filename);
        requireSafe(value.version===1&&/^reg-[0-9a-f-]{36}$/.test(value.runId)&&value.targetUid===identity.applianceUid&&
          typeof value.leaseUid==='string'&&name===`lease-${value.owner}.json`&&['requested','released'].includes(value.state),'RECOVERY');
        leases.push({filename,state:value.state,value});
      } else if(transaction.test(name)) {
        const value=await record(filename);requireSafe(value.version===1,'RECOVERY');
        if(!['restored','removed','verified'].includes(value.state))unfinished++;
      }
    }
  }
  for(const lease of leases)requireSafe(journals.some(j=>j.runId===lease.value.runId&&
    j.filename.slice(0,j.filename.lastIndexOf('/'))===lease.filename.slice(0,lease.filename.lastIndexOf('/'))),'RECOVERY');
  const fingerprint=(scope:string)=>{
    const hash=createHash('sha256');
    for(const [filename,body]of [...files].sort(([a],[b])=>a.localeCompare(b)))if(filename.startsWith(scope+'/'))
      hash.update(filename.slice(scope.length+1)+'\0'+body+'\0');
    return hash.digest('hex');
  };
  const open=journals.reduce((n,j)=>n+j.recoveryPlan().length,0)+modules.filter(m=>m.state!=='restored').length+
    sharing.filter(s=>s.pending).length+unfinished;
  return {paths,journals,modules,sharing,leases,leasePending:leases.filter(l=>l.state!=='released').length,unfinished,open,files,fingerprint};
}
