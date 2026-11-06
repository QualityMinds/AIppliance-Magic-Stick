import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {LiveFoundation} from './live-foundation.ts';
import {KubectlObserver,verifyObserverRules,type KubeObject} from './observer.ts';
import {readPrivate,writePrivate} from './private-files.ts';
import {requireSafe} from './errors.ts';
import {poll} from './poll.ts';

export class ServiceRestarter extends KubectlObserver {
  async verifyNamespace(namespace:string) {
    await readPrivate(this.kubeconfig);
    const config=JSON.parse(await this.command(['config','view','--raw','--minify','-o','json']));
    requireSafe(config.clusters?.[0]?.cluster?.server?.startsWith('https://') && !config.clusters[0].cluster['insecure-skip-tls-verify'] &&
      !config.users?.[0]?.user?.exec && !config.users?.[0]?.user?.['auth-provider'],'OBSERVER');
    for(const outside of ['default','ai','ai-system','flux-system','magicstick-regression'].filter(item=>item !== namespace)) {
      const result=JSON.parse(await this.command(['create','--raw','/apis/authorization.k8s.io/v1/selfsubjectrulesreviews','-f','-'],
        JSON.stringify({apiVersion:'authorization.k8s.io/v1',kind:'SelfSubjectRulesReview',spec:{namespace:outside}})));
      verifyObserverRules(result);
    }
    const review=JSON.parse(await this.command(['create','--raw','/apis/authorization.k8s.io/v1/selfsubjectrulesreviews','-f','-'],
      JSON.stringify({apiVersion:'authorization.k8s.io/v1',kind:'SelfSubjectRulesReview',spec:{namespace}})));
    requireSafe(review.status?.incomplete === false && review.status.resourceRules.some((rule:{resources:string[];verbs:string[]})=>rule.resources.includes('pods') && rule.verbs.includes('delete')),'OBSERVER');
    for(const rule of review.status.resourceRules) {
      const pods=rule.apiGroups.join(',') === '' && rule.resources.join(',') === 'pods' && rule.verbs.every((verb:string)=>['get','list','delete'].includes(verb));
      const reviews=rule.apiGroups.every((group:string)=>['authorization.k8s.io','authentication.k8s.io'].includes(group)) &&
        rule.resources.every((resource:string)=>['selfsubjectaccessreviews','selfsubjectrulesreviews','selfsubjectreviews'].includes(resource)) && rule.verbs.join(',') === 'create';
      requireSafe(pods || reviews,'OBSERVER');
    }
  }
  async deletePod(pod:KubeObject) {
    requireSafe(pod.metadata.name && pod.metadata.namespace && pod.metadata.uid && pod.metadata.resourceVersion,'OWNERSHIP');
    await this.command(['delete','--raw',`/api/v1/namespaces/${pod.metadata.namespace}/pods/${pod.metadata.name}`,'-f','-'],
      JSON.stringify({apiVersion:'v1',kind:'DeleteOptions',preconditions:{uid:pod.metadata.uid,resourceVersion:pod.metadata.resourceVersion}}));
  }
}
/** A Ready replacement is not a completed restart while the exact old Pod
 * still exists. In particular final pin checks must not race its termination. */
export function apiRestartReplacement(pods:KubeObject[],oldUid:string,replicas:Set<string>,pin:{container:string;digest:string}) {
  if(pods.some(item=>item.metadata.uid===oldUid))return;
  const owned=pods.filter(item=>item.metadata.ownerReferences?.some(owner=>replicas.has(owner.uid)));
  if(owned.length!==1)return;
  const item=owned[0]!;
  if(!item.metadata.deletionTimestamp&&item.status?.phase==='Running'&&
    item.status.containerStatuses?.some(container=>container.name===pin.container&&container.ready&&container.imageID?.endsWith(pin.digest)))return item;
}
/** Delete one exact observed API Pod only. No Deployment mutation, rollout
 * command, shell, exec or Secret access. The API image must remain pinned. */
export async function restartDashboardApi(live:LiveFoundation,fixture:{approveApiRestart:true;kubeconfig:string}) {
  requireSafe(fixture?.approveApiRestart === true && fixture.kubeconfig,'PREREQUISITE');
  const pin=live.config.expected.images.find(item=>item.deployment === 'ai-appliance-dashboard-api');requireSafe(pin,'PREREQUISITE');
  const restarter=new ServiceRestarter(fixture.kubeconfig,live.config.requestTimeoutMs);await restarter.verifyNamespace(pin.namespace);
  const deployment=await live.observer.get('deployments.apps',pin.namespace,pin.deployment);requireSafe(deployment?.metadata.uid,'IDENTITY');
  const replicas=await live.observer.list('replicasets.apps',pin.namespace),rs=new Set(replicas.filter(item=>item.metadata.ownerReferences?.some(owner=>owner.uid === deployment.metadata.uid))
    .map(item=>item.metadata.uid).filter((uid):uid is string=>Boolean(uid)));
  const candidates=(await live.observer.list('pods',pin.namespace)).filter(item=>item.metadata.ownerReferences?.some(owner=>rs.has(owner.uid)) && !item.metadata.deletionTimestamp);
  requireSafe(candidates.length === 1 && candidates[0]!.status?.containerStatuses?.some(item=>item.name === pin.container && item.ready && item.imageID?.includes(pin.digest)),'PREREQUISITE');
  const pod=candidates[0]!,podUid=pod.metadata.uid;requireSafe(podUid,'OWNERSHIP');
  const filename=join(process.env.REGRESSION_RUN_DIR!,'api-restart-'+randomUUID()+'.json');
  await writePrivate(filename,{version:1,namespace:pin.namespace,deploymentUid:deployment.metadata.uid,podUid:pod.metadata.uid,state:'requested'},true);
  await live.guard();await restarter.deletePod(pod);
  const replacement=await poll(async()=>{await live.guard();return apiRestartReplacement(await live.observer.list('pods',pin.namespace),podUid,rs,pin);},
    Boolean,{timeoutMs:300_000,intervalMs:1000,stage:'host-readiness'});
  await poll(async()=>{try{return (await live.api.session()).roles.includes('magicstick-admin');}catch{return false;}},Boolean,{timeoutMs:120_000,intervalMs:1000,stage:'login-session'});
  await writePrivate(filename,{version:1,namespace:pin.namespace,deploymentUid:deployment.metadata.uid,podUid:pod.metadata.uid,replacementUid:replacement!.metadata.uid,state:'verified'});
}
