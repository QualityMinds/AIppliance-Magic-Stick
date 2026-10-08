import type {BrowserContext} from '@playwright/test';
import {join} from 'node:path';
import {AdministrationApi} from './administration-api.ts';
import {KubectlObserver,KubernetesLeaseStore,type KubeObject} from './observer.ts';
import {KubernetesModelCleaner} from './model-cleanup.ts';
import {AppCleaner} from './owned-app.ts';
import {OwnedKeyClient} from './owned-key.ts';
import {OwnedIdentityClient} from './owned-identity.ts';
import {remainingModelResources} from './owned-model.ts';
import {sharingAdapter} from './gpu-scenario.ts';
import {poll} from './poll.ts';
import {requireSafe} from './errors.ts';
import type {LiveFoundation} from './live-foundation.ts';
import type {LabRegistration} from './lab-policy.ts';
import type {RecoveryAdapters} from './automatic-recovery.ts';

/** Preparation uses freshly renewed scoped credentials. The transient admin
 * bootstrap context is never used to delete resources or restore product intent. */
export async function recoveryAdapters(inputs:string,context:BrowserContext,registration:LabRegistration):Promise<RecoveryAdapters> {
  const timeoutMs=15_000,observer=new KubectlObserver(join(inputs,'observer.yaml'),timeoutMs),
    model=new KubernetesModelCleaner(join(inputs,'model-cleaner.yaml'),'ai-system',timeoutMs),
    apps=new AppCleaner(join(inputs,'app-cleaner.kubeconfig'),timeoutMs);
  await observer.verifyConfiguration();await model.verifyConfiguration();await apps.verifyConfiguration();
  const readonly=new AdministrationApi(context.request,registration.dashboardUrl,timeoutMs,async()=>{throw new Error('Read-only recovery inventory');});
  return {
    store:new KubernetesLeaseStore(join(inputs,'locker.yaml'),'magicstick-regression','lab-lock',timeoutMs),
    verifyTarget:async()=>{
      const [appliance,nodes,marker]=await Promise.all([observer.get('appliances.appliance.magicstick.dev','ai-system','local'),
        observer.list('nodes'),observer.get('configmaps','magicstick-regression','registered-lab')]);
      const value=marker as KubeObject&{immutable?:boolean;data?:Record<string,string>};
      requireSafe(appliance.metadata.uid===registration.applianceUid&&nodes.length===registration.nodeUids.length&&
        nodes.every(node=>registration.nodeUids.includes(node.metadata.uid!))&&value.immutable===true&&
        value.data?.registrationId===registration.id&&value.data?.kind===registration.kind&&
        value.data?.policyVersion===String(registration.policyVersion)&&value.data?.nodeUids===[...registration.nodeUids].sort().join(',')&&
        value.metadata.labels?.['regression.magicstick.dev/appliance-uid']===registration.applianceUid,'LAB');
    },
    cleanup:(journal,guard)=>{
      const keys=new OwnedKeyClient(context.request,registration.dashboardUrl,timeoutMs,journal.prefix,journal.entries,guard);
      const identityLive={journal,context,guard,config:{dashboardUrl:registration.dashboardUrl,requestTimeoutMs:timeoutMs},
        registerDomainCleanup:()=>{}} as unknown as LiveFoundation;
      const identity=new OwnedIdentityClient(identityLive,true).adapter();
      const modelAdapter=model.adapter(journal.prefix,name=>remainingModelResources(observer,readonly.api,name),guard);
      return {key:keys.adapter(),identity,
        model:{...modelAdapter,lookup:async entry=>{
          await guard();const current=await model.find(entry.name);
          if(current&&entry.uid!==null)requireSafe(current.metadata.uid===entry.uid&&current.metadata.generation===entry.generation&&
            current.metadata.labels?.['app.kubernetes.io/managed-by']==='ai-appliance-dashboard'&&current.spec?.targetNamespace==='ai','OWNERSHIP');
          return current?.metadata.uid?{uid:current.metadata.uid}:null;
        },verifyRemoved:async entry=>{
          if(entry.uid!==null)return modelAdapter.verifyRemoved(entry);
          await guard();const [current,remaining]=await Promise.all([model.find(entry.name),remainingModelResources(observer,readonly.api,entry.name)]);
          return !current&&remaining.podCount===0&&remaining.catalogCount===0;
        }},
        app:{lookup:async entry=>{
          await guard();const current=await apps.find(entry.name);
          if(current&&entry.uid!==null)requireSafe(current.metadata.uid===entry.uid&&current.metadata.generation===entry.generation&&
            current.metadata.labels?.['app.kubernetes.io/managed-by']==='ai-appliance-dashboard'&&current.spec?.targetNamespace==='ai','OWNERSHIP');
          return current?.metadata.uid?{uid:current.metadata.uid}:null;
        },removeIfUid:async(entry,uid)=>{await guard();requireSafe(entry.uid===uid,'OWNERSHIP');await apps.remove(entry,journal.prefix);},
        verifyRemoved:async entry=>{
          await poll(async()=>{await guard();const [current,pods,routes]=await Promise.all([apps.find(entry.name),observer.list('pods','ai'),
            observer.list('httproutes.gateway.networking.k8s.io','identity-system')]);
            return !current&&!pods.some(pod=>pod.metadata.labels?.['appliance.magicstick.dev/appinstance']===entry.name)&&
              !routes.some(route=>route.metadata.labels?.['appliance.magicstick.dev/appinstance']===entry.name);
          },Boolean,{timeoutMs:180_000,intervalMs:1000,stage:'cleanup'});return true;
        }}
      };
    },
    module:(original,guard)=>{
      const id=String(original.spec?.module),api=new AdministrationApi(context.request,registration.dashboardUrl,timeoutMs,guard);
      requireSafe(original.metadata.namespace==='ai-system'&&original.metadata.name&&/^[a-z0-9-]{1,63}$/.test(id),'OWNERSHIP');
      return {read:()=>observer.get('moduleactivations.appliance.magicstick.dev','ai-system',original.metadata.name!),
        set:(enabled,parameters)=>{
          const body=enabled&&!Object.keys(parameters).length?{}:{parameters},path=`/api/modules/${id}/${enabled?'enable':'disable'}`;
          return api.write({method:'POST',path,body},()=>enabled?api.api.enableModule(id,parameters):api.api.disableModule(id,parameters));
        }};
    },
    sharing:(identity,guard)=>sharingAdapter({guard,observer,context,api:readonly.api,config:{dashboardUrl:registration.dashboardUrl,
      requestTimeoutMs:timeoutMs,expected:{applianceNamespace:'ai-system'},gpu:{acknowledgeSharingTransitions:true,
        nodeName:identity.nodeName,nodeUid:identity.nodeUid}}} as unknown as LiveFoundation),
    cancel:()=>context.close(),
  };
}
