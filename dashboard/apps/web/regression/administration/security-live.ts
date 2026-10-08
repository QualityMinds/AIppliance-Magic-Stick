import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import type {LiveFoundation} from '../core/live-foundation.ts';
import {readPrivate,writePrivate} from '../core/private-files.ts';
import {requireProof as requireSafe} from '../core/errors.ts';
import {canonical} from '../core/borrowed-sharing.ts';
import {AdministrationApi} from '../core/administration-api.ts';
import {openInferenceSession} from '../core/auth.ts';
import {disposableUnmanagedKey,UnmanagedKeyFixtureClient,verifyUnmanagedKey} from '../core/unmanaged-key-fixture.ts';

type Rule={apiGroups?:string[];resources?:string[];verbs?:string[];resourceNames?:string[];nonResourceURLs?:string[]};
export function normalizeRules(rules:Rule[]) {
  return rules.map(rule=>Object.fromEntries(Object.entries(rule).map(([key,value])=>[key,[...value].sort()])))
    .map(canonical).sort();
}
export function ordinaryDashboardRules(rules:Rule[]) {
  return rules.every(rule=>!rule.resources?.some(resource=>resource === 'secrets' || resource.includes('*')) &&
    !rule.verbs?.includes('*') && !rule.apiGroups?.includes('*') && !rule.nonResourceURLs?.includes('*'));
}
async function shipped(path:string) {
  const source=await readFile(resolve('../../..',path),'utf8');
  return JSON.parse(execFileSync('python3',['-c','import sys,json,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],
    {input:source,encoding:'utf8',timeout:5000,maxBuffer:256*1024}));
}
async function shippedRbac(path:string) {
  const source=await readFile(resolve('../../..',path),'utf8');
  return JSON.parse(execFileSync('python3',['-c','import sys,json,yaml; print(json.dumps([d for d in yaml.safe_load_all(sys.stdin.read()) if d and d.get("kind") in ("Role","RoleBinding")]))'],
    {input:source,encoding:'utf8',timeout:5000,maxBuffer:256*1024})) as Array<{kind:string;metadata:{name:string;namespace:string};rules?:Rule[];roleRef?:unknown;subjects?:unknown}>;
}
export async function rbacWorkflow(live:LiveFoundation) {
  const expected=await shipped('magic-cluster/apps/dashboard/clusterrole.yaml'),binding=await shipped('magic-cluster/apps/dashboard/clusterrolebinding.yaml');
  const role=await live.observer.get('clusterroles.rbac.authorization.k8s.io',undefined,expected.metadata.name) as unknown as {rules:Rule[]};
  requireSafe(ordinaryDashboardRules(role.rules) && canonical(normalizeRules(role.rules)) === canonical(normalizeRules(expected.rules)),'API');
  const bindings=await live.observer.list('clusterrolebindings.rbac.authorization.k8s.io');
  const relevant=bindings.filter(item=>(item as unknown as {subjects?:Array<{kind:string;name:string;namespace:string}>}).subjects?.some(subject=>
    subject.kind === 'ServiceAccount' && subject.name === 'ai-appliance-dashboard-api' && subject.namespace === 'identity-system'));
  requireSafe(relevant.length === 1,'API');
  const actual=relevant[0] as unknown as {metadata:{name:string};roleRef:unknown;subjects:unknown};
  requireSafe(actual.metadata.name === binding.metadata.name && canonical(actual.roleRef) === canonical(binding.roleRef) && canonical(actual.subjects) === canonical(binding.subjects),'API');
  const shippedNamespaced=(await Promise.all(['host-management','federation-admin','settings','model-secrets','user-admin','license']
    .map(name=>shippedRbac(`magic-cluster/apps/dashboard/${name}-rbac.yaml`)))).flat();
  const namespaced=await live.observer.list('rolebindings.rbac.authorization.k8s.io');
  const attached=namespaced.filter(item=>(item as unknown as {subjects?:Array<{kind:string;name:string;namespace:string}>}).subjects?.some(subject=>
    subject.kind === 'ServiceAccount' && subject.name === 'ai-appliance-dashboard-api' && subject.namespace === 'identity-system'));
  const expectedBindings=shippedNamespaced.filter(item=>item.kind === 'RoleBinding');
  requireSafe(attached.length === expectedBindings.length,'API');
  for(const target of expectedBindings) {
    const observed=attached.find(item=>item.metadata.name === target.metadata.name && item.metadata.namespace === target.metadata.namespace) as unknown as
      {roleRef?:unknown;subjects?:unknown}|undefined;
    requireSafe(observed && canonical(observed.roleRef) === canonical(target.roleRef) && canonical(observed.subjects) === canonical(target.subjects),'API');
  }
  for(const target of shippedNamespaced.filter(item=>item.kind === 'Role')) {
    const observed=await live.observer.get('roles.rbac.authorization.k8s.io',target.metadata.namespace,target.metadata.name) as unknown as {rules:Rule[]};
    // Namespaced model/license credential grants exist intentionally. Compare
    // exact shipped scopes; never read a Secret merely to prove access.
    requireSafe(canonical(normalizeRules(observed.rules)) === canonical(normalizeRules(target.rules!)),'API');
  }
  // The web container must not contain a mounted Kubernetes service token. The
  // API service account is intentionally separate and has only shipped grants.
  const web=live.snapshot.pods.filter(item=>item.metadata.labels?.['app.kubernetes.io/name'] === 'magicstick-dashboard');
  requireSafe(web.length > 0,'API');
  for(const pod of web) {
    const spec=pod.spec as {automountServiceAccountToken?:boolean;volumes?:Array<{projected?:{sources?:Array<{serviceAccountToken?:unknown}>}}>} ;
    requireSafe(spec.automountServiceAccountToken === false && !spec.volumes?.some(volume=>volume.projected?.sources?.some(source=>source.serviceAccountToken)),'API');
  }
  const policies=await live.observer.list('securitypolicies.gateway.envoyproxy.io','identity-system');
  requireSafe(policies.some(policy=>(policy.spec?.targetRefs as Array<{name:string}> | undefined)?.some(ref=>ref.name === 'dashboard-local') && policy.spec?.oidc),'API');
  for(const policy of policies.filter(item=>item.spec?.oidc)) {
    const oidc=policy.spec!.oidc as {clientSecret?:{name?:string;namespace?:string};provider?:{issuer?:string}};
    requireSafe(oidc.clientSecret?.name && (!oidc.clientSecret.namespace || oidc.clientSecret.namespace === 'identity-system') &&
      oidc.provider?.issuer?.startsWith(live.config.identityUrl+'/'),'API');
  }
}
export async function unmanagedKeyWorkflow(live:LiveFoundation) {
  const plan=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!)).unmanagedKey;
  requireSafe(plan?.approveDisposableProbe === true && (plan.createDisposableFixture === true || /^[a-f0-9]{64}$/.test(plan.id ?? '')) && live.config.inferenceUrl,'PREREQUISITE');
  await openInferenceSession(live.context,live.config.inferenceUrl,live.config.loginTimeoutMs);
  const api=new AdministrationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard);
  const values=(await api.api.moduleCredentials('litellm')).credentials ?? [];
  const master=values.find(item=>item.key === 'master_key')?.value;
  requireSafe(master && master.startsWith('sk-'),'PREREQUISITE');
  const fixtureClient=new UnmanagedKeyFixtureClient(live.context.request,live.config.inferenceUrl,master,live.guard,live.config.requestTimeoutMs);
  const fixture=plan.createDisposableFixture === true ? disposableUnmanagedKey(live.journal.runId,live.config.expected.applianceUid) : undefined;
  const id=fixture?.identity.id ?? plan.id;
  const receipt=join(process.env.REGRESSION_RUN_DIR!,'unmanaged-key-fixture.json');
  if(fixture)await writePrivate(receipt,{version:1,...fixture.identity,state:'requested'},true);
  try {
    if(fixture) {
      await fixtureClient.create(fixture);
      await writePrivate(receipt,{version:1,...fixture.identity,state:'owned'});
    }
    // A missing random key is not an unmanaged-key protection test. Prove that
    // the actual unrelated record exists before and after Dashboard refusal.
    verifyUnmanagedKey(await fixtureClient.inspect(id),fixture?.identity);
    const before=await live.keys.list();requireSafe(!before.items.some(item=>item.id === id),'PREREQUISITE');
    await live.guard();
    const response=await live.context.request.delete(live.config.dashboardUrl+'/api/api-access/'+id,{timeout:live.config.requestTimeoutMs,maxRedirects:0,
      headers:{Origin:live.config.dashboardUrl,'X-MagicStick-CSRF':'dashboard'}});
    requireSafe([403,404].includes(response.status()) && canonical(await live.keys.list()) === canonical(before),'API');
    verifyUnmanagedKey(await fixtureClient.inspect(id),fixture?.identity);
  }finally {
    if(fixture) {
      await fixtureClient.removeOwned(fixture.identity);
      await writePrivate(receipt,{version:1,...fixture.identity,state:'removed'});
    }
  }
}

export function currentSecurityCiRun(value:any,path:string,revision:string,now=Date.now()) {
  const updated=Date.parse(value?.updated_at ?? '');
  return value?.path === path && value.head_sha === revision && value.status === 'completed' && value.conclusion === 'success' &&
    Number.isFinite(updated) && updated <= now && now-updated <= 8*86400_000 && value.repository?.full_name === 'QualityMinds/AIppliance-Magic-Stick';
}

/** Offline safety contracts do not certify current vulnerability/secret status.
 * Accept only fresh successful fixed-workflow runs for the pinned installation
 * revision. A manually supplied local "clean" report is never evidence. */
export async function securityCiWorkflow(live:LiveFoundation) {
  const plan=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!)).securityCi;
  requireSafe(/^[a-f0-9]{40}$/.test(plan?.sourceRevision ?? '') && live.config.expected.flux?.revision.endsWith(plan.sourceRevision) &&
    ['dependenciesRunId','publicationRunId'].every(key=>Number.isSafeInteger(plan[key]) && plan[key] > 0),'PREREQUISITE');
  const headers:Record<string,string>={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  if(plan.tokenFile)headers.Authorization='Bearer '+(await readPrivate(plan.tokenFile)).trim();
  const root='https://api.github.com/repos/QualityMinds/AIppliance-Magic-Stick/actions/runs/';
  const proofs=[];
  for(const [key,path,job] of [['dependenciesRunId','.github/workflows/dependency-security.yml','advisories'],
    ['publicationRunId','.github/workflows/public-release-checks.yml','release-checks']] as const) {
    const response=await live.context.request.get(root+plan[key],{headers,timeout:live.config.requestTimeoutMs,maxRedirects:0});
    requireSafe(response.status() === 200 && (await response.body()).length < 256*1024,'API');
    const run=await response.json();requireSafe(currentSecurityCiRun(run,path,plan.sourceRevision),'REVISION');
    const jobs=await live.context.request.get(root+plan[key]+'/jobs?per_page=100',{headers,timeout:live.config.requestTimeoutMs,maxRedirects:0});
    requireSafe(jobs.status() === 200 && (await jobs.body()).length < 512*1024,'API');
    const listing=await jobs.json();requireSafe(Array.isArray(listing.jobs) && listing.jobs.some((item:any)=>item.name === job &&
      item.conclusion === 'success' && item.status === 'completed'),'API');
    proofs.push({runId:plan[key],workflow:path,job});
  }
  await writePrivate(join(process.env.REGRESSION_RUN_DIR!,'security-ci.json'),{version:1,sourceRevision:plan.sourceRevision,checkedAt:new Date().toISOString(),proofs},true);
}
