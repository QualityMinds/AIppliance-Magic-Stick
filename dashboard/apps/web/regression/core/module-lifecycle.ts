import type {KubeObject} from './observer.ts';
import {requireProof as requireSafe} from './errors.ts';
import {canonical} from './borrowed-sharing.ts';

/** Read-only runtime proof. Flux metadata identifies the module's root objects;
 * controller owner UIDs identify its descendants. A name prefix is not ownership. */
export const moduleRuntimeResources = ['deployments.apps','statefulsets.apps','daemonsets.apps',
  'replicasets.apps','jobs.batch','pods','services','httproutes.gateway.networking.k8s.io',
  'securitypolicies.gateway.envoyproxy.io','referencegrants.gateway.networking.k8s.io','configmaps',
  'helmreleases.helm.toolkit.fluxcd.io','persistentvolumeclaims'] as const;
export type ModuleRuntimeResource = typeof moduleRuntimeResources[number];
export interface ModuleRuntimeObject {resource:ModuleRuntimeResource;object:KubeObject}
const objectKey=(item:ModuleRuntimeObject)=>[item.resource,item.object.metadata.namespace,item.object.metadata.name].join('/');
const fluxOwned=(object:KubeObject,name:string,namespace:string)=>
  object.metadata.labels?.['kustomize.toolkit.fluxcd.io/name']===name &&
  object.metadata.labels?.['kustomize.toolkit.fluxcd.io/namespace']===namespace;

export function moduleRuntimeInventory(objects:readonly ModuleRuntimeObject[],kustomizationName:string,namespace='flux-system',kustomization?:KubeObject) {
  requireSafe(/^[a-z0-9][a-z0-9-]{0,62}$/.test(kustomizationName),'CONFIG');
  const owned=objects.filter(item=>fluxOwned(item.object,kustomizationName,namespace));
  const missingWorkloads:string[]=[],requiredKinds=new Set(['Deployment','StatefulSet','DaemonSet','Job','Pod','HelmRelease']);
  let inventoryReady=true;
  // Helm does not place the HelmRelease UID on every generated object. Its
  // observed inventory plus exact release annotations supply that read-only
  // attribution; a similar release-name prefix never does.
  const kinds:Partial<Record<ModuleRuntimeResource,string>>={'deployments.apps':'Deployment','statefulsets.apps':'StatefulSet',
    'daemonsets.apps':'DaemonSet','replicasets.apps':'ReplicaSet','jobs.batch':'Job',pods:'Pod',services:'Service',
    'httproutes.gateway.networking.k8s.io':'HTTPRoute','persistentvolumeclaims':'PersistentVolumeClaim',configmaps:'ConfigMap',
    'helmreleases.helm.toolkit.fluxcd.io':'HelmRelease'};
  const inventoryEntries=(source:KubeObject)=>{
    const status=source.status as typeof source.status&{inventory?:{entries?:Array<{id:string}>}};
    if(!Array.isArray(status?.inventory?.entries)){inventoryReady=false;return [];}
    return status.inventory.entries;
  };
  const expected=(source:KubeObject,helm?:{name:string;namespace:string})=>{
    for(const entry of inventoryEntries(source)) {
      requireSafe(typeof entry.id==='string','API');const fields=entry.id.split('_');
      requireSafe(fields.length===4,'API');const [ns,name,group,kind]=fields;
      const resource=(Object.entries(kinds) as Array<[ModuleRuntimeResource,string]>).find(([resource,value])=>
        value===kind&&resource.split('.').slice(1).join('.')===group)?.[0];
      if(!resource)continue;
      const found=objects.find(item=>item.resource===resource&&item.object.metadata.namespace===ns&&item.object.metadata.name===name);
      if(!found){if(requiredKinds.has(kind!))missingWorkloads.push(entry.id);continue;}
      requireSafe(helm?found.object.metadata.annotations?.['meta.helm.sh/release-name']===helm.name&&
        found.object.metadata.annotations?.['meta.helm.sh/release-namespace']===helm.namespace:
        fluxOwned(found.object,kustomizationName,namespace),'OWNERSHIP');
      if(!owned.includes(found))owned.push(found);
    }
  };
  if(kustomization) {
    requireSafe(kustomization.metadata.name===kustomizationName&&kustomization.metadata.namespace===namespace&&kustomization.metadata.uid,'OWNERSHIP');
    const ready=kustomization.status?.conditions?.find(condition=>condition.type==='Ready');
    if(ready?.status!=='True'||(ready.observedGeneration??kustomization.status?.observedGeneration)!==kustomization.metadata.generation)inventoryReady=false;
    expected(kustomization);
  }
  const checkedReleases=new Set<string>();
  for(;;) {
    const release=owned.find(item=>item.resource==='helmreleases.helm.toolkit.fluxcd.io'&&!checkedReleases.has(item.object.metadata.uid!));
    if(!release)break;requireSafe(release.object.metadata.uid,'OWNERSHIP');checkedReleases.add(release.object.metadata.uid);
    const status=release.object.status as typeof release.object.status&{inventory?:{entries?:Array<{id:string}>};history?:Array<{name:string;namespace:string;status:string}>};
    const latest=status?.history?.[0];
    if(!latest||latest.status!=='deployed'){inventoryReady=false;continue;}
    expected(release.object,latest);
  }
  const uids=new Set(owned.map(item=>item.object.metadata.uid));
  // Deployment -> ReplicaSet -> Pod, StatefulSet -> Pod, HelmRelease-owned
  // resources etc. Iterate to closure, not just one descendant level.
  for(let changed=true;changed;) {
    changed=false;
    for(const item of objects)if(!owned.includes(item)&&item.object.metadata.ownerReferences?.some(owner=>uids.has(owner.uid))) {
      owned.push(item);uids.add(item.object.metadata.uid);changed=true;
    }
  }
  requireSafe(owned.every(item=>item.object.metadata.uid&&item.object.metadata.name&&item.object.metadata.namespace),'OWNERSHIP');
  const persistent=owned.filter(item=>item.resource==='persistentvolumeclaims');
  return {runtime:owned.filter(item=>item.resource!=='persistentvolumeclaims'),persistent,missingWorkloads,inventoryReady};
}

/** Ignore only the API server's canonical ServiceAccount projection. Intended
 * container image/command/env and every declared volume/mount remain exact. */
export function modulePodTemplateMatches(expected:Record<string,unknown>,actual:Record<string,unknown>|undefined) {
  if(!actual)return false;const observed=structuredClone(actual),intendedVolumes=(expected.volumes??[]) as Array<{name?:string}>;
  const volumes=(observed.volumes??[]) as Array<Record<string,any>>,injected=new Set<string>();
  for(const volume of volumes)if(typeof volume.name==='string'&&/^kube-api-access-[a-z0-9]{5}$/.test(volume.name)&&
    !intendedVolumes.some(item=>item.name===volume.name)) {
    const projection=volume.projected,sources=projection?.sources;
    const valid=Object.keys(volume).sort().join(',')==='name,projected'&&projection&&Object.keys(projection).sort().join(',')==='defaultMode,sources'&&
      projection.defaultMode===420&&Array.isArray(sources)&&sources.length===3&&
      sources.every((source:any)=>source&&Object.keys(source).length===1)&&
      sources.some((source:any)=>source.serviceAccountToken&&Object.keys(source.serviceAccountToken).sort().join(',')==='expirationSeconds,path'&&
        Number.isSafeInteger(source.serviceAccountToken.expirationSeconds)&&source.serviceAccountToken.expirationSeconds>=600&&source.serviceAccountToken.path==='token')&&
      sources.some((source:any)=>canonical(source.configMap)===canonical({name:'kube-root-ca.crt',items:[{key:'ca.crt',path:'ca.crt'}]}))&&
      sources.some((source:any)=>canonical(source.downwardAPI)===canonical({items:[{path:'namespace',fieldRef:{apiVersion:'v1',fieldPath:'metadata.namespace'}}]}));
    if(!valid)return false;injected.add(volume.name);
  }
  if(injected.size>1)return false;
  observed.volumes=volumes.filter(volume=>!injected.has(volume.name));
  for(const field of ['containers','initContainers'])for(const container of (observed[field]??[]) as Array<Record<string,any>>) {
    if(!Array.isArray(container.volumeMounts))continue;
    for(const mount of container.volumeMounts)if(injected.has(mount.name)&&
      (Object.keys(mount).sort().join(',')!=='mountPath,name,readOnly'||mount.mountPath!=='/var/run/secrets/kubernetes.io/serviceaccount'||mount.readOnly!==true))return false;
    container.volumeMounts=container.volumeMounts.filter((mount:any)=>!injected.has(mount.name));
  }
  const matches=(expected:unknown,actual:unknown):boolean=>Array.isArray(expected)?Array.isArray(actual)&&expected.length===actual.length&&
    expected.every((value,index)=>matches(value,actual[index])):expected!==null&&typeof expected==='object'?
    Boolean(actual&&typeof actual==='object'&&Object.entries(expected).every(([key,value])=>matches(value,(actual as Record<string,unknown>)[key]))):expected===actual;
  return matches(expected,observed);
}
export function moduleInstallationObserved(inventory:ReturnType<typeof moduleRuntimeInventory>) {
  if(!inventory.inventoryReady||inventory.missingWorkloads.length)return false;
  return inventory.runtime.every(({resource,object})=>{
    if(object.metadata.deletionTimestamp)return false;
    if(resource==='pods')return object.status?.phase==='Succeeded'||object.status?.phase==='Running'&&
      object.status.conditions?.some(condition=>condition.type==='Ready'&&condition.status==='True');
    if(['deployments.apps','statefulsets.apps'].includes(resource)) {
      const status=object.status as (KubeObject['status']&{updatedReplicas?:number;availableReplicas?:number;currentReplicas?:number;
        currentRevision?:string;updateRevision?:string})|undefined,desired=object.spec?.replicas??1;
      const template=object.spec?.template as {spec?:Record<string,unknown>;metadata?:{labels?:Record<string,string>}}|undefined;
      if(status?.observedGeneration!==object.metadata.generation||!Number.isSafeInteger(desired)||Number(desired)<0||
        status?.replicas!==desired||status.updatedReplicas!==desired||status.readyReplicas!==desired||status.availableReplicas!==desired||!template?.spec)return false;
      const owners=new Set(resource==='deployments.apps'?inventory.runtime.filter(item=>item.resource==='replicasets.apps'&&
        item.object.metadata.ownerReferences?.some(owner=>owner.uid===object.metadata.uid)).map(item=>item.object.metadata.uid):[object.metadata.uid]);
      const pods=inventory.runtime.filter(item=>item.resource==='pods'&&item.object.metadata.ownerReferences?.some(owner=>owners.has(owner.uid)))
        .map(item=>item.object).filter(pod=>!['Succeeded','Failed'].includes(pod.status?.phase??''));
      if(resource==='statefulsets.apps'&&(!status.currentRevision||status.currentRevision!==status.updateRevision||status.currentReplicas!==desired))return false;
      return pods.length===desired&&pods.every(pod=>!pod.metadata.deletionTimestamp&&pod.status?.phase==='Running'&&
        pod.status.conditions?.some(condition=>condition.type==='Ready'&&condition.status==='True')&&modulePodTemplateMatches(template.spec!,pod.spec)&&
        Object.entries(template.metadata?.labels??{}).every(([key,value])=>pod.metadata.labels?.[key]===value)&&
        (resource!=='statefulsets.apps'||pod.metadata.labels?.['controller-revision-hash']===status.updateRevision)&&
        (template.spec!.containers as Array<{name?:string}>|undefined)?.every(container=>
          pod.status?.containerStatuses?.some(actual=>actual.name===container.name&&actual.ready&&actual.imageID)));
    }
    if(resource==='daemonsets.apps') {
      const status=object.status as (KubeObject['status']&{desiredNumberScheduled?:number;currentNumberScheduled?:number;
        updatedNumberScheduled?:number;numberReady?:number;numberAvailable?:number;numberUnavailable?:number})|undefined;
      const desired=status?.desiredNumberScheduled;
      return status?.observedGeneration===object.metadata.generation&&Number.isSafeInteger(desired)&&Number(desired)>=0&&
        status?.currentNumberScheduled===desired&&status?.updatedNumberScheduled===desired&&status?.numberReady===desired&&
        status?.numberAvailable===desired&&Number(status?.numberUnavailable??0)===0;
    }
    if(resource==='jobs.batch') {
      // batch/v1 JobStatus has no observedGeneration. Require the current
      // immutable template on successful UID-owned Pods, not a made-up status
      // field or an old Complete condition alone.
      const template=object.spec?.template as {spec?:Record<string,unknown>;metadata?:{labels?:Record<string,string>}}|undefined;
      const pods=inventory.runtime.filter(item=>item.resource==='pods'&&item.object.metadata.ownerReferences?.some(owner=>owner.uid===object.metadata.uid))
        .map(item=>item.object),completions=object.spec?.completions??1;
      return Number.isSafeInteger(completions)&&Number(completions)>0&&object.spec?.suspend!==true&&Number(object.status?.active??0)===0&&
        object.status?.conditions?.some(condition=>condition.type==='Complete'&&condition.status==='True')===true&&
        !object.status.conditions.some(condition=>['Failed','FailureTarget','Suspended'].includes(condition.type)&&condition.status==='True')&&
        Number(object.status.succeeded??0)>=Number(completions)&&Boolean(template?.spec)&&
        pods.filter(pod=>!pod.metadata.deletionTimestamp&&pod.status?.phase==='Succeeded'&&modulePodTemplateMatches(template!.spec!,pod.spec)&&
          Object.entries(template?.metadata?.labels??{}).every(([key,value])=>pod.metadata.labels?.[key]===value)&&
          pod.status.containerStatuses?.length&&pod.status.containerStatuses.every(container=>container.state?.terminated?.exitCode===0)).length>=Number(completions);
    }
    if(resource==='helmreleases.helm.toolkit.fluxcd.io')return object.status?.observedGeneration===object.metadata.generation&&
      object.status?.conditions?.some(condition=>condition.type==='Ready'&&condition.status==='True');
    return true;
  });
}

/** Disable acceptance is independent of the module status label. Expected
 * retained data is verified separately and is never called runtime cleanup. */
export function moduleRemovalObserved(before:ReturnType<typeof moduleRuntimeInventory>,current:readonly ModuleRuntimeObject[],
  kustomizationName:string,keepData:boolean) {
  const after=moduleRuntimeInventory(current,kustomizationName);
  for(const item of [...before.runtime,...before.persistent]) {
    const sameName=current.find(candidate=>objectKey(candidate)===objectKey(item));
    requireSafe(!sameName||sameName.object.metadata.uid===item.object.metadata.uid||before.runtime.some(known=>
      objectKey(known)===objectKey(sameName)&&known.object.metadata.uid===sameName.object.metadata.uid),'OWNERSHIP');
  }
  if(keepData)for(const item of before.persistent) {
    const retained=after.persistent.find(candidate=>objectKey(candidate)===objectKey(item));
    requireSafe(retained&&retained.object.metadata.uid===item.object.metadata.uid&&!retained.object.metadata.deletionTimestamp,'CLEANUP');
  }
  const beforeUids=new Set([...before.runtime,...(keepData?[]:before.persistent)].map(item=>item.object.metadata.uid));
  for(let changed=true;changed;) {
    changed=false;for(const item of current)if(!beforeUids.has(item.object.metadata.uid)&&
      item.object.metadata.ownerReferences?.some(owner=>beforeUids.has(owner.uid))) {
      beforeUids.add(item.object.metadata.uid);changed=true;
    }
  }
  return after.runtime.length===0&&(keepData||after.persistent.length===0)&&!current.some(item=>beforeUids.has(item.object.metadata.uid));
}

export async function observeModuleRuntime(observer:{list:(resource:string)=>Promise<KubeObject[]>}) {
  return (await Promise.all(moduleRuntimeResources.map(async resource=>
    (await observer.list(resource)).map(object=>({resource,object}))))).flat();
}
