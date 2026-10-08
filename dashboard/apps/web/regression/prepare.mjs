import {spawn} from 'node:child_process';
import {lstat,rm,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {parseLabConfig} from './core/config.ts';
import {realLogin} from './core/auth.ts';
import {browserTrust} from './core/browser-trust.ts';
import {readOnlyApi} from './core/transport.ts';
import {KubectlObserver,KubernetesLeaseStore} from './core/observer.ts';
import {preparationApi,estimateInput} from './core/preparation-api.ts';
import {KubernetesModelCleaner} from './core/model-cleanup.ts';
import {verifiedEndpoint,verifyDeploymentPins} from './core/preflight.ts';
import {privateDirectory,readPrivate,writePrivate} from './core/private-files.ts';
import {HarnessError,requireSafe} from './core/errors.ts';
import {preparationArguments,prepareInputs,preparedProfile,inputReadiness,preparedReboot,pinChanges,
  inputHash,validateAcceptance,automaticInputRecovery} from './core/input-preparation.ts';
import {readinessLines} from './core/preparation-measures.ts';
import {savedSetupOptions} from './core/setup-suite.ts';
import {automaticGpuProfile,automaticProfile,automaticHostRecipes} from './core/automatic-fixtures.ts';
import {labPolicy,registeredLab} from './core/lab-policy.ts';

process.umask(0o077);
process.chdir(fileURLToPath(new URL('..',import.meta.url)));
const input=resolve(process.env.REGRESSION_INPUT_DIR ?? '/inputs');
const worker=process.argv[2] === '--worker';
const args=process.argv.slice(worker ? 3 : 2);
let home,browser,context;

async function optional(name) {
  const path=join(input,name);
  try {await lstat(path);}catch(error){if(error.code === 'ENOENT')return undefined;throw error;}
  return JSON.parse(await readPrivate(path));
}
async function sources() {
  const [lab,setup,profile,drills]=await Promise.all(['lab.json','setup.json','remaining-p0.json','host-drills.json'].map(optional));
  requireSafe(lab || setup,'CONFIG');
  const seed={...lab};
  if(setup)for(const key of ['dashboardUrl','identityUrl','inferenceUrl','caFile','usernameFile','passwordFile','observerKubeconfig','lock','modelCleanupKubeconfig','registrationFile']) {
    if(Object.hasOwn(setup,key))seed[key]=setup[key];
    else if(key === 'caFile')delete seed.caFile; // Explicit WebPKI setup, not stale CA fallback.
  }
  const parsed=parseLabConfig({...seed,version:1,profile:'preflight',expected:{
    applianceUid:'discovery-only',applianceName:'local',applianceNamespace:'ai-system',role:'magicstick-admin',
    nodes:[{name:'discovery-only',uid:'discovery-only'}],capabilities:[{target:'cpu',engines:['OLlama']}],images:[]},gpu:undefined},input);
  const hashes={};
  for(const [key,path] of Object.entries({username:parsed.usernameFile,password:parsed.passwordFile,ca:parsed.caFile,
    observer:parsed.observerKubeconfig,locker:parsed.lock?.kubeconfig,modelCleaner:parsed.modelCleanupKubeconfig}))
    if(path)hashes[key]=inputHash(await readPrivate(path));
  return {lab:lab ?? {},setup,profile:profile ?? {},drills,seed,parsed,hash:inputHash({lab,setup,profile,drills,hashes})};
}

async function currentImages(observer,pods,previous) {
  const selections=previous.expected?.images?.length ? previous.expected.images : [
    {namespace:'dashboard',deployment:'ai-appliance-dashboard',container:'web'},
    {namespace:'identity-system',deployment:'ai-appliance-dashboard-api',container:'api'},
  ];
  const images=[];
  for(const selection of selections) {
    const {namespace,deployment,container}=selection;
    const observed=await observer.get('deployments.apps',namespace,deployment);
    const replicasets=await observer.list('replicasets.apps',namespace);
    const owners=new Set(replicasets.filter(item=>item.metadata.ownerReferences?.some(owner=>owner.uid === observed.metadata.uid))
      .map(item=>item.metadata.uid));
    const running=pods.filter(item=>!item.metadata.deletionTimestamp && item.metadata.namespace === namespace &&
      item.metadata.ownerReferences?.some(owner=>owners.has(owner.uid))).flatMap(item=>item.status?.containerStatuses ?? [])
      .filter(item=>item.name === container);
    const digests=[...new Set(running.map(item=>item.imageID?.match(/sha256:[a-f0-9]{64}$/)?.[0]))];
    requireSafe(observed.metadata.generation === observed.status?.observedGeneration && Number(observed.status?.readyReplicas) > 0 &&
      running.length > 0 && running.every(item=>item.ready) && digests.length === 1 && digests[0],'REVISION');
    images.push({namespace,deployment,container,digest:digests[0]});
  }
  return images;
}

async function readableReferences(profile,base) {
  const files=new Set();
  const selected=new Set([base.usernameFile,base.passwordFile,base.observerKubeconfig,base.lock?.kubeconfig,base.modelCleanupKubeconfig,base.caFile].filter(Boolean));
  const visit=value=>{
    if(Array.isArray(value))for(const item of value)visit(item);
    else if(value && typeof value === 'object')for(const [key,item] of Object.entries(value)) {
      if((key.endsWith('File') || key.endsWith('Kubeconfig') || key === 'kubeconfig' || key === 'filename' || key === 'peerConfig') && typeof item === 'string')selected.add(item);
      else if(key === 'invalidFiles' && Array.isArray(item))for(const path of item)selected.add(path);
      else visit(item);
    }
  };
  visit(profile);
  for(const path of selected) {
    try {
      const full=resolve(input,path);requireSafe(full.startsWith(input+'/'),'PRIVATE_FILE');
      if(path === profile.kubernetes?.plugin?.filename) {
        const handle=await open(full,constants.O_RDONLY|constants.O_NOFOLLOW);
        try {
          const stat=await handle.stat();requireSafe(stat.isFile() && (stat.mode & 0o777) === 0o700 && stat.size < 64*1024*1024,'PRIVATE_FILE');
          const digest=createHash('sha256'),buffer=Buffer.alloc(65536);let size=0;
          for(;;) {const {bytesRead}=await handle.read(buffer,0,buffer.length);if(!bytesRead)break;
            size+=bytesRead;requireSafe(size <= stat.size,'PRIVATE_FILE');digest.update(buffer.subarray(0,bytesRead));}
          requireSafe(digest.digest('hex') === profile.kubernetes.plugin.sha256,'REVISION');
        }finally{await handle.close();}
      } else await readPrivate(full);
      files.add(path);files.add(full);
    }catch{/* Required prerequisites stay blocked, not replaced or elevated. */}
  }
  return [...files];
}

async function discover(source,options) {
  const config=source.parsed,observer=new KubectlObserver(config.observerKubeconfig,config.requestTimeoutMs);
  const ca=config.caFile ? await readPrivate(config.caFile) : undefined;
  for(const [label,origin] of [['Dashboard',config.dashboardUrl],['Identity',config.identityUrl],['Inference',config.inferenceUrl]]) {
    if(!origin)continue;
    try {await verifiedEndpoint(origin,config.requestTimeoutMs,ca);}
    catch {console.error(`Verified HTTPS/DNS failed for ${label}. Check the approved Appliance CA, private hostname mappings and reachability; never bypass TLS.`);
      throw new HarnessError('TLS');}
  }
  await observer.verifyConfiguration();
  const appliances=await observer.list('appliances.appliance.magicstick.dev');
  const pinned=source.lab.expected;
  const observedAppliance=pinned ? appliances.find(item=>item.metadata.name === pinned.applianceName && item.metadata.namespace === pinned.applianceNamespace) :
    appliances.length === 1 ? appliances[0] : undefined;
  requireSafe(observedAppliance,'IDENTITY');
  context=await realLogin(browser,config);
  const api=readOnlyApi(context.request,config.dashboardUrl,config.requestTimeoutMs);
  const [appliance,models,hostPayload,status,modules,nodes,pods,flux]=await Promise.all([
    api.appliance(),api.models(),api.hostManagement(),api.status(),api.modules(),observer.list('nodes'),observer.list('pods'),
    observer.list('kustomizations.kustomize.toolkit.fluxcd.io','flux-system'),
  ]);
  const expected=pinned?.flux ?? {namespace:'flux-system',name:'flux-system'};
  const sourceFlux=flux.find(item=>item.metadata.name === expected.name && item.metadata.namespace === expected.namespace);
  requireSafe(sourceFlux?.status?.conditions?.some(c=>c.type === 'Ready' && c.status === 'True' &&
    (c.observedGeneration ?? sourceFlux.status.observedGeneration) === sourceFlux.metadata.generation) &&
    /(?:sha1:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/.test(sourceFlux.status.lastAppliedRevision ?? ''),'REVISION');
  const images=await currentImages(observer,pods,source.lab);
  requireSafe(config.lock && config.modelCleanupKubeconfig,'CONFIG');
  const lease=await new KubernetesLeaseStore(config.lock.kubeconfig,config.lock.namespace,config.lock.name).read();
  requireSafe(lease.metadata.labels?.['regression.magicstick.dev/appliance-uid'] === observedAppliance.metadata.uid,'IDENTITY');
  await new KubernetesModelCleaner(config.modelCleanupKubeconfig,observedAppliance.metadata.namespace).verifyConfiguration();
  const snapshot={appliance,observedAppliance,nodes,hosts:hostPayload.nodes,models,status,modules,images,
    flux:{namespace:expected.namespace,name:expected.name,revision:sourceFlux.status.lastAppliedRevision},
    leaseIdle:!lease.spec.holderIdentity,readableFiles:[],drills:source.drills};
  const defaults=JSON.parse(await readPrivateExample('gpu-profile.example.json')).gpu.models;
  const effectiveOptions=options.automatic ? {...options,approve:[...labPolicy.scopes],independentRecovery:false} :
    savedSetupOptions(options,source.setup?.suiteConsent,snapshot);
  const seed=structuredClone(source.seed);
  if(options.automatic) {
    delete seed.smokeModel;delete seed.phase2;
    seed.gpu=automaticGpuProfile(snapshot,defaults);
  }
  if(source.setup?.suiteConsent && seed.gpu)seed.gpu.acknowledgeSharingTransitions=effectiveOptions.approve.includes('gpu');
  const prepared=prepareInputs(seed,snapshot,effectiveOptions,defaults);
  if(options.automatic)await registeredLab(prepared.parsed,observer);
  snapshot.gpuIssues=prepared.gpuIssues;
  snapshot.modelWarnings=await checkModelInputs(source,prepared,snapshot,options);
  await verifyDeploymentPins(prepared.parsed,observer,pods,flux);
  return {snapshot,prepared,effectiveOptions};
}

async function checkModelInputs(source,prepared,snapshot,options) {
  const warnings=[],lab=prepared.lab;
  const fixtures=[['smokeModel',lab.smokeModel],...(options.phases.some(phase=>phase >= 2) && lab.phase2 ?
    [['ollamaModel',lab.phase2.ollamaModel],['vllmModel',lab.phase2.vllmModel]] : [])].filter(([,fixture])=>fixture);
  const api=preparationApi(context.request,source.parsed.dashboardUrl,source.parsed.requestTimeoutMs,fixtures.map(([,fixture])=>fixture));
  const capacity=Math.max(0,...(snapshot.models.computeMemory?.devices ?? []).filter(device=>device.id === 'cpu' || device.computeTarget === 'cpu')
    .flatMap(device=>Number.isFinite(device.unreservedMi) && Number.isFinite(device.freeMi) ? [Math.min(device.unreservedMi,device.freeMi)] : []));
  if(!capacity)warnings.push('Current usable CPU RAM telemetry');
  for(const [name,fixture] of fixtures) {
    try {
      const estimate=await api.estimateMemory(estimateInput(fixture));
      requireSafe(Number.isFinite(estimate.minimumMi) && estimate.minimumMi > 0 &&
        Number.isFinite(estimate.recommendedMi) && estimate.recommendedMi >= estimate.minimumMi,'CAPABILITY');
      const initial=options.automatic || (name === 'smokeModel' ? !source.lab.smokeModel : !source.lab.phase2);
      if(initial) {
        const budget=Math.ceil(Math.max(fixture.memoryRequiredMi,estimate.recommendedMi)/100)*100;
        requireSafe(budget <= capacity && budget <= (name === 'smokeModel' ? 8192 : 32768),'CAPABILITY');
        fixture.memoryRequiredMi=budget;
      }
      requireSafe(fixture.memoryRequiredMi >= estimate.minimumMi && fixture.memoryRequiredMi <= capacity &&
        fixture.memoryRequiredMi <= (name === 'smokeModel' ? 8192 : 32768),'CAPABILITY');
    } catch {warnings.push(`CPU ${name}: metadata/estimator or reviewed RAM budget needs attention`);}
  }
  if(lab.phase2 && options.phases.some(phase=>phase >= 2)) {
    const selection=lab.phase2.discovery,common={provider:'huggingface',engine:'VLLM',computeTarget:'cpu',modelType:'chat',limit:'20'};
    const searches=source.lab.phase2 && !options.automatic ? [selection.query] : [...new Set([selection.repo.split('/')[1].split('-')[0],selection.query,selection.repo.split('/')[1]])];
    let found=false;
    for(const query of searches) {
      try {
        const first=await api.searchModels(new URLSearchParams({...common,q:query}));
        if(!first.nextCursor)continue;
        const second=await api.searchModels(new URLSearchParams({...common,q:query,cursor:first.nextCursor}));
        const repos=[...first.results,...second.results].map(item=>item.repo);
        if(!repos.includes(selection.repo) || new Set(repos).size !== repos.length)continue;
        const artifacts=await api.modelArtifacts(new URLSearchParams({...common,repo:selection.repo}));
        const artifact=artifacts.artifacts.find(item=>item.url === selection.artifactUrl);
        if(!artifact?.id || !artifact.revision || !(artifact.downloadBytes > 0))continue;
        if(!source.lab.phase2 || options.automatic)selection.query=query;
        found=true;break;
      }catch{/* Try only bounded catalog-derived search terms; never fabricate a revision. */}
    }
    if(!found)warnings.push('CPU vLLM discovery: current paged results and immutable artifact metadata');
  }
  // Estimators are read-only. Existing reviewed fixtures are never silently
  // retuned; initial catalog defaults are proposed with the returned budget.
  prepared.parsed=parseLabConfig(lab,input);
  return warnings;
}
// Committed examples are public-readable. Credentials never use this reader.
async function readPrivateExample(name) {
  const {readFile}=await import('node:fs/promises');return readFile(new URL(name,import.meta.url),'utf8');
}

async function ciCandidates(source,snapshot,options) {
  if(!options.phases.some(phase=>phase === 7 || phase === 8))return {};
  const revision=snapshot.flux.revision.match(/sha1:([a-f0-9]{40})$/)?.[1];if(!revision)return {};
  const headers={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  const tokenFile=source.profile.securityCi?.tokenFile ?? source.profile.companion?.tokenFile;
  if(tokenFile) {
    const full=resolve(input,tokenFile);requireSafe(full.startsWith(input+'/'),'PRIVATE_FILE');
    headers.Authorization='Bearer '+(await readPrivate(full)).trim();
  }
  const root='https://api.github.com/repos/QualityMinds/AIppliance-Magic-Stick/actions';
  const get=async(path)=>{
    const response=await context.request.get(root+path,{headers,timeout:source.parsed.requestTimeoutMs,maxRedirects:0});
    requireSafe(response.status() === 200 && (await response.body()).length < 2*1024*1024,'API');return response.json();
  };
  const proofs={};
  for(const [field,workflow,job,days] of [
    ['dependenciesRunId','dependency-security.yml','advisories',8],['publicationRunId','public-release-checks.yml','release-checks',8],
    ['runId','build-mesh-companion.yml',undefined,30],
  ]) {
    if(field === 'runId' ? !options.phases.includes(7) : !options.phases.includes(8))continue;
    try {
      const listing=await get('/workflows/'+workflow+'/runs?per_page=100');
      const candidates=(listing.workflow_runs ?? []).filter(run=>run.repository?.full_name === 'QualityMinds/AIppliance-Magic-Stick' &&
        run.path === '.github/workflows/'+workflow && run.head_sha === revision && run.status === 'completed' && run.conclusion === 'success' &&
        Date.now() >= Date.parse(run.updated_at) && Date.now()-Date.parse(run.updated_at) <= days*86400_000);
      for(const run of candidates) {
        if(job) {
          const jobs=await get('/runs/'+run.id+'/jobs?per_page=100');
          if(!jobs.jobs?.some(item=>item.name === job && item.conclusion === 'success' && item.status === 'completed'))continue;
        } else {
          const artifacts=await get('/runs/'+run.id+'/artifacts?per_page=100');
          if(!['macos-arm64','macos-x64','linux-x64','windows-x64'].every(platform=>
            artifacts.artifacts?.some(item=>item.name === 'companion-acceptance-'+platform && !item.expired)))continue;
        }
        proofs[field]=run.id;break;
      }
    }catch{/* Registry/network/permission failure is a missing CI prerequisite, not a pass. */}
  }
  return {...(proofs.dependenciesRunId && proofs.publicationRunId ? {securityCi:{sourceRevision:revision,
    dependenciesRunId:proofs.dependenciesRunId,publicationRunId:proofs.publicationRunId}} : {}),
    ...(proofs.runId ? {companion:{sourceRevision:revision,runId:proofs.runId}} : {})};
}

const targetHash=(prepared,snapshot)=>inputHash({expected:prepared.lab.expected,gpu:prepared.lab.gpu,
  smokeModel:prepared.lab.smokeModel,phase2:prepared.lab.phase2,
  devices:Object.values(snapshot.status.hardwareOperators ?? {}).flatMap(item=>item.devices ?? []).map(item=>({id:item.id,nodeUid:item.nodeUid,pciAddress:item.pciAddress})).sort((a,b)=>a.id.localeCompare(b.id))});

try {
  const options=preparationArguments(args);
  await privateDirectory(input);
  const interrupted=automaticInputRecovery(await optional('.preparation-accepting.json'),options.automatic === true);
  for(const name of ['.setup-access-restore.json','.setup-bootstrap.kubeconfig','.setup-license-trust-pending.json',
    '.setup-license-activation-pending.json','.setup-model-stops.json','.setup-module-fixture.json']) {
    try {await lstat(join(input,name));throw new HarnessError('CONFLICT');}
    catch(error) {if(error.code !== 'ENOENT')throw error;}
  }
  const source=await sources();
  if(!source.parsed.caFile && [source.parsed.dashboardUrl,source.parsed.identityUrl,source.parsed.inferenceUrl]
    .some(origin=>origin && new URL(origin).hostname.endsWith('.local'))) {
    console.error('Local appliance endpoints require an approved CA. Re-run setup with a trusted PEM or --ca-kubeconfig PATH before preparing inputs.');
    throw new HarnessError('TLS');
  }
  if(!worker) {
    // Chromium needs NSS trust; Node reads NODE_EXTRA_CA_CERTS only at startup.
    // Run the worker with a fresh private home, never ignore HTTPS errors.
    const trust=await browserTrust(source.parsed.caFile);home=trust.home;
    const environment={...trust.environment,REGRESSION_INPUT_DIR:input};
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--worker',...args],{env:environment,stdio:'inherit'});
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
    process.exitCode=await new Promise(resolveExit=>{child.once('error',()=>resolveExit(2));child.once('close',code=>resolveExit(code ?? 2));});
  } else {
    browser=await chromium.launch();
    if(options.accept) {
      const directory=join(input,'prepared',options.accept);
      const plan=JSON.parse(await readPrivate(join(directory,'plan.json')));
      const candidate=JSON.parse(await readPrivate(join(directory,'lab.json')));
      const profile=JSON.parse(await readPrivate(join(directory,'remaining-p0.json')));
      const drills=plan.files.includes('host-drills.json') ? JSON.parse(await readPrivate(join(directory,'host-drills.json'))) : undefined;
      requireSafe(inputHash({candidate,profile,drills}) === plan.contentHash,'REVISION');
      const {snapshot,prepared}=await discover(source,plan.options);
      validateAcceptance(plan,source.hash,targetHash(prepared,snapshot));
      // An acceptance does not acquire or overwrite a Lease, stop models, or
      // approve a newly busy host. The actual suite still performs preflight.
      requireSafe(snapshot.leaseIdle && snapshot.models.activations.every(item=>item.spec?.type !== 'local' || item.spec.enabled === false) &&
        snapshot.hosts.every(host=>!host.software?.busy && !host.updates?.busy && (!host.operation || ['Succeeded','Failed','Cancelled'].includes(host.operation.phase))),'BUSY');
      parseLabConfig(candidate,input);
      await writePrivate(join(directory,'previous-inputs.json'),{lab:source.lab,profile:source.profile,drills:source.drills},true);
      await writePrivate(join(input,'.preparation-accepting.json'),{version:1,id:options.accept},true);
      await writePrivate(join(input,'remaining-p0.json'),profile);
      if(drills)await writePrivate(join(input,'host-drills.json'),drills);
      await writePrivate(join(input,'lab.json'),candidate);
      await writePrivate(join(directory,'accepted.json'),{version:1,acceptedAt:new Date().toISOString(),testExecutionVerified:false},true);
      await rm(join(input,'.preparation-accepting.json'));
      console.log('Reviewed inputs accepted after a fresh identity/boot/source/image check. No appliance state was changed.');
      console.log('Run preflight, then the selected phases. Missing external prerequisites still block full acceptance.');
    } else {
      const {snapshot,prepared,effectiveOptions}=await discover(source,options);
      snapshot.ci=await ciCandidates(source,snapshot,effectiveOptions);
      const profile=options.automatic ? automaticProfile(snapshot,source.profile,prepared.parsed) :
        preparedProfile(source.profile,snapshot,effectiveOptions,source.lab.expected);
      snapshot.readableFiles=await readableReferences(profile,prepared.parsed);
      const host=snapshot.hosts.find(item=>item.nodeUid === prepared.parsed.gpu?.nodeUid) ?? snapshot.hosts.find(item=>item.available);
      const drills=options.automatic && host ? automaticHostRecipes(prepared.parsed,host) : preparedReboot(prepared.parsed,snapshot,effectiveOptions);
      snapshot.drills=drills;
      const readiness=inputReadiness(prepared.parsed,profile,snapshot,effectiveOptions);
      const id=randomUUID(),directory=join(input,'prepared',id);
      await privateDirectory(join(input,'prepared'));await privateDirectory(directory);
      const plan={version:1,kind:'input-preparation',createdAt:new Date().toISOString(),options:effectiveOptions,originalHash:source.hash,
        snapshotHash:targetHash(prepared,snapshot),contentHash:inputHash({candidate:prepared.lab,profile,drills}),
        changes:pinChanges(source.lab,prepared.lab),files:['lab.json','remaining-p0.json',...(drills ? ['host-drills.json'] : [])],
        readiness,testExecutionVerified:false,applianceMutationsEnabled:false};
      await writePrivate(join(directory,'lab.json'),prepared.lab,true);
      await writePrivate(join(directory,'remaining-p0.json'),profile,true);
      if(drills)await writePrivate(join(directory,'host-drills.json'),drills,true);
      await writePrivate(join(directory,'plan.json'),plan,true);
      await writePrivate(join(input,'.preparation-latest.json'),{version:1,id,originalHash:source.hash});
      // Private inventory is an allowlist, never raw API/Kubernetes payloads,
      // user lists, Secrets, invites, cookies or runtime command output.
      await writePrivate(join(directory,'inventory.json'),{version:1,nodes:snapshot.nodes.map(node=>({name:node.metadata.name,
        uid:node.metadata.uid,bootId:node.status?.nodeInfo?.bootID,kernel:node.status?.nodeInfo?.kernelVersion})),
        devices:Object.values(snapshot.status.hardwareOperators ?? {}).flatMap(item=>item.devices ?? []).map(device=>({id:device.id,
          node:device.node,nodeUid:device.nodeUid,vendor:device.vendor,name:device.name,pciAddress:device.pciAddress,memoryTotalMi:device.memoryTotalMi})),
        memory:snapshot.models.computeMemory,source:snapshot.flux,images:snapshot.images},true);
      if(options.automatic) {
        requireSafe(snapshot.leaseIdle,'LOCK_BUSY');
        if(interrupted) {
          await writePrivate(join(directory,'interrupted-input-recovery.json'),{version:1,previousId:interrupted,
            registeredApplianceUid:prepared.parsed.expected.applianceUid,regeneratedAt:new Date().toISOString()},true);
          await rm(join(input,'.preparation-accepting.json'));
        }
        await writePrivate(join(input,'.preparation-accepting.json'),{version:1,id,automatic:true},true);
        await writePrivate(join(input,'remaining-p0.json'),profile);
        if(drills)await writePrivate(join(input,'host-drills.json'),drills);
        else await rm(join(input,'host-drills.json'),{force:true});
        await writePrivate(join(input,'lab.json'),prepared.lab);
        await writePrivate(join(directory,'accepted.json'),{version:1,automatic:true,acceptedAt:new Date().toISOString(),testExecutionVerified:false},true);
        await rm(join(input,'.preparation-accepting.json'));
        await writePrivate(join(input,'automatic-preparation.json'),{version:1,kind:'automatic-lab-preparation',id,
          policyVersion:labPolicy.version,preparedAt:new Date().toISOString(),testExecutionVerified:false,
          missingPrerequisites:readiness.flatMap(item=>item.measures.map(measure=>({phase:item.phase,id:measure.id,
            missing:measure.missing,actions:measure.actions})))});
        await writePrivate(join(input,'automatic-preparation.txt'),'Automatic prerequisite inventory — not a test result.\n'+
          'Every selected test will execute or report its own missing prerequisite; no phase is skipped based on this inventory.\n'+
          readinessLines(readiness).join('\n')+'\n');
        console.log('Automatic preparation complete: current registered installation, scoped access and catalog-derived fixtures.');
        console.log('All selected tests will run. Missing hardware, peer or CI evidence is reported by the affected test only.');
      } else {
      const lines=['Input preparation only — NOT regression acceptance.',
        'Changed pin groups: '+(plan.changes.join(', ') || 'none'),...readinessLines(readiness),
        'Actions above are guidance, not executed operations or test approval. Missing external fixtures cannot be waived by --approve.',
        'Review the private candidate files and inventory. Accepted inputs were not overwritten.',
        'Accept within 15 minutes (the target is rechecked): bash tools/regression.sh prepare --accept '+id];
      await writePrivate(join(directory,'readiness.txt'),lines.join('\n')+'\n',true);
      console.log(lines.join('\n'));
      console.log('Private candidate: .regression/inputs/prepared/'+id+'/');
      }
    }
  }
} catch(error) {
  console.error(error instanceof HarnessError ? error.message : new HarnessError('UNEXPECTED').message);
  console.error('The registered installation was not replaced. Check the private preparation report; TLS and observer checks remain mandatory.');
  process.exitCode=error instanceof HarnessError && error.outcome === 'Blocked' ? 2 : 1;
} finally {await context?.close();await browser?.close();if(home)await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
