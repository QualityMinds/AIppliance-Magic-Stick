import {test,expect} from '@playwright/test';
import {applicationStageIds,applicationServiceStage,applicationSsoChallenge,applicationPageReady,validateAppFixtures} from './apps-live.ts';
import {directAppBackendReady,nativeAppBackendReady,appResourceAssociated} from '../core/owned-app.ts';
import type {KubeObject} from '../core/observer.ts';
import {evidenceAnnotations} from '../core/evidence.ts';

const annotation=evidenceAnnotations({id:'HAR-10',layer:'U'});
test('APP-02/05 services only credit installation, SSO/public access and uninstall, not deferred model integration',annotation,async()=>{
  expect([...applicationStageIds('installation')]).toEqual(['APP-02','APP-10']);
  expect([...applicationStageIds('access')]).toEqual(['APP-05','APP-07','ACL-01','ACL-02','ACL-04','ACL-06']);
  expect(()=>applicationStageIds('models' as any)).toThrow('[CONFIG]');
  const before=process.env.REGRESSION_DIAGNOSTIC_SELECTION;process.env.REGRESSION_DIAGNOSTIC_SELECTION='services';
  try {await expect(applicationServiceStage({} as any,{} as any,'models' as any)).rejects.toThrow('[CONFIG]');}
  finally{if(before===undefined)delete process.env.REGRESSION_DIAGNOSTIC_SELECTION;else process.env.REGRESSION_DIAGNOSTIC_SELECTION=before;}
  const pi={type:'pi-coding',originTemplate:'https://{name}.pi-coding.fixture.local/',adapter:'semantic-chat-v1',responseMarker:'REGRESSION'};
  expect(validateAppFixtures([pi])).toEqual([pi]); // adapter is not invoked by installation/access.
});
test('APP-05 SSO requires the exact IdP client and owned callback, never an arbitrary redirect or denial',annotation,()=>{
  const identity='https://id.fixture.local',callback='https://fixture.local/oauth2/callback/owned-local',client='magicstick-human-gateway-local',
    target=new URL(identity+'/realms/magicstick/protocol/openid-connect/auth');
  for(const [key,value] of Object.entries({client_id:client,redirect_uri:callback,response_type:'code',scope:'openid profile',state:'synthetic-state'}))target.searchParams.set(key,value);
  expect(()=>applicationSsoChallenge(302,target.href,identity,client,callback)).not.toThrow();
  for(const [key,value] of [['client_id','foreign'],['redirect_uri','https://foreign.fixture.local/callback'],['response_type','token'],['scope','profile'],['state','']]) {
    const wrong=new URL(target);wrong.searchParams.set(key!,value!);
    expect(()=>applicationSsoChallenge(302,wrong.href,identity,client,callback)).toThrow('[AUTH]');
  }
  for(const status of [200,401,403])expect(()=>applicationSsoChallenge(status,target.href,identity,client,callback)).toThrow('[AUTH]');
  expect(()=>applicationSsoChallenge(302,target.href.replace('id.fixture.local','foreign.fixture.local'),identity,client,callback)).toThrow('[AUTH]');
});
test('APP-05 allowed SSO and public pages require real HTTP 200 and nonempty native content, not a same-origin error',annotation,()=>{
  const origin='https://owned.fixture.local';
  expect(()=>applicationPageReady(200,origin+'/chat','Native application shell',origin)).not.toThrow();
  for(const status of [undefined,302,403,404,500,503])expect(()=>applicationPageReady(status,origin,'Native application shell',origin)).toThrow('[API]');
  for(const body of [null,'','   ','403 Forbidden','404 Not Found\nnginx','500 Internal Server Error','503 Service Unavailable','Access denied'])
    expect(()=>applicationPageReady(200,origin,body,origin)).toThrow('[API]');
  expect(()=>applicationPageReady(200,'https://foreign.fixture.local','Native application shell',origin)).toThrow('[API]');
});

function nativeFixture(type:'openclaw'|'paperclip',deployment=false) {
  const name=type+'-reg-fixture',namespace='ai',kind=type==='openclaw'?'OpenClawInstance':'Instance',uid='native-instance',
    annotations={'meta.helm.sh/release-name':name,'meta.helm.sh/release-namespace':namespace},
    labels={'app.kubernetes.io/name':type,'app.kubernetes.io/instance':name,'appliance.magicstick.dev/appinstance':name},
    image='registry.fixture/'+type+'@sha256:'+'a'.repeat(64),native:KubeObject={metadata:{name,namespace,uid,generation:2,labels,annotations},
      spec:{image:{repository:'registry.fixture/'+type,digest:'sha256:'+'a'.repeat(64)}},status:{phase:'Running',observedGeneration:2,
        conditions:[{type:'Ready',status:'True',...(type==='paperclip'?{observedGeneration:2}:{})}],
        ...{managedResources:{service:name,[deployment?'deployment':'statefulSet']:name}}}},
    ownerReferences=[{kind,name,uid,controller:true}],service:KubeObject={metadata:{name,namespace,uid:'service',ownerReferences},
      spec:{selector:labels,ports:[{port:type==='openclaw'?18789:3100}]}},
    workload:KubeObject={metadata:{name,namespace,uid:'workload',generation:3,ownerReferences},spec:{replicas:1,template:{spec:{containers:[{name:type,image}]}}},
      status:{observedGeneration:3,replicas:1,readyReplicas:1,...{updatedReplicas:1,availableReplicas:1,currentReplicas:1,currentRevision:'current',updateRevision:'current'}}},
    replicas:KubeObject[]=[{metadata:{namespace,uid:'replicaset',ownerReferences:[{kind:'Deployment',uid:'workload',controller:true}]}}],
    pod:KubeObject={metadata:{namespace,uid:'pod',labels,ownerReferences:[{kind:deployment?'ReplicaSet':'StatefulSet',uid:deployment?'replicaset':'workload',controller:true}]},
      spec:{containers:[{name:type,image}]},status:{phase:'Running',conditions:[{type:'Ready',status:'True'}],containerStatuses:[{name:type,ready:true,imageID:'registry.fixture/native@sha256:'+'b'.repeat(64)}]}};
  return {name,namespace,native,service,workload,replicas,pod,owned:{uid,generation:2}};
}
for(const type of ['openclaw','paperclip'] as const)test('APP-02 '+type+' installation requires its current native CR and exact owned runtime, not Helm acceptance',annotation,()=>{
  const f=nativeFixture(type),ready=(native=f.native,service=f.service,workload=f.workload,pods=[f.pod])=>
    nativeAppBackendReady(type,f.name,f.namespace,native,service,workload,f.replicas,pods,f.owned);
  expect(ready()).toBe(true);
  expect(nativeAppBackendReady(type,f.name,f.namespace,undefined,f.service,f.workload,f.replicas,[f.pod],f.owned)).toBe(false);
  expect(ready({...f.native,status:{...f.native.status,observedGeneration:1}})).toBe(false);
  expect(ready({...f.native,status:{...f.native.status,conditions:[{type:'Ready',status:'False',observedGeneration:2}]}})).toBe(false);
  expect(()=>ready({...f.native,metadata:{...f.native.metadata,uid:'replacement'}})).toThrow('[OWNERSHIP]');
  expect(()=>ready({...f.native,metadata:{...f.native.metadata,annotations:{...f.native.metadata.annotations,'meta.helm.sh/release-name':'foreign'}}})).toThrow('[OWNERSHIP]');
  expect(()=>ready(f.native,{...f.service,metadata:{...f.service.metadata,ownerReferences:[{kind:type==='openclaw'?'OpenClawInstance':'Instance',uid:'foreign',name:f.name,controller:true}]}})).toThrow('[OWNERSHIP]');
  expect(()=>ready(f.native,f.service,{...f.workload,metadata:{...f.workload.metadata,ownerReferences:[]}})).toThrow('[OWNERSHIP]');
  expect(()=>ready(f.native,f.service,f.workload,[{...f.pod,metadata:{...f.pod.metadata,ownerReferences:[{kind:'StatefulSet',uid:'foreign',controller:true}]}}])).toThrow('[OWNERSHIP]');
  expect(ready(f.native,f.service,f.workload,[])).toBe(false);
  expect(ready(f.native,f.service,f.workload,[{...f.pod,status:{...f.pod.status,phase:'Failed'}}])).toBe(false);
  expect(ready(f.native,f.service,{...f.workload,status:{...f.workload.status,observedGeneration:2}})).toBe(false);
  expect(()=>ready({...f.native,status:{...f.native.status,phase:'Failed'}})).toThrow('[API]');
  if(type==='paperclip')expect(ready({...f.native,status:{...f.native.status,conditions:[{type:'Ready',status:'True',observedGeneration:1}]}})).toBe(false);
});
test('APP-02 Paperclip Deployment mode retains the exact native-to-ReplicaSet-to-Pod owner chain',annotation,()=>{
  const f=nativeFixture('paperclip',true);
  expect(nativeAppBackendReady('paperclip',f.name,f.namespace,f.native,f.service,f.workload,f.replicas,[f.pod],f.owned)).toBe(true);
  expect(()=>nativeAppBackendReady('paperclip',f.name,f.namespace,f.native,f.service,f.workload,[],[f.pod],f.owned)).toThrow('[OWNERSHIP]');
});
test('APP-02 native runtime admits only the canonical ServiceAccount projection while preserving intended commands and environment',annotation,()=>{
  const f=nativeFixture('paperclip'),container=(f.pod.spec!.containers as Array<Record<string,unknown>>)[0]!,
    expected={containers:[{...container,command:['native-entrypoint'],env:[{name:'SAFE_CONFIG',value:'native'}],volumeMounts:[{name:'data',mountPath:'/data'}]}],
      volumes:[{name:'data',emptyDir:{}}]},
    actual={containers:[{...expected.containers[0],volumeMounts:[...expected.containers[0]!.volumeMounts,
      {name:'kube-api-access-abc12',mountPath:'/var/run/secrets/kubernetes.io/serviceaccount',readOnly:true}]}],volumes:[...expected.volumes,
      {name:'kube-api-access-abc12',projected:{defaultMode:420,sources:[{serviceAccountToken:{expirationSeconds:3607,path:'token'}},
        {configMap:{name:'kube-root-ca.crt',items:[{key:'ca.crt',path:'ca.crt'}]}},
        {downwardAPI:{items:[{path:'namespace',fieldRef:{apiVersion:'v1',fieldPath:'metadata.namespace'}}]}}]}}]};
  const workload={...f.workload,spec:{...f.workload.spec,template:{spec:expected}}},ready=(spec:Record<string,unknown>)=>
    nativeAppBackendReady('paperclip',f.name,f.namespace,f.native,f.service,workload,f.replicas,[{...f.pod,spec}],f.owned);
  expect(ready(actual)).toBe(true);
  for(const patch of [{command:['foreign-command']},{env:[{name:'SAFE_CONFIG',value:'changed'}]},{image:'foreign-image'}])
    expect(()=>ready({...actual,containers:[{...actual.containers[0],...patch}]})).toThrow('[REVISION]');
  expect(()=>ready({...actual,volumes:[...expected.volumes,{name:'kube-api-access-abc12',hostPath:{path:'/'}}]})).toThrow('[REVISION]');
});

test('APP-02 Pi boot requires the exact Helm and controller-owned Ready backend, not a Ready release alone',annotation,()=>{
  const name='pi-coding-reg-fixture',namespace='ai',annotations={'meta.helm.sh/release-name':name,'meta.helm.sh/release-namespace':namespace};
  const service:KubeObject={metadata:{name,namespace,uid:'service',annotations},spec:{selector:{'app.kubernetes.io/instance':name}}};
  const deployment:KubeObject={metadata:{name,namespace,uid:'deployment',generation:2,annotations},spec:{replicas:1,template:{spec:{containers:[{name:'pi-coding',image:'registry.fixture/pi@sha256:'+ 'a'.repeat(64)}]}}},
    status:{observedGeneration:2,replicas:1,readyReplicas:1,...{updatedReplicas:1,availableReplicas:1}}};
  const replicas:KubeObject[]=[{metadata:{uid:'replica',namespace,ownerReferences:[{uid:'deployment',kind:'Deployment'}]}}];
  const pod:KubeObject={metadata:{uid:'pod',namespace,labels:{'app.kubernetes.io/instance':name},ownerReferences:[{uid:'replica',kind:'ReplicaSet'}]},
    spec:{containers:[{name:'pi-coding',image:'registry.fixture/pi@sha256:'+'a'.repeat(64)}]},status:{phase:'Running',conditions:[{type:'Ready',status:'True'}],
      containerStatuses:[{name:'pi-coding',ready:true,imageID:'registry.fixture/pi@sha256:'+'b'.repeat(64)}]}};
  expect(directAppBackendReady(name,namespace,service,deployment,replicas,[pod])).toBe(true);
  expect(directAppBackendReady(name,namespace,undefined,deployment,replicas,[pod])).toBe(false);
  expect(directAppBackendReady(name,namespace,service,deployment,replicas,[])).toBe(false);
  expect(directAppBackendReady(name,namespace,service,{...deployment,status:{...deployment.status,observedGeneration:1}},replicas,[pod])).toBe(false);
  expect(()=>directAppBackendReady(name,namespace,{...service,metadata:{...service.metadata,annotations:{...annotations,'meta.helm.sh/release-name':'foreign'}}},deployment,replicas,[pod])).toThrow('[OWNERSHIP]');
  expect(()=>directAppBackendReady(name,namespace,service,deployment,[],[pod])).toThrow('[OWNERSHIP]');
  expect(()=>directAppBackendReady(name,namespace,service,deployment,replicas,[{...pod,spec:{containers:[{name:'pi-coding',image:'foreign'}]}}])).toThrow('[REVISION]');
});

test('APP-10 direct-chart Pods and Helm Services cannot disappear from the cleanup absence proof',annotation,()=>{
  const name='pi-coding-reg-fixture',uid='app-uid';
  const associated:KubeObject['metadata'][]=[
    {labels:{'app.kubernetes.io/instance':name}},
    {labels:{'appliance.magicstick.dev/appinstance':name}},
    {annotations:{'meta.helm.sh/release-name':name}},
    {ownerReferences:[{uid,kind:'AppInstance'}]},
    {namespace:'ai-system',name},
  ];
  for(const metadata of associated)expect(appResourceAssociated({metadata},name,uid)).toBe(true);
  expect(Boolean(appResourceAssociated({metadata:{labels:{'app.kubernetes.io/instance':'foreign'}}},name,uid))).toBe(false);
  expect(Boolean(appResourceAssociated({metadata:{name:name+'-lookalike',namespace:'ai'}},name,uid))).toBe(false);
});
