import {expect,type Page} from '@playwright/test';
import type {AppInstance} from '@magicstick/dashboard-contracts';
import type {LiveFoundation} from './live-foundation.ts';
import type {ExactDashboardRequest} from './auth.ts';
import {AdministrationApi} from './administration-api.ts';
import {KubectlObserver,verifyObserverRules,type KubeObject} from './observer.ts';
import {requireSafe} from './errors.ts';
import {readPrivate} from './private-files.ts';
import {ownedJournalName,type JournalEntry} from './journal.ts';
import {poll} from './poll.ts';

export const appTypes=['openclaw','hermes','paperclip','kubeopencode','odysseus'] as const;
export type AppType=typeof appTypes[number];
export interface AppFixture {type:AppType; originTemplate:string; adapter?:'semantic-chat-v1'; promptLabel?:string; sendButton?:string; responseSelector?:string; responseMarker:string}
const resource='appinstances.appliance.magicstick.dev';

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
  readonly live:LiveFoundation;
  readonly cleaner:AppCleaner;
  constructor(live:LiveFoundation,cleaner:AppCleaner) {
    this.live=live;this.cleaner=cleaner;
    this.api=new AdministrationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard);
    live.registerDomainCleanup('app',{
      lookup:async entry=>{const item=await cleaner.find(entry.name);return item?.metadata.uid ? {uid:item.metadata.uid} : null;},
      removeIfUid:async(entry,uid)=>{requireSafe(entry.uid === uid,'OWNERSHIP');await cleaner.remove(entry,live.journal.prefix);},
      verifyRemoved:async entry=>{
        await poll(async()=>{await live.guard();const [item,pods,routes]=await Promise.all([cleaner.find(entry.name),live.observer.list('pods','ai'),
          live.observer.list('httproutes.gateway.networking.k8s.io','identity-system')]);
          return !item && !pods.some(p=>p.metadata.labels?.['appliance.magicstick.dev/appinstance'] === entry.name) &&
            !routes.some(route=>route.metadata.labels?.['appliance.magicstick.dev/appinstance'] === entry.name);
        },Boolean,{timeoutMs:300_000,intervalMs:1000,stage:'cleanup'});return true;
      },
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
    await this.live.journal.requested('app',name);
    await page.goto(this.live.config.dashboardUrl+'/#/services');
    await page.getByRole('button',{name:'Create Instance',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Create Instance',exact:true});
    await dialog.getByRole('combobox',{name:'Application',exact:true}).selectOption(type);
    await dialog.getByLabel('Name',{exact:true}).fill(requestedName);
    const modelField=dialog.getByRole('combobox',{name:type === 'paperclip' ? 'Default Model' : 'Model',exact:true});await modelField.selectOption(model);
    await expect(dialog.getByRole('combobox',{name:'Access',exact:true})).toHaveValue('sso');
    if(publicAccess) await dialog.getByRole('combobox',{name:'Access',exact:true}).selectOption('none');
    await dialog.getByRole('combobox',{name:'Exposure',exact:true}).selectOption('local');
    const responsePromise=page.waitForRequest(request=>request.method() === 'POST' && new URL(request.url()).pathname === '/api/instances/'+type);
    // Exact bytes come from the reviewed form (not arbitrary fixture JSON). The
    // form's create request is fenced by name/type/model/access/namespace below.
    let uses=0;
    const handler=async(route:import('@playwright/test').Route)=>{
      const request=route.request(),body=request.postDataJSON();
      requireSafe(++uses === 1 && request.method() === 'POST' && body.name === requestedName && body.model === model && body.namespace === 'ai' &&
        body.enabled === true && body.access.authentication === (publicAccess ? 'none' : 'sso') && body.access.exposure === 'local','MUTATION');
      await this.live.guard();await route.continue();
    };
    await page.route(this.live.config.dashboardUrl+'/api/instances/'+type,handler);
    try {await dialog.getByRole('button',{name:/^Create (?!Instance$)/}).click();await responsePromise;await expect(dialog).toHaveCount(0);}
    finally {await page.unroute(this.live.config.dashboardUrl+'/api/instances/'+type,handler);}
    const item=await poll(()=>this.read(name),value=>Boolean(value?.metadata?.uid),{timeoutMs:30_000,intervalMs:1000,stage:'model-update'});
    const observed=await this.cleaner.find(name);
    requireSafe(item?.metadata?.uid && observed?.metadata.uid === item.metadata.uid && item.metadata.generation === observed.metadata.generation,'OWNERSHIP');
    await this.live.journal.owned('app',name,item.metadata.uid,item.metadata.generation);
    this.owned.set(name,{uid:item.metadata.uid,generation:Number(item.metadata.generation)});
    requireSafe(item.spec?.application === type && item.spec?.targetNamespace === 'ai' && item.spec.values?.model === model &&
      item.spec.access?.authentication === (publicAccess ? 'none' : 'sso'),'API');return name;
  }
  async ready(name:string) {
    const owned=this.owned.get(name);requireSafe(owned,'OWNERSHIP');
    return poll(async()=>{await this.live.guard();const item=await this.read(name);const observed=await this.cleaner.find(name);
      requireSafe(item?.metadata?.uid === owned.uid && observed?.metadata.uid === owned.uid,'OWNERSHIP');
      const children=await this.live.observer.list('helmreleases.helm.toolkit.fluxcd.io','ai');
      return {item,observed,children:children.filter(child=>child.metadata.ownerReferences?.some(owner=>owner.uid === owned.uid) ||
        child.metadata.labels?.['appliance.magicstick.dev/appinstance'] === name)};
    },value=>value.item.status?.phase === 'Ready' && value.children.length > 0 && value.children.every(child=>child.status?.conditions?.some(c=>c.type === 'Ready' && c.status === 'True')),
    {timeoutMs:900_000,intervalMs:1500,stage:'model-ready'});
  }
  async remove(name:string) {await this.live.cleanup(this.live.journal,{kind:'app',name});}
  async removeInUi(page:Page,name:string) {
    const owned=this.owned.get(name),current=await this.cleaner.find(name);
    requireSafe(owned && current?.metadata.uid === owned.uid && current.metadata.generation === owned.generation,'OWNERSHIP');
    const handler=async(route:import('@playwright/test').Route)=>{
      requireSafe(route.request().method() === 'DELETE' && !route.request().postData(),'MUTATION');
      const fresh=await this.cleaner.find(name);requireSafe(fresh?.metadata.uid === owned.uid && fresh.metadata.generation === owned.generation,'OWNERSHIP');
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

export function ownedChild(item:KubeObject,name:string,uid:string) {
  return item.metadata.ownerReferences?.some(owner=>owner.uid === uid) || item.metadata.labels?.['appliance.magicstick.dev/appinstance'] === name;
}
