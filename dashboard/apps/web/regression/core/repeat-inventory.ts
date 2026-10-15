import type {KubeObject} from './observer.ts';
import {requireProof} from './errors.ts';

/** Model-catalog changes legitimately roll consumer Pods. Compare their
 * stable workload UID and count, never the replaceable Pod/ReplicaSet UID.
 * Bare Pods and unresolved owners retain exact identity; extra replicas or a
 * recreated workload cannot disappear into a name-only comparison. */
export function workloadPodInventory(pods:KubeObject[],replicaSets:KubeObject[]) {
  const sets=new Map(replicaSets.map(item=>[item.metadata.uid,item]));
  return pods.map(pod=>{
    requireProof(typeof pod.metadata.uid==='string' && pod.metadata.uid.length>0,'API');
    const owner=pod.metadata.ownerReferences?.find(item=>item.controller);
    if(!owner)return 'Pod:'+pod.metadata.uid;
    requireProof(typeof owner.uid==='string' && owner.uid.length>0,'API');
    const deployment=owner.kind==='ReplicaSet' ? sets.get(owner.uid)?.metadata.ownerReferences?.find(item=>item.controller && item.kind==='Deployment') : undefined;
    return deployment?.uid ? 'Deployment:'+deployment.uid : owner.kind+':'+owner.uid;
  }).sort().join(',');
}

type Inventory={modelIds:string;podIds:string;intentIds:string;claimIds:string;routeIds:string;keyIds:string};
export function repeatInventoryChanges(before:Inventory,after:Inventory) {
  return (['modelIds','podIds','intentIds','claimIds','routeIds','keyIds'] as const).filter(key=>before[key]!==after[key]);
}
