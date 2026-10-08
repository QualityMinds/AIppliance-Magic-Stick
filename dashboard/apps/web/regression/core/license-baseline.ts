import {createHash} from 'node:crypto';
import {join} from 'node:path';
import type {LiveFoundation} from './live-foundation.ts';
import {KubectlObserver,verifyObserverRules,type KubeObject} from './observer.ts';
import {readPrivate,writePrivate,withPrivateCommandInput} from './private-files.ts';
import {requireSafe} from './errors.ts';
import {AdministrationApi} from './administration-api.ts';
import {poll} from './poll.ts';
import {canonicalInput} from './input-preparation.ts';

type LicenseSecret=KubeObject & {data:Record<string,string>};
const fingerprint=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Exact document-only CAS. Never delete/recreate the installation identity,
 * touch issuer trust, or replace unknown Secret fields. */
export function licenseDocumentPatch(secret:LicenseSecret,installationId:string,document:string|null) {
  requireSafe(secret.metadata.name === 'magicstick-license' && secret.metadata.namespace === 'identity-system' &&
    secret.metadata.uid && secret.metadata.resourceVersion && secret.data && !Array.isArray(secret.data) &&
    Buffer.from(secret.data.installationId ?? '', 'base64').toString() === installationId &&
    (document === null || document.length <= 64*1024 && !document.includes('PRIVATE KEY')),'IDENTITY');
  const operations:Array<Record<string,unknown>>=[
    {op:'test',path:'/metadata/uid',value:secret.metadata.uid},
    {op:'test',path:'/metadata/resourceVersion',value:secret.metadata.resourceVersion},
    {op:'test',path:'/data',value:secret.data},
  ];
  if(document === null) {
    requireSafe(typeof secret.data['license.json'] === 'string' && secret.data['license.json'].length > 0,'CONFLICT');
    operations.push({op:'remove',path:'/data/license.json'});
  } else operations.push({op:Object.hasOwn(secret.data,'license.json') ? 'replace' : 'add',path:'/data/license.json',value:Buffer.from(document).toString('base64')});
  return operations;
}
class LicenseResetter extends KubectlObserver {
  async verifyScope(namespaces:string[]) {
    await readPrivate(this.kubeconfig);
    const config=JSON.parse(await this.command(['config','view','--raw','--minify','-o','json']));
    requireSafe(config.clusters?.length === 1 && config.clusters[0].cluster?.server?.startsWith('https://') &&
      !config.clusters[0].cluster['insecure-skip-tls-verify'] && config.users?.length === 1 &&
      !config.users[0].user?.exec && !config.users[0].user?.['auth-provider'],'OBSERVER');
    requireSafe(namespaces.includes('identity-system') && namespaces.every(name=>/^[a-z0-9-]+$/.test(name)),'OBSERVER');
    for(const namespace of namespaces) {
      const review=JSON.parse(await this.command(['create','--raw','/apis/authorization.k8s.io/v1/selfsubjectrulesreviews','-f','-'],
        JSON.stringify({apiVersion:'authorization.k8s.io/v1',kind:'SelfSubjectRulesReview',spec:{namespace}})));
      if(namespace !== 'identity-system'){verifyObserverRules(review);continue;}
      requireSafe(review.status?.incomplete === false && Array.isArray(review.status.resourceRules),'OBSERVER');
      let allowed=false;
      for(const rule of review.status.resourceRules) {
        const exact=rule.apiGroups?.join(',') === '' && rule.resources?.join(',') === 'secrets' &&
          rule.resourceNames?.join(',') === 'magicstick-license' && rule.verbs?.every((verb:string)=>['get','patch'].includes(verb));
        const selfReview=rule.apiGroups?.every((group:string)=>['authorization.k8s.io','authentication.k8s.io'].includes(group)) &&
          rule.resources?.every((resource:string)=>['selfsubjectaccessreviews','selfsubjectrulesreviews','selfsubjectreviews'].includes(resource)) && rule.verbs?.join(',') === 'create';
        requireSafe(exact || selfReview,'OBSERVER');
        if(exact && rule.verbs.includes('get') && rule.verbs.includes('patch'))allowed=true;
      }
      requireSafe(allowed,'OBSERVER');
    }
  }
  async state(){return JSON.parse(await this.command(['get','secret','magicstick-license','--namespace=identity-system','-o','json'])) as LicenseSecret;}
  async document(secret:LicenseSecret,installationId:string,document:string|null) {
    const patch=licenseDocumentPatch(secret,installationId,document);
    await withPrivateCommandInput(patch,filename=>this.command(['patch','secret','magicstick-license','--namespace=identity-system',
      '--type=json','--patch-file='+filename,'-o','name']));
  }
}

/** LIC-01/SSO-01 need a real no-document state even on repeated campaigns.
 * Scope is explicit; the original document is restored byte-for-byte before
 * any activation/federation workflow. No permanent downgrade in setup. */
export async function withUnlicensedBaseline<T>(live:LiveFoundation,action:()=>Promise<T>):Promise<T> {
  const api=new AdministrationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard);
  const status=await api.api.licenseStatus();
  if(!status.hasDocument)return action();
  const profile=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!));
  const fixture=profile.license?.baseline;
  requireSafe(fixture?.approveNoFileBaseline === true && fixture.kubeconfig &&
    fixture.kubeconfig !== live.config.observerKubeconfig && fixture.kubeconfig !== live.config.lock?.kubeconfig,'PREREQUISITE');
  const resetter=new LicenseResetter(fixture.kubeconfig,live.config.requestTimeoutMs);
  await resetter.verifyScope((await live.observer.list('namespaces')).map(item=>String(item.metadata.name)));
  const original=await resetter.state(),document=(await api.api.exportLicense()).content;
  requireSafe(Buffer.from(original.data['license.json'] ?? '', 'base64').toString() === document,'CONFLICT');
  const receipt=join(process.env.REGRESSION_RUN_DIR!,'license-baseline.json');
  await writePrivate(join(process.env.REGRESSION_RUN_DIR!,'license-baseline-original.license'),document,true);
  await writePrivate(receipt,{version:1,installationId:status.installationId,secretUid:original.metadata.uid,
    originalHash:fingerprint(document),state:'requested'},true);
  let empty:LicenseSecret|undefined;
  try {
    await live.guard();await resetter.document(original,status.installationId,null);
    empty=await resetter.state();
    requireSafe(empty.metadata.uid === original.metadata.uid && !empty.data['license.json'],'CONFLICT');
    await poll(()=>api.api.licenseStatus(),value=>!value.hasDocument,{timeoutMs:30_000,intervalMs:500,stage:'host-readiness'});
    return await action();
  } finally {
    // An ambiguous patch may only be reconciled against this exact unchanged
    // Secret data and UID; never overwrite a concurrent license activation.
    const current=await resetter.state();
    if(current.metadata.resourceVersion === original.metadata.resourceVersion) {
      requireSafe(current.metadata.uid === original.metadata.uid && current.data['license.json'] === original.data['license.json'],'CONFLICT');
    } else {
      requireSafe(current.metadata.uid === original.metadata.uid && !current.data['license.json'] &&
        (!empty || current.metadata.resourceVersion === empty.metadata.resourceVersion) &&
        canonicalInput(current.data) === canonicalInput(Object.fromEntries(Object.entries(original.data).filter(([key])=>key !== 'license.json'))),'CONFLICT');
      await live.guard();await resetter.document(current,status.installationId,document);
      await poll(async()=>{const restored=await api.api.licenseStatus();return restored.hasDocument ? (await api.api.exportLicense()).content : '';},
        value=>value === document,{timeoutMs:30_000,intervalMs:500,stage:'host-readiness'});
    }
    await writePrivate(receipt,{version:1,installationId:status.installationId,secretUid:original.metadata.uid,
      originalHash:fingerprint(document),state:'restored'});
  }
}
