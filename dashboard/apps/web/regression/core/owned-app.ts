import {expect,type Page} from '@playwright/test';
import type {AppInstance} from '@magicstick/dashboard-contracts';
import type {LiveFoundation} from './live-foundation.ts';
import type {ExactDashboardRequest} from './auth.ts';
import {AdministrationApi} from './administration-api.ts';
import {KubectlObserver,verifyObserverRules,type KubeObject} from './observer.ts';
import {HarnessError,requireSafe,atStage} from './errors.ts';
import {bounded} from './run-lifecycle.ts';
import {readPrivate} from './private-files.ts';
import {ownedJournalName,type JournalEntry} from './journal.ts';
import {poll,currentReady} from './poll.ts';
import type {ApplicationAdapter} from './application-adapters.ts';
import {waitOpenCodeBackend} from './opencode-backend.ts';
import {AppRuntimeProof,appRuntimeAssociated} from './app-lifecycle.ts';
import {modulePodTemplateMatches} from './module-lifecycle.ts';
import {advanceNativeBinding,type NativeBinding,type NativeSchema} from './native-defaults.ts';

export const appTypes=['openclaw','hermes','paperclip','kubeopencode','pi-coding','odysseus'] as const;
export type AppType=typeof appTypes[number];
export interface AppFixture {type:AppType; originTemplate:string; adapter?:ApplicationAdapter; promptLabel?:string; sendButton?:string; responseSelector?:string; responseMarker:string}
const resource='appinstances.appliance.magicstick.dev';

/** The HelmRelease is a control-plane object. Its targetNamespace describes
 * chart workloads, not the namespace in which Flux stores the release. */
export function appReleaseTarget(item:AppInstance,name:string,applianceNamespace:string) {
  const status=item.status,hasTarget=Boolean(status?.kind || status?.name || status?.namespace);
  requireSafe(!hasTarget || status?.kind==='HelmRelease' && status.name===name && status.namespace===applianceNamespace,'OWNERSHIP');
  return {name,namespace:hasTarget ? String(status!.namespace) : applianceNamespace};
}

export function appReleaseReady(item:AppInstance,observed:KubeObject,children:KubeObject[],owned:{uid:string;generation:number},namespace:string) {
  requireSafe(item.metadata?.uid===owned.uid && item.metadata.generation===owned.generation &&
    observed.metadata.uid===owned.uid && observed.metadata.generation===owned.generation,'OWNERSHIP');
  const current=item.status?.observedGeneration===owned.generation && observed.status?.observedGeneration===owned.generation;
  if(current && ['Degraded','Failed'].includes(String(item.status?.phase)))throw new HarnessError('API','Failed','app-ready');
  return current && item.status?.phase==='Ready' && observed.status?.phase==='Ready' && children.length===1 && children.every(child=>
    child.metadata.namespace===namespace && child.metadata.name===item.metadata!.name &&
    child.metadata.labels?.['app.kubernetes.io/managed-by']==='magicstick-operator' &&
    child.metadata.labels?.['appliance.magicstick.dev/appinstance']===item.metadata!.name &&
    child.metadata.labels?.['appliance.magicstick.dev/application']===item.spec?.application &&
    !child.metadata.deletionTimestamp && child.spec?.suspend!==true && child.spec?.targetNamespace===item.spec?.targetNamespace &&
    typeof child.metadata.uid==='string' && Number.isSafeInteger(child.metadata.generation) &&
    currentReady(child,child.metadata.uid,Number(child.metadata.generation)));
}

/** Direct chart workloads (Pi and Odysseus) have no intermediate operator CR.
 * Inspect the Helm-owned Service, exact Deployment/ReplicaSet chain and real
 * Ready Pod rather than treating the accepted HelmRelease as application boot. */
export function directAppBackendReady(name:string,namespace:string,service:KubeObject|undefined,
  deployment:KubeObject|undefined,replicas:KubeObject[],pods:KubeObject[]) {
  if(!service||!deployment)return false;
  for(const item of [service,deployment])requireSafe(item.metadata.name===name&&item.metadata.namespace===namespace&&item.metadata.uid&&
    item.metadata.annotations?.['meta.helm.sh/release-name']===name&&item.metadata.annotations?.['meta.helm.sh/release-namespace']===namespace,'OWNERSHIP');
  const selector=service.spec?.selector as Record<string,string>|undefined;
  requireSafe(selector&&Object.keys(selector).length>0&&selector['app.kubernetes.io/instance']===name&&
    Object.values(selector).every(value=>typeof value==='string'&&value),'OWNERSHIP');
  const ownedRs=new Set(replicas.filter(item=>item.metadata.namespace===namespace&&item.metadata.ownerReferences?.some(owner=>
    owner.kind==='Deployment'&&owner.uid===deployment.metadata.uid)).map(item=>item.metadata.uid));
  const selected=pods.filter(item=>item.metadata.namespace===namespace&&Object.entries(selector).every(([key,value])=>item.metadata.labels?.[key]===value)&&
    !['Succeeded','Failed'].includes(item.status?.phase??''));
  requireSafe(selected.every(item=>item.metadata.ownerReferences?.some(owner=>owner.kind==='ReplicaSet'&&ownedRs.has(owner.uid))),'OWNERSHIP');
  const status=deployment.status as {observedGeneration?:number;replicas?:number;updatedReplicas?:number;readyReplicas?:number;availableReplicas?:number}|undefined;
  if(service.metadata.deletionTimestamp||deployment.metadata.deletionTimestamp||deployment.spec?.replicas!==1||
    status?.observedGeneration!==deployment.metadata.generation||status?.replicas!==1||status?.updatedReplicas!==1||status?.readyReplicas!==1||
    status?.availableReplicas!==1||selected.length!==1)return false;
  const pod=selected[0]!,template=deployment.spec?.template as {spec?:{containers?:Array<{name:string;image:string}>}}|undefined;
  const configured=template?.spec?.containers??[],actual=(pod.spec?.containers??[]) as Array<{name:string;image:string}>;
  requireSafe(configured.length>0&&configured.every(container=>container.image&&actual.some(candidate=>candidate.name===container.name&&candidate.image===container.image)),'REVISION');
  return !pod.metadata.deletionTimestamp&&pod.status?.phase==='Running'&&
    configured.every(container=>pod.status?.containerStatuses?.some(candidate=>candidate.name===container.name&&candidate.ready&&candidate.imageID))&&
    pod.status?.conditions?.some(condition=>condition.type==='Ready'&&condition.status==='True')===true;
}

async function waitDirectAppBackend(live:LiveFoundation,name:string,namespace:string) {
  return poll(async()=>{
    await live.guard();const [services,deployments,replicas,pods]=await Promise.all(['services','deployments.apps','replicasets.apps','pods']
      .map(resource=>live.observer.list(resource,namespace)));
    return directAppBackendReady(name,namespace,services!.find(item=>item.metadata.name===name),deployments!.find(item=>item.metadata.name===name),replicas!,pods!);
  },Boolean,{timeoutMs:300_000,intervalMs:1000,stage:'app-ready'});
}

type NativeApplication='openclaw'|'paperclip';
const nativeApplications={openclaw:{resource:'openclawinstances.openclaw.rocks',kind:'OpenClawInstance',port:18789},
  paperclip:{resource:'instances.paperclip.inc',kind:'Instance',port:3100}} as const;
function nativeInstanceIdentity(type:NativeApplication,name:string,namespace:string,item:KubeObject) {
  requireSafe(item.metadata.name===name&&item.metadata.namespace===namespace&&item.metadata.uid&&
    Number.isSafeInteger(item.metadata.generation)&&Number(item.metadata.generation)>0&&
    item.metadata.labels?.['app.kubernetes.io/name']===type&&
    item.metadata.labels?.['appliance.magicstick.dev/appinstance']===name&&
    item.metadata.labels?.['app.kubernetes.io/instance']===name&&
    item.metadata.annotations?.['meta.helm.sh/release-name']===name&&
    item.metadata.annotations?.['meta.helm.sh/release-namespace']===namespace,'OWNERSHIP');
  return {uid:item.metadata.uid,generation:Number(item.metadata.generation)};
}

/** Pinned native operator contracts: OpenClaw v0.40.0 and Paperclip v0.19.1.
 * A Ready HelmRelease merely created their CR. Bind that Helm-owned native CR,
 * its current Ready generation, Service and full workload/Pod owner chain. */
export function nativeAppBackendReady(type:NativeApplication,name:string,namespace:string,native:KubeObject|undefined,
  service:KubeObject|undefined,workload:KubeObject|undefined,replicas:KubeObject[],pods:KubeObject[],owned:{uid:string;generation:number}) {
  if(!native)return false;
  const identity=nativeInstanceIdentity(type,name,namespace,native);
  requireSafe(identity.uid===owned.uid&&identity.generation===owned.generation,'OWNERSHIP');
  const status=native.status as KubeObject['status']&{managedResources?:{service?:string;statefulSet?:string;deployment?:string}};
  const current=status?.observedGeneration===identity.generation;
  if(current&&['Failed','Degraded'].includes(status?.phase??''))throw new HarnessError('API','Failed','app-ready');
  const ready=status?.conditions?.find(condition=>condition.type==='Ready');
  // OpenClaw's pinned controller intentionally writes no per-Ready-condition
  // generation. Its global observedGeneration is mandatory; Paperclip has both.
  if(native.metadata.deletionTimestamp||native.spec?.suspended===true||!current||status?.phase!=='Running'||ready?.status!=='True'||
    (type==='paperclip'?ready.observedGeneration!==identity.generation:
      ready.observedGeneration!==undefined&&ready.observedGeneration!==0&&ready.observedGeneration!==identity.generation))return false;
  const kind=status.managedResources?.statefulSet===name?'StatefulSet':type==='paperclip'&&status.managedResources?.deployment===name?'Deployment':undefined;
  if(!kind||status.managedResources?.service!==name||!service||!workload)return false;
  const nativeKind=nativeApplications[type].kind;
  for(const item of [service,workload])requireSafe(item.metadata.name===name&&item.metadata.namespace===namespace&&item.metadata.uid&&
    item.metadata.ownerReferences?.some(owner=>owner.kind===nativeKind&&owner.uid===owned.uid&&owner.name===name&&owner.controller===true),'OWNERSHIP');
  const selector=service.spec?.selector as Record<string,string>|undefined;
  requireSafe(selector&&selector['app.kubernetes.io/instance']===name&&selector['app.kubernetes.io/name']===type&&
    Object.entries(selector).every(([key,value])=>key&&typeof value==='string'&&value)&&
    Array.isArray(service.spec?.ports)&&(service.spec.ports as Array<{port?:number}>).some(port=>port.port===nativeApplications[type].port),'API');
  const selected=pods.filter(pod=>pod.metadata.namespace===namespace&&Object.entries(selector).every(([key,value])=>pod.metadata.labels?.[key]===value));
  const rs=new Set(replicas.filter(replica=>replica.metadata.namespace===namespace&&replica.metadata.ownerReferences?.some(owner=>
    owner.kind==='Deployment'&&owner.uid===workload.metadata.uid&&owner.controller===true)).map(replica=>replica.metadata.uid));
  requireSafe(selected.every(pod=>pod.metadata.ownerReferences?.some(owner=>owner.controller===true&&
    (kind==='StatefulSet'?owner.kind==='StatefulSet'&&owner.uid===workload.metadata.uid:owner.kind==='ReplicaSet'&&rs.has(owner.uid)))),'OWNERSHIP');
  const rollout=workload.status as KubeObject['status']&{updatedReplicas?:number;availableReplicas?:number;currentReplicas?:number;currentRevision?:string;updateRevision?:string};
  if(service.metadata.deletionTimestamp||workload.metadata.deletionTimestamp||workload.spec?.replicas!==1||
    !Number.isSafeInteger(workload.metadata.generation)||Number(workload.metadata.generation)<1||
    rollout?.observedGeneration!==workload.metadata.generation||rollout.replicas!==1||rollout.readyReplicas!==1||rollout.updatedReplicas!==1||
    (kind==='StatefulSet'?rollout.currentReplicas!==1||!rollout.currentRevision||rollout.currentRevision!==rollout.updateRevision:rollout.availableReplicas!==1)||selected.length!==1)return false;
  const template=workload.spec?.template as {spec?:{containers?:Array<{name:string;image:string}>}}|undefined,
    configured=template?.spec?.containers??[],pod=selected[0]!,actual=pod.spec?.containers as Array<{name:string;image:string}>|undefined;
  const image=native.spec?.image as {repository?:string;digest?:string;tag?:string}|undefined,
    expected=image?.repository&&(image.digest?image.repository+'@'+image.digest:image.tag?image.repository+':'+image.tag:undefined);
  requireSafe(expected&&configured.some(container=>container.name===type&&container.image===expected)&&actual&&configured.length===actual.length&&
    configured.every(container=>container.image&&actual.some(candidate=>candidate.name===container.name&&candidate.image===container.image))&&
    template?.spec&&modulePodTemplateMatches(template.spec,pod.spec),'REVISION');
  return Boolean(pod.metadata.uid&&!pod.metadata.deletionTimestamp&&pod.status?.phase==='Running'&&
    pod.status.conditions?.some(condition=>condition.type==='Ready'&&condition.status==='True')&&
    configured.every(container=>pod.status?.containerStatuses?.some(status=>status.name===container.name&&status.ready&&status.imageID)));
}

export async function waitNativeAppBackend(live:LiveFoundation,type:NativeApplication,name:string,namespace:string,identities:Map<string,NativeBinding>) {
  const resource=nativeApplications[type].resource;
  const catalog=(await live.api.modules()).catalogJson?.applications?.[type];
  requireSafe(Array.isArray(catalog?.requiredCrds)&&catalog.requiredCrds.includes(resource),'CONFIG');
  const crdResource='customresourcedefinitions.apiextensions.k8s.io';
  const readSchema=async()=>{
    await live.guard();const crd=await live.observer.get(crdResource,undefined,resource);
    const versions=crd.spec?.versions as Array<{name?:string;served?:boolean;schema?:{openAPIV3Schema?:{properties?:{spec?:NativeSchema}}}}> | undefined;
    const names=crd.spec?.names as {kind?:string}|undefined;
    const schema=versions?.find(version=>version.name==='v1alpha1'&&version.served===true)?.schema?.openAPIV3Schema?.properties?.spec;
    requireSafe(crd.metadata.name===resource&&crd.metadata.uid&&Number.isSafeInteger(crd.metadata.generation)&&
      Number(crd.metadata.generation)>0&&crd.spec?.group===resource.split('.').slice(1).join('.')&&
      names?.kind===nativeApplications[type].kind&&schema?.type==='object'&&schema.properties,'CONFIG');
    return {uid:crd.metadata.uid,generation:Number(crd.metadata.generation),schema};
  };
  const pinnedSchema=await readSchema();
  const verifySchema=async()=>{const current=await readSchema();requireSafe(current.uid===pinnedSchema.uid&&
    current.generation===pinnedSchema.generation,'CONFLICT');};
  const result=await poll(async()=>{
    await live.guard();
    const [instances,services,statefulsets,deployments,replicas,pods]=await Promise.all([resource,'services','statefulsets.apps','deployments.apps','replicasets.apps','pods']
      .map(resource=>live.observer.list(resource,namespace)));
    const native=instances!.find(item=>item.metadata.name===name);if(!native)return false;
    const observed=nativeInstanceIdentity(type,name,namespace,native),previous=identities.get(name);
    requireSafe(native.spec&&typeof native.spec==='object','CONFIG');
    if(previous&&observed.generation!==previous.generation)await verifySchema();
    const binding=advanceNativeBinding(previous,{...observed,spec:native.spec,observedGeneration:native.status?.observedGeneration},pinnedSchema.schema);
    if(!binding)return false;
    identities.set(name,binding);
    const managed=(native.status as {managedResources?:{statefulSet?:string;deployment?:string}})?.managedResources;
    const workloads=managed?.statefulSet===name?statefulsets!:managed?.deployment===name?deployments!:[];
    return nativeAppBackendReady(type,name,namespace,native,services!.find(item=>item.metadata.name===name),
      workloads.find(item=>item.metadata.name===name),replicas!,pods!,binding);
  },Boolean,{timeoutMs:900_000,intervalMs:1500,stage:'app-ready'});
  await verifySchema();return result;
}

export function verifyAppCleanerRules(review:{status?:{incomplete?:boolean;resourceRules?:Array<{apiGroups:string[];resources:string[];verbs:string[]}>}}) {
  requireSafe(review.status?.incomplete === false && Array.isArray(review.status.resourceRules),'OBSERVER');
  let canDelete=false;
  for(const rule of review.status.resourceRules) {
    const app=rule.apiGroups.length === 1 && rule.apiGroups[0] === 'appliance.magicstick.dev' &&
      rule.resources.length === 1 && rule.resources[0] === 'appinstances';
    const self=rule.apiGroups.every(group=>['authorization.k8s.io','authentication.k8s.io'].includes(group)) &&
      rule.resources.every(value=>['selfsubjectaccessreviews','selfsubjectrulesreviews','selfsubjectreviews'].includes(value));
    requireSafe(app && rule.verbs.every(verb=>['get','list','delete'].includes(verb)) || self && rule.verbs.every(verb=>verb === 'create'),'OBSERVER');
    if(app && rule.verbs.some(verb=>String(verb) === 'delete')) canDelete=true;
  }
  requireSafe(canDelete,'OBSERVER');
}
/** Separate narrowly scoped deletion credential. Product UI/API still performs
 * creation and sharing; cleanup atomically binds UID and resourceVersion. */
export class AppCleaner extends KubectlObserver {
  override async verifyConfiguration() {
    await readPrivate(this.kubeconfig);
    const configuration=JSON.parse(await this.command(['config','view','--raw','--minify','-o','json']));
    const cluster=configuration.clusters?.[0]?.cluster,user=configuration.users?.[0]?.user;
    requireSafe(cluster?.server?.startsWith('https://') && !cluster['insecure-skip-tls-verify'] && user && !user.exec && !user['auth-provider'],'OBSERVER');
    verifyAppCleanerRules(JSON.parse(await this.command(['create','--raw','/apis/authorization.k8s.io/v1/selfsubjectrulesreviews','-f','-'],
      JSON.stringify({apiVersion:'authorization.k8s.io/v1',kind:'SelfSubjectRulesReview',spec:{namespace:'ai-system'}}))));
    for(const namespace of ['default','ai','identity-system','flux-system','magicstick-regression'])
      verifyObserverRules(JSON.parse(await this.command(['create','--raw','/apis/authorization.k8s.io/v1/selfsubjectrulesreviews','-f','-'],
        JSON.stringify({apiVersion:'authorization.k8s.io/v1',kind:'SelfSubjectRulesReview',spec:{namespace}}))));
  }
  async find(name:string) {return (await this.list(resource,'ai-system')).find(item=>item.metadata.name === name) ?? null;}
  async remove(entry:JournalEntry,prefix:string) {
    requireSafe(entry.kind === 'app' && ownedJournalName('app',entry.name,prefix) && entry.uid && entry.generation,'OWNERSHIP');
    const current=await this.find(entry.name);
    requireSafe(current?.metadata.uid === entry.uid && current.metadata.generation === entry.generation && current.metadata.resourceVersion &&
      current.metadata.labels?.['app.kubernetes.io/managed-by'] === 'ai-appliance-dashboard' && current.spec?.targetNamespace === 'ai','OWNERSHIP');
    const options={apiVersion:'v1',kind:'DeleteOptions',preconditions:{uid:entry.uid,resourceVersion:current.metadata.resourceVersion}};
    await this.command(['delete','--raw',`/apis/appliance.magicstick.dev/v1alpha1/namespaces/ai-system/appinstances/${entry.name}`,'-f','-'],JSON.stringify(options));
  }
}

export class OwnedAppClient {
  readonly api:AdministrationApi;
  readonly permits:ExactDashboardRequest[]=[];
  private readonly owned=new Map<string,{uid:string;generation:number}>();
  private readonly native=new Map<string,NativeBinding>();
  readonly live:LiveFoundation;
  readonly cleaner:AppCleaner;
  readonly runtime:AppRuntimeProof;
  constructor(live:LiveFoundation,cleaner:AppCleaner) {
    this.live=live;this.cleaner=cleaner;
    this.api=new AdministrationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard);
    this.runtime=new AppRuntimeProof(live,name=>cleaner.find(name),()=>this.api.api.modules());
    live.registerDomainCleanup('app',{
      lookup:async entry=>{const item=await cleaner.find(entry.name);return item?.metadata.uid ? {uid:item.metadata.uid} : null;},
      removeIfUid:async(entry,uid)=>{requireSafe(entry.uid === uid,'OWNERSHIP');await this.runtime.capture(entry);await cleaner.remove(entry,live.journal.prefix);},
      verifyRemoved:entry=>this.runtime.verifyRemoved(entry),
    });
  }
  async read(name:string):Promise<AppInstance|undefined> {
    const matches=Object.values((await this.api.api.instances()).instances).flat().filter(item=>item.metadata?.name === name);
    requireSafe(matches.length <= 1,'OWNERSHIP');return matches[0];
  }
  async createInUi(page:Page,type:AppType,suffix:string,model:string,publicAccess=false) {
    requireSafe(appTypes.includes(type) && model.startsWith(this.live.journal.prefix),'OWNERSHIP');
    const requestedName=this.live.journal.prefix+suffix,name=type+'-'+requestedName;
    requireSafe(!await this.read(name) && !await this.cleaner.find(name),'OWNERSHIP');
    const modules=await this.api.api.modules(),required=modules.catalogJson?.applications?.[type]?.requiredModules;
    requireSafe(required?.length && required.every(id=>modules.modules[id]?.enabled && modules.modules[id]?.status?.phase==='Ready'),'PREREQUISITE');
    await page.goto(this.live.config.dashboardUrl+'/#/services');
    await page.getByRole('button',{name:'Create Instance',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Create Instance',exact:true});
    const application=dialog.getByRole('combobox',{name:'Application',exact:true});
    const available=await application.locator('option').evaluateAll((options,type)=>options.some(option=>
      (option as HTMLOptionElement).value===type&&!(option as HTMLOptionElement).disabled),type);
    requireSafe(available,'CAPABILITY');await application.selectOption(type);
    await dialog.getByLabel('Name',{exact:true}).fill(requestedName);
    const modelField=dialog.getByRole('combobox',{name:type === 'paperclip' ? 'Default Model' : 'Model',exact:true});await modelField.selectOption(model);
    await expect(dialog.getByRole('combobox',{name:'Access',exact:true})).toHaveValue('sso');
    if(publicAccess) await dialog.getByRole('combobox',{name:'Access',exact:true}).selectOption('none');
    await dialog.getByRole('combobox',{name:'Exposure',exact:true}).selectOption('local');
    const item=await this.submitCreate(page,type,requestedName,model,publicAccess,()=>dialog.getByRole('button',{name:/^Create (?!Instance$)/}).click());
    await expect(dialog).toHaveCount(0);
    const observed=await this.cleaner.find(name);
    requireSafe(item?.metadata?.uid&&observed?.metadata.uid===item.metadata.uid&&item.metadata.generation===observed.metadata.generation,'OWNERSHIP');
    requireSafe(item.spec?.application === type && item.spec?.targetNamespace === 'ai' && item.spec.values?.model === model &&
      item.spec.access?.authentication === (publicAccess ? 'none' : 'sso'),'API');return name;
  }
  /** Acknowledged identity is durable before any later UI/observer assertion. */
  async submitCreate(page:Page,type:AppType,requestedName:string,model:string,publicAccess:boolean,action:()=>Promise<void>) {
    const name=type+'-'+requestedName;
    requireSafe(appTypes.includes(type)&&ownedJournalName('app',name,this.live.journal.prefix)&&model.startsWith(this.live.journal.prefix),'OWNERSHIP');
    // Exact bytes come from the reviewed form (not arbitrary fixture JSON). The
    // form's create request is fenced by name/type/model/access/namespace below.
    let uses=0,forwarded=false,deny:(error:unknown)=>void=()=>{};
    const denied=new Promise<never>((_resolve,reject)=>{deny=reject;});
    const handler=async(route:import('@playwright/test').Route)=>{
      try {
      const request=route.request(),body=request.postDataJSON();
      requireSafe(++uses === 1 && request.method() === 'POST' && body.name === requestedName && body.model === model && body.namespace === 'ai' &&
        body.enabled === true && body.access.authentication === (publicAccess ? 'none' : 'sso') && body.access.exposure === 'local','MUTATION');
      await this.live.guard();
      // Form preparation is read-only. Journal only the exact fenced request
      // immediately before forwarding, never merely opening a disabled form.
      await this.live.journal.requested('app',name);forwarded=true;await route.continue();
      }catch(error){deny(error);await route.abort('blockedbyclient').catch(()=>{});}
    };
    await page.route(this.live.config.dashboardUrl+'/api/instances/'+type,handler);
    let item:AppInstance|undefined;
    try {await bounded(async()=>{
      const receipt=page.waitForResponse(response=>response.request().method()==='POST' &&
        response.url()===this.live.config.dashboardUrl+'/api/instances/'+type,{timeout:this.live.config.requestTimeoutMs}).then(async response=>{
        if(!response.ok()) {
          if([400,401,403,404,409,422].includes(response.status())&&!await this.read(name)&&!await this.cleaner.find(name))
            await this.live.journal.rejected('app',name);
          throw new HarnessError('API','Failed','model-create');
        }
        const value=await response.json() as AppInstance;
        requireSafe(value?.metadata?.name===name&&value.metadata.namespace==='ai-system'&&value.metadata.uid&&
          Number.isSafeInteger(value.metadata.generation)&&Number(value.metadata.generation)>0,'OWNERSHIP');
        await this.live.journal.owned('app',name,value.metadata.uid,value.metadata.generation);
        this.owned.set(name,{uid:value.metadata.uid,generation:Number(value.metadata.generation)});item=value;
      });
      const click=action().catch(async error=>{
        if(forwarded)await receipt.catch(()=>{});throw error;
      });
      await Promise.race([Promise.all([receipt,click]),denied]);
    },this.live.config.requestTimeoutMs+1000,'model-create',()=>page.close());}
    catch(error){await page.close().catch(()=>{});throw error;}
    finally {if(!page.isClosed())await page.unroute(this.live.config.dashboardUrl+'/api/instances/'+type,handler);}
    requireSafe(item,'API');return item;
  }
  async ready(name:string) {
    const owned=this.owned.get(name);requireSafe(owned,'OWNERSHIP');
    const ready=await atStage('app-ready',()=>poll(async()=>{await this.live.guard();const item=await this.read(name);const observed=await this.cleaner.find(name);
      requireSafe(item && observed,'OWNERSHIP');
      const target=appReleaseTarget(item,name,this.live.config.expected.applianceNamespace);
      const children=await this.live.observer.list('helmreleases.helm.toolkit.fluxcd.io',target.namespace);
      return {item,observed,target,children:children.filter(child=>child.metadata.name===target.name)};
    },value=>appReleaseReady(value.item,value.observed,value.children,owned,value.target.namespace),
    // Helm has a 15 minute cold-install budget; allow chart reconciliation
    // and status propagation beyond that without treating acceptance as Ready.
    {timeoutMs:1_200_000,intervalMs:1500,stage:'app-ready'}));
    if(ready.item.spec?.application==='kubeopencode')await atStage('app-ready',()=>
      waitOpenCodeBackend(this.live,name,String(ready.item.spec?.targetNamespace)));
    if(['pi-coding','odysseus'].includes(String(ready.item.spec?.application)))await atStage('app-ready',()=>
      waitDirectAppBackend(this.live,name,String(ready.item.spec?.targetNamespace)));
    if(ready.item.spec?.application==='openclaw'||ready.item.spec?.application==='paperclip')await atStage('app-ready',()=>
      waitNativeAppBackend(this.live,ready.item.spec!.application as NativeApplication,name,String(ready.item.spec?.targetNamespace),this.native));
    return ready;
  }
  async remove(name:string) {await this.live.cleanup(this.live.journal,{kind:'app',name});}
  async removeInUi(page:Page,name:string) {
    const owned=this.owned.get(name),current=await this.cleaner.find(name);
    requireSafe(owned && current?.metadata.uid === owned.uid && current.metadata.generation === owned.generation,'OWNERSHIP');
    const handler=async(route:import('@playwright/test').Route)=>{
      requireSafe(route.request().method() === 'DELETE' && !route.request().postData(),'MUTATION');
      const fresh=await this.cleaner.find(name);requireSafe(fresh?.metadata.uid === owned.uid && fresh.metadata.generation === owned.generation,'OWNERSHIP');
      await this.runtime.capture({kind:'app',name,uid:owned.uid,generation:owned.generation,state:'owned'});
      await this.live.guard();await route.continue();
    };
    const path=this.live.config.dashboardUrl+'/api/instances/'+name;
    await page.route(path,handler);
    try {
      await page.locator('article.service-instance').filter({hasText:name}).getByRole('button',{name:'Remove',exact:true}).click();
      await page.getByRole('dialog',{name:'Remove instance',exact:true}).getByRole('button',{name:'Remove',exact:true}).click();
      await poll(()=>this.cleaner.find(name),item=>!item,{timeoutMs:300_000,intervalMs:1000,stage:'cleanup'});
      await this.remove(name);
    }finally{await page.unroute(path,handler);}
  }
  async recordGeneration(name:string) {
    const previous=this.owned.get(name),current=await this.cleaner.find(name);requireSafe(previous && current?.metadata.uid === previous.uid,'OWNERSHIP');
    if(current.metadata.generation !== previous.generation) {
      requireSafe(Number.isSafeInteger(current.metadata.generation) && Number(current.metadata.generation) > previous.generation,'OWNERSHIP');
      await this.live.journal.generation('app',name,previous.uid,previous.generation,Number(current.metadata.generation));
      previous.generation=Number(current.metadata.generation);
    }
  }
}

/** Read-only absence predicate, never an adoption/deletion rule. The direct
 * chart's standard instance/Helm labels differ from its AppInstance label.
 * Even a changed same-name resource fences cleanup rather than being removed. */
export function appResourceAssociated(item:KubeObject,name:string,uid:string) {
  return appRuntimeAssociated(item,name,uid);
}

export function ownedChild(item:KubeObject,name:string,uid:string) {
  return item.metadata.ownerReferences?.some(owner=>owner.uid === uid) || item.metadata.labels?.['appliance.magicstick.dev/appinstance'] === name;
}
