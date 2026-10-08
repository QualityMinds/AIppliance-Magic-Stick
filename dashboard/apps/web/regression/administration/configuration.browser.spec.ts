import {test,expect,type Page} from '@playwright/test';
import {fixturePage,origin} from '../fixtures/dashboard.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {remainingPhase,remainingVariants} from '../profiles/remaining-p0.ts';
import {gpuMemoryDraft,settingsDrafts} from './form-checks.ts';

const host=()=>({name:'fixture-node',nodeUid:'fixture-node-uid',bootId:'fixture-boot',kernel:'7.0-fixture',available:true,message:'Fixture worker ready.',
  plan:{id:'f'.repeat(64),state:'ready',profileId:'strix-halo-ubuntu-26.04',profileVersion:'1',gpuProfile:'strix-halo',experimental:true,packages:{},rebootRequired:false,message:'Driver is ready.',displayGpus:['1002:1586']},
  network:{id:'a'.repeat(64),supported:true,message:'Ready',interfaces:[
    {name:'eth0',kind:'ethernet',mac:'02:00:00:00:00:01',state:'UP',addresses:['192.0.2.10/24'],editable:true,scanSupported:false,configuredMode:'dhcp',metric:100,clusterAddresses:[]},
    {name:'wlan0',kind:'wifi',mac:'02:00:00:00:00:02',state:'DOWN',addresses:[],editable:true,scanSupported:true,configuredMode:'dhcp',metric:600,clusterAddresses:[]}]},
  gpuMemory:{id:'a'.repeat(64),supported:true,message:'Reviewed firmware choices.',pciAddress:'0000:66:00.0',systemMemoryMi:126976,currentCarveoutIndex:9,currentCarveoutMi:512,currentDynamicLimitMi:102400,
    options:[{index:9,label:'512M',sizeMi:512},{index:4,label:'64G',sizeMi:65536}],systemReserveMi:16384,stepMi:1024,minDynamicLimitMi:1024},
  modelCache:{id:'a'.repeat(64),supported:true,blocked:true,message:'Active models protect the cache.',reclaimableBytes:30e9,totalBytes:250e9,freeBytes:50e9,
    caches:[{id:'huggingface',name:'Hugging Face / vLLM',usedBytes:20e9,clearable:true},{id:'ollama',name:'Ollama',usedBytes:10e9,clearable:true}]},
  software:{supported:true,id:'a'.repeat(64),channel:{kind:'branch',value:'main'},hostCommit:'b'.repeat(40)},
  updates:{id:'a'.repeat(64),supported:true,busy:false,rebootRequired:false,
    policy:{mode:'security',windowStart:'03:00',windowMinutes:120,automaticReboot:false},pendingCount:0,securityCount:0,blockedCount:0,packages:[]},
});
const license={edition:'free',state:'missing',message:'Free mode.',valid:false,installationId:'fixture-installation',revision:'1',checkedAt:1,hasDocument:false,trustedKeyIds:[],
  features:[{id:'federated-sso',name:'Federated SSO',licensed:false,implemented:true,available:false,reason:'unlicensed'}]};
const mesh={installed:true,configured:false,phase:'disconnected',models:['fixture-cpu']};
const session={subject:'fixture-admin',username:'fixture-admin',roles:['magicstick-admin'],identityManagementAvailable:true,identityManagementMode:'keycloak'};
const gpuStatus=()=>({hardwareOperators:{'amd-gpu':{displayName:'AMD GPU Operator',phase:'Ready',compatibility:{schemaVersion:1,
  selectedProfile:'strix-halo',allowExperimental:true,profiles:[{id:'strix-halo',displayName:'AMD Strix Halo',version:'1',experimental:true,memoryArchitecture:'unified'}],
  nodes:[{node:'fixture-node',nodeUid:'fixture-node-uid',profileId:'strix-halo',profileVersion:'1',eligible:true}]},devices:[{
    id:'fixture-node-uid/0000:66:00.0',vendor:'amd',name:'AMD Strix Halo',node:'fixture-node',nodeUid:'fixture-node-uid',
    eligible:true,hostDriverReady:true,resourceRegistered:true,pciAddress:'0000:66:00.0',pciId:'1002:1586',architecture:'gfx1151',
    memoryArchitecture:'unified',memory:{node:'fixture-node',installedMemoryMi:131072,firmwareReservedMi:512,
      physicalMemoryMi:126976,gpuAccessibleMi:102400,gpuCapacityMi:102400,gpuAllocationMode:'shared-gtt'},validationAvailable:true}]},
    'nvidia-gpu':{displayName:'NVIDIA GPU Operator',phase:'Ready',devices:[{id:'fixture-node-uid/0000:01:00.0',vendor:'nvidia',name:'Fixture NVIDIA',
      node:'fixture-node',nodeUid:'fixture-node-uid',eligible:true,hostDriverReady:true,resourceRegistered:true,pciAddress:'0000:01:00.0',pciId:'10de:0001',
      architecture:'fixture',memoryArchitecture:'discrete',validationAvailable:true}]}}});
const sharing={providers:['amd','nvidia'].map(provider=>({provider,backend:provider === 'amd' ? 'dra' : 'time-slicing',managed:true,experimental:provider === 'amd',
  mode:'exclusive',maxModels:2,nodeName:'fixture-node',nodeUid:'fixture-node-uid',namespace:'ai',expectedRevision:'7',available:true,reason:'',phase:'Ready',
  message:'',claimName:'',activeModels:0,admittedModels:[],memoryIsolation:false}))};

async function mount(page:Page,route:string,extra:Record<string,unknown>={}) {
  const writes:string[]=[];
  await fixturePage(page,{'/api/session':session,'/api/license':license,'/api/mesh':mesh,
    '/api/host-management':{nodes:[host()]},'/api/users':{users:[],total:0,first:0,max:25},
    '/api/kubernetes-access':{users:[],total:0,configuration:{configured:false,message:'Fixture OIDC configuration is unavailable.'}},
    '/api/federated-sso':{feature:license.features[0],providers:[],issuer:'https://identity.example.local/realms/fixture',callbackUrl:'https://identity.example.local/realms/fixture/broker/{alias}/endpoint'},...extra});
  page.on('request',request=>{if(new URL(request.url()).origin === origin && !['GET','HEAD','OPTIONS'].includes(request.method())) writes.push(new URL(request.url()).pathname);});
  await page.goto(origin+'/#/'+route);
  return writes;
}
async function browserProof(page:Page,group:string,id:string) {
  if(group === 'host') {
    const writes=await mount(page,'system/power');
    await page.getByRole('button',{name:'Restart computer',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await expect(dialog.getByRole('button',{name:'Restart computer',exact:true})).toBeDisabled();
    await dialog.getByLabel('Type fixture-node to confirm').fill('Fixture-node');
    await expect(dialog.getByRole('button',{name:'Restart computer',exact:true})).toBeDisabled();
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
    expect(writes).toEqual([]); return;
  }
  if(group === 'network') {
    const writes=await mount(page,'system/settings/network');
    const ethernet=page.getByRole('article',{name:'Ethernet eth0'});
    await expect(ethernet).toBeVisible(); await expect(page.getByRole('article',{name:'Wi-Fi wlan0'})).toBeVisible();
    await ethernet.getByRole('button',{name:'Configure',exact:true}).click();
    await page.getByRole('button',{name:'Review network change',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Apply network trial'});
    await expect(dialog.getByRole('button',{name:'Apply temporarily',exact:true})).toBeDisabled();
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
    expect(writes).toEqual([]); return;
  }
  if(group === 'channel') {
    const writes=await mount(page,'system/settings/updates');
    await page.getByRole('combobox',{name:'Software channel',exact:true}).selectOption('commit');
    await page.getByLabel('Full commit').fill('abc123');
    await expect(page.getByRole('button',{name:'Check channel',exact:true})).toBeDisabled();
    await page.getByLabel('Full commit').fill('c'.repeat(40));
    await expect(page.getByRole('button',{name:'Check channel',exact:true})).toBeEnabled();
    await expect(page.getByRole('button',{name:'Apply channel',exact:true})).toBeDisabled();
    expect(writes).toEqual([]); return;
  }
  if(group === 'cache') {
    const writes=await mount(page,'system/model-cache');
    await expect(page.getByRole('button',{name:'Clear model cache',exact:true})).toBeDisabled();
    await expect(page.getByText('Free disk space', {exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Refresh cache',exact:true}).click();
    expect(writes).toEqual([]); return;
  }
  if(group === 'mesh') {
    const writes=await mount(page,'system/settings/mesh');
    await expect(page).toHaveURL(origin+'/#/mesh');
    await page.getByRole('button',{name:'Join Mesh',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Join private mesh'});
    await dialog.getByLabel('Node name').fill('fixture-peer');
    await dialog.getByLabel('Invite token').fill('public-fixture-invite');
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('button',{name:'Join Mesh',exact:true}).click();
    await expect(page.getByRole('dialog').getByLabel('Invite token')).toHaveValue('');
    expect(writes).toEqual([]); return;
  }
  if(group === 'licensing' || group === 'federation') {
    const writes=await mount(page,'system/license');
    await expect(page.getByLabel('License file')).toBeVisible();
    await page.getByRole('tab',{name:'Settings',exact:true}).click();
    await expect(page.getByRole('tab',{name:'Federated SSO (registration or commercial license required)',exact:true})).toBeDisabled();
    await expect(page.getByRole('button',{name:'Mesh',exact:true})).toBeVisible();
    expect(writes).toEqual([]); return;
  }
  if(group === 'authentication') {
    const writes=await mount(page,'models');
    await page.route(origin+'/api/session',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Controlled identity outage.'})}));
    await page.reload(); await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button',{name:'Create',exact:true})).toHaveCount(0);
    expect(writes).toEqual([]); return;
  }
  if(group === 'keys') {
    const writes=await mount(page,'api-access',{'/api/api-access':{items:[{id:'fixture-managed-key',name:'Fixture key',keyHint:'redacted',status:'active'}],total:1,apiBases:[]}});
    await expect(page.getByText('Fixture key',{exact:true})).toBeVisible();
    expect(await page.locator('body').textContent()).not.toContain('sk-test-private-key');
    expect(writes).toEqual([]); return;
  }
  if(group === 'kubernetes') {
    const writes=await mount(page,'kubernetes-access',{'/api/kubernetes-access':{users:[{id:'fixture-user',username:'fixture-user',enabled:true,accessLevel:'none'}],total:1,
      configuration:{configured:false,message:'Fixture OIDC configuration is unavailable.'}}});
    await expect(page.getByRole('status').filter({hasText:'Kubernetes SSO is not confirmed'})).toBeVisible();
    await expect(page.getByRole('button',{name:'Download Kubeconfig',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'Edit Access',exact:true}).click();
    await page.getByRole('dialog').getByRole('combobox').selectOption('admin');
    await expect(page.getByRole('dialog').getByText(/unrestricted|cluster-admin/i).first()).toBeVisible();
    await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();
    expect(writes).toEqual([]); return;
  }
  if(group === 'modules') {
    const writes=await mount(page,'services',{'/api/modules':{modules:{litellm:{enabled:true,displayName:'Fixture runtime',status:{phase:'Degraded',message:'Controlled dependency failure.'}}},catalogJson:{modules:{litellm:{displayName:'Fixture runtime',group:'runtime',activationMode:'moduleactivation'}}}}});
    await expect(page.getByText('Degraded',{exact:true})).toBeVisible();
    expect(writes).toEqual([]); return;
  }
  if(group === 'security') {
    const attack='<img src=x onerror="window.__regressionInjected=true">';
    const writes=await mount(page,'models',{'/api/models':{activations:[{metadata:{name:'fixture-xss',uid:'fixture-uid',generation:1},spec:{type:'local',enabled:true,local:{engine:'OLlama',computeTarget:'cpu'}},status:{phase:'Degraded',message:attack}}],models:[],computeTargets:{targets:[]},computeMemory:{devices:[]}}});
    await expect(page.getByText(attack,{exact:true}).first()).toBeVisible();
    expect(await page.evaluate(()=>Reflect.get(window,'__regressionInjected'))).toBeUndefined();
    expect(writes).toEqual([]); return;
  }
  if(group === 'forms') {
    const writes=await mount(page,'system/settings/network',{'/api/status':gpuStatus(),'/api/hardware/gpu-sharing':sharing,
      '/api/settings':{publicDomain:'fixture.example.invalid',mdnsDomain:'fixture.local'},
      '/api/mesh':{...mesh,configured:true,phase:'connected',authority:true,mesh:{id:'fixture-mesh',name:'Fixture Mesh',authority:'fixture-owner'},
        node:{id:'fixture-owner',name:'fixture-node',type:'magic-stick'},nodes:[],shares:{},imports:[],relay:{mode:'auto',url:''},invites:[]}});
    await settingsDrafts(page,origin,'fixture-node');
    expect(writes).toEqual([]); return;
  }
  if(group === 'gpu-host') {
    const writes=await mount(page,'system/hardware',{'/api/status':gpuStatus()});
    await gpuMemoryDraft(page,'fixture-node');
    expect(writes).toEqual([]); return;
  }
  if(group === 'realtime') {
    const writes=await mount(page,'models',{'/api/models':{activations:[],models:[],presets:{},computeTargets:{targets:[
      {id:'nvidia-gpu',kind:'gpu',available:true,engines:['VLLM']}],engineCatalog:{VLLM:{realtimeProfiles:{'fixture-omni':{
        displayName:'Fixture Omni',model:'fixture/omni',description:'Explicit isolated fixture',gpuCounts:[1,2],defaultContextWindow:8192,
        defaultSystemMemoryMi:16384,sourceRevision:'fixture'}}}},realtimeDevices:[{profile:'fixture-omni',node:'fixture-node',name:'Fixture CUDA GPU',
          supported:true,reason:'',gpuCount:2,freeGpuCount:2,gpuMemoryMi:81920,systemMemoryMi:131072},
          {profile:'fixture-omni',node:'unsupported-node',name:'Unsupported GPU fixture',supported:false,reason:'No compatible runtime.',gpuCount:1,freeGpuCount:1}]}}});
    await page.getByRole('button',{name:'Create',exact:true}).click();
    await page.getByRole('combobox',{name:'Inference Engine',exact:true}).selectOption('VLLM-Omni');
    await expect(page.getByRole('combobox',{name:'Realtime profile',exact:true})).toHaveValue('fixture-omni');
    await expect(page.getByRole('option',{name:/unsupported-node/})).toHaveAttribute('disabled','');
    const compute=page.getByRole('combobox',{name:'Compute node',exact:true});
    await compute.press('End');await expect(compute).toHaveValue('fixture-node');
    await expect(page.getByLabel('KV Cache')).toHaveCount(0);
    await expect(page.getByText('Advanced Settings',{exact:true}).locator('..')).not.toHaveAttribute('open');
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    expect(writes).toEqual([]); return;
  }
  throw new Error(`No browser oracle for ${id}`);
}
for(const [variant,definition] of Object.entries(remainingVariants).filter(([,item])=>item.phase === remainingPhase(process.env.REGRESSION_MODE) && item.layers.includes('B'))) {
  test(`${definition.id} bundled ${definition.group} failure/confirmation boundary`,evidenceAnnotations({id:definition.id,variant,layer:'B'}),
    ({page})=>browserProof(page,definition.group,definition.id));
}
