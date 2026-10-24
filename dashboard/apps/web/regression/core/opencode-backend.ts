import type {LiveFoundation} from './live-foundation.ts';
import type {KubeObject} from './observer.ts';
import {requireProof} from './errors.ts';
import {poll} from './poll.ts';

/** The pinned KubeOpenCode controller uses a single server Deployment and a
 * Service selected by Agent name. Helm readiness alone does not prove that
 * its asynchronous native rollout has stopped serving two session stores. */
export function openCodeBackendReady(name:string,namespace:string,service:KubeObject|undefined,
  deployment:KubeObject|undefined,replicas:KubeObject[],pods:KubeObject[]) {
  requireProof(name.startsWith('kubeopencode-')&&name.length>'kubeopencode-'.length,'OWNERSHIP');
  const agent=name.slice('kubeopencode-'.length);
  if(!service?.metadata.uid||!deployment?.metadata.uid)return;
  const owner=(item:KubeObject)=>item.metadata.ownerReferences?.find(value=>value.kind==='Agent'&&value.name===agent);
  const serviceOwner=owner(service),deploymentOwner=owner(deployment);
  requireProof(service.metadata.name===agent&&deployment.metadata.name===agent+'-server'&&
    service.metadata.namespace===namespace&&deployment.metadata.namespace===namespace&&
    serviceOwner?.uid&&serviceOwner.uid===deploymentOwner?.uid,'OWNERSHIP');
  const selector=service.spec?.selector as Record<string,string>|undefined;
  requireProof(selector?.['kubeopencode.io/agent']===agent&&Object.entries(selector).every(([key,value])=>key&&typeof value==='string'&&value),'API');
  const rs=new Set(replicas.filter(item=>item.metadata.namespace===namespace&&
    item.metadata.ownerReferences?.some(value=>value.kind==='Deployment'&&value.uid===deployment.metadata.uid))
    .map(item=>item.metadata.uid).filter((uid):uid is string=>Boolean(uid)));
  const selected=pods.filter(item=>item.metadata.namespace===namespace&&
    Object.entries(selector).every(([key,value])=>item.metadata.labels?.[key]===value)&&
    !['Succeeded','Failed'].includes(item.status?.phase??''));
  requireProof(selected.every(item=>item.metadata.ownerReferences?.some(value=>value.kind==='ReplicaSet'&&rs.has(value.uid))),'OWNERSHIP');
  const status=deployment.status as {observedGeneration?:number;replicas?:number;updatedReplicas?:number;
    readyReplicas?:number;availableReplicas?:number;unavailableReplicas?:number}|undefined;
  if(service.metadata.deletionTimestamp||deployment.metadata.deletionTimestamp||deployment.spec?.replicas!==1||
    !Number.isSafeInteger(deployment.metadata.generation)||Number(deployment.metadata.generation)<1||
    status?.observedGeneration!==deployment.metadata.generation||status?.replicas!==1||status.updatedReplicas!==1||
    status.readyReplicas!==1||status.availableReplicas!==1||Number(status.unavailableReplicas??0)!==0||selected.length!==1)return;
  const pod=selected[0]!;
  const template=deployment.spec.template as {spec?:{containers?:Array<{name:string;image:string}>}}|undefined;
  const image=template?.spec?.containers?.find(item=>item.name==='opencode-server')?.image;
  requireProof(image&&/@sha256:[a-f0-9]{64}$/.test(image),'REVISION');
  if(pod.metadata.uid&&!pod.metadata.deletionTimestamp&&pod.status?.phase==='Running'&&
    pod.status.containerStatuses?.some(item=>item.name==='opencode-server'&&item.ready&&item.imageID?.endsWith(image.split('@')[1]!)))return pod;
}

export async function waitOpenCodeBackend(live:LiveFoundation,name:string,namespace:string) {
  const agent=name.slice('kubeopencode-'.length);
  return poll(async()=>{
    await live.guard();
    const [services,deployments,replicas,pods]=await Promise.all(['services','deployments.apps','replicasets.apps','pods']
      .map(resource=>live.observer.list(resource,namespace)));
    return openCodeBackendReady(name,namespace,services!.find(item=>item.metadata.name===agent),
      deployments!.find(item=>item.metadata.name===agent+'-server'),replicas!,pods!);
  },Boolean,{timeoutMs:180_000,intervalMs:1000,stage:'app-ready'});
}
