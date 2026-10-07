import {spawn} from 'node:child_process';
import {readFile, lstat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {readPrivate,writePrivate,withPrivateCommandInput} from './private-files.ts';
import {requireSafe,HarnessError} from './errors.ts';
import {labPolicy,parseRegistration,type LabRegistration} from './lab-policy.ts';
import {createTestLicenseSigner,validateTestLicenseSigner,testLicenseDocument} from './test-license-fixtures.ts';
import {leaseHolderReason} from './lease.ts';

/** Used only while the bootstrap worker holds a transient administrator
 * credential. Arguments are repository-owned; stderr/tokens never escape. */
export function bootstrapCommand(kubeconfig:string,args:string[],data?:unknown):Promise<any> {
  return new Promise((resolve,reject)=>{
    const child=spawn('kubectl',['--kubeconfig',kubeconfig,'--request-timeout=20s',...args],{stdio:['pipe','pipe','pipe']});
    let output='',size=0,done=false;
    const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);
      if(error)reject(error);else if(args[0] === 'apply')resolve({});
      else try{resolve(JSON.parse(output || '{}'));}catch{reject(new HarnessError('API'));}};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new HarnessError('DEADLINE'));},25_000);
    child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length > 8*1024*1024){child.kill('SIGKILL');finish(new HarnessError('API'));}});
    child.stderr.on('data',chunk=>{size+=chunk.length;if(size > 1024*1024)child.kill('SIGKILL');});
    child.on('error',()=>finish(new HarnessError('API')));child.stdin.on('error',()=>finish(new HarnessError('API')));
    child.on('close',code=>finish(code === 0 ? undefined : new HarnessError('API')));
    child.stdin.end(typeof data === 'string' ? data : data === undefined ? undefined : JSON.stringify(data));
  });
}
async function present(filename:string) {try{await lstat(filename);return true;}catch(error){if((error as NodeJS.ErrnoException).code === 'ENOENT')return false;throw error;}}
export async function bootstrapRegisteredLab(directory:string,value:unknown,register:boolean) {
  const registration=parseRegistration(value),file=join(directory,'.setup-bootstrap.kubeconfig');
  await readPrivate(file);
  const command=(args:string[],data?:unknown)=>bootstrapCommand(file,args,data);
  const selected=await command(['config','view','--raw','--minify','--flatten','-o','json']);
  const cluster=selected.clusters?.[0]?.cluster;
  requireSafe(selected.clusters?.length === 1 && cluster && cluster['certificate-authority-data'] &&
    !cluster['insecure-skip-tls-verify'] && Object.keys(cluster).every(key=>['server','certificate-authority-data','tls-server-name'].includes(key)),'TLS');
  const url=new URL(cluster.server);requireSafe(url.protocol === 'https:' && !url.username && !url.password,'TLS');
  const appliances=(await command(['get','appliances.appliance.magicstick.dev','-A','-o','json'])).items;
  const nodes=(await command(['get','nodes','-o','json'])).items;
  requireSafe(appliances?.length === 1 && appliances[0].metadata.uid === registration.applianceUid &&
    appliances[0].metadata.namespace === 'ai-system' && appliances[0].metadata.name === 'local' &&
    nodes?.length === registration.nodeUids.length && nodes.every((n:any)=>registration.nodeUids.includes(n.metadata.uid)),'LAB');
  const maps=(await command(['get','configmaps','-A','-o','json'])).items;
  const marker=maps.find((m:any)=>m.metadata.namespace === labPolicy.namespace && m.metadata.name === labPolicy.marker);
  if(marker)requireSafe(marker.immutable === true && marker.data?.policyVersion === String(labPolicy.version) &&
    marker.data?.registrationId === registration.id && marker.data?.kind === registration.kind &&
    marker.data?.nodeUids === [...registration.nodeUids].sort().join(',') &&
    marker.metadata.labels?.['regression.magicstick.dev/appliance-uid'] === registration.applianceUid,'LAB');
  else requireSafe(register,'LAB'); // all/CI must never register a new target.
  const leases=(await command(['get','leases.coordination.k8s.io','-A','-o','json'])).items;
  const lease=leases.find((m:any)=>m.metadata.namespace === labPolicy.namespace && m.metadata.name === 'lab-lock');
  if(lease) {
    requireSafe(lease.metadata.labels?.['regression.magicstick.dev/appliance-uid'] === registration.applianceUid,'LAB');
    const reason=leaseHolderReason(lease);
    if(reason)throw new HarnessError(reason);
  }
  const documents:string[]=[];
  for(const name of ['lab-rbac.example.yaml','lab-rbac-model-cleaner.example.yaml','lab-rbac-gpu-observer.example.yaml',
    'lab-rbac-administration.example.yaml','lab-rbac-license-resetter.example.yaml']) {
    const source=await readFile(new URL('../'+name,import.meta.url),'utf8');
    for(const document of source.split(/^---\s*$/m))if(document.trim() && !(lease && /^kind: Lease$/m.test(document)))
      documents.push(document.replaceAll('CHANGEME',registration.applianceUid).trim());
  }
  const manifest=documents.join('\n---\n')+'\n';
  await command(['apply','--dry-run=server','-f','-','-o','json'],manifest);
  await command(['apply','-f','-','-o','json'],manifest);
  if(!marker)await command(['create','-f','-','-o','json'],{apiVersion:'v1',kind:'ConfigMap',metadata:{name:labPolicy.marker,
    namespace:labPolicy.namespace,labels:{'regression.magicstick.dev/appliance-uid':registration.applianceUid}},
    immutable:true,data:{registrationId:registration.id,policyVersion:String(labPolicy.version),kind:registration.kind,
      nodeUids:[...registration.nodeUids].sort().join(',')}});
  const accounts:Record<string,string>={'observer.yaml':'regression-observer','locker.yaml':'regression-locker',
    'model-cleaner.yaml':'regression-model-cleaner','app-cleaner.kubeconfig':'regression-app-cleaner',
    'api-restarter.kubeconfig':'regression-api-restarter','license-resetter.kubeconfig':'regression-license-resetter'};
  const expires:Record<string,string>={};
  for(const [filename,name] of Object.entries(accounts)) {
    const response=await command(['create','--raw',`/api/v1/namespaces/${labPolicy.namespace}/serviceaccounts/${name}/token`,'-f','-'],
      {apiVersion:'authentication.k8s.io/v1',kind:'TokenRequest',spec:{expirationSeconds:labPolicy.credentialSeconds}});
    const {token,expirationTimestamp}=response.status ?? {};
    requireSafe(typeof token === 'string' && token.length > 10 && token.length < 32768 && !/[\s\0]/.test(token) &&
      Date.parse(expirationTimestamp) > Date.now() && Date.parse(expirationTimestamp)-Date.now() <= 86_460_000,'AUTH');
    await writePrivate(join(directory,filename),{apiVersion:'v1',kind:'Config',clusters:[{name:'lab',cluster}],
      users:[{name,user:{token}}],contexts:[{name:'lab',context:{cluster:'lab',user:name}}],'current-context':'lab'});
    expires[filename]=expirationTimestamp;
  }
  await writePrivate(join(directory,'credential-expiry.json'),{version:1,expires});
  return registration;
}

/** Test signing keys never leave the private input directory. Add only their
 * public key to the optional local store, preserving official/existing keys. */
export async function bootstrapTestLicenses(directory:string,registration:LabRegistration,installationId:string) {
  const filename=join(directory,'test-license-signer.json');
  const signer=await present(filename) ? validateTestLicenseSigner(JSON.parse(await readPrivate(filename)),registration.applianceUid,installationId) :
    createTestLicenseSigner(registration.applianceUid,installationId);
  if(!await present(filename))await writePrivate(filename,signer,true);
  for(const kind of ['valid','expired','wrong-installation','tampered','short-lived'] as const)
    await writePrivate(join(directory,`license-${kind}.license`),testLicenseDocument(signer,kind));
  const command=(args:string[],data?:unknown)=>bootstrapCommand(join(directory,'.setup-bootstrap.kubeconfig'),args,data);
  const map=await command(['get','configmap','magicstick-license-trust','-n','identity-system','-o','json']);
  const original=map.data?.['trusted-keys.json'],store=JSON.parse(original);
  requireSafe(store.keys && typeof store.keys === 'object' && Object.keys(store).join(',') === 'keys','CONFIG');
  requireSafe(!store.keys[signer.kid] || store.keys[signer.kid] === signer.publicKey,'CONFLICT');
  const pendingFile=join(directory,'.setup-license-trust-pending.json');
  if(await present(pendingFile)) {
    const pending=JSON.parse(await readPrivate(pendingFile));
    requireSafe(pending.applianceUid === registration.applianceUid && pending.mapUid === map.metadata.uid &&
      pending.kid === signer.kid && pending.publicKey === signer.publicKey,'CONFLICT');
    // Read before retrying: a lost response can already have applied the exact
    // public key. CAS protects all pre-existing keys from intervening changes.
    requireSafe(store.keys[signer.kid] === signer.publicKey || original === pending.original,'CONFLICT');
  }
  if(!store.keys[signer.kid]) {
    await writePrivate(pendingFile,{version:1,applianceUid:registration.applianceUid,mapUid:map.metadata.uid,
      kid:signer.kid,publicKey:signer.publicKey,original});
    await withPrivateCommandInput([
      {op:'test',path:'/metadata/uid',value:map.metadata.uid},{op:'test',path:'/metadata/resourceVersion',value:map.metadata.resourceVersion},
      {op:'test',path:'/data/trusted-keys.json',value:original},
      {op:'replace',path:'/data/trusted-keys.json',value:JSON.stringify({keys:{...store.keys,[signer.kid]:signer.publicKey}})},
    ],filename=>command(['patch','configmap','magicstick-license-trust','-n','identity-system','--type=json','--patch-file',filename,'-o','json']));
  }
  const verified=await command(['get','configmap','magicstick-license-trust','-n','identity-system','-o','json']);
  requireSafe(verified.metadata.uid === map.metadata.uid && JSON.parse(verified.data['trusted-keys.json']).keys[signer.kid] === signer.publicKey,'CONFLICT');
  await writePrivate(join(directory,'test-license-trust.json'),{version:1,applianceUid:registration.applianceUid,kid:signer.kid,fingerprint:signer.fingerprint});
  await rm(pendingFile,{force:true});
}
