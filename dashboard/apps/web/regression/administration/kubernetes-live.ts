import {expect,type Browser} from '@playwright/test';
import {join} from 'node:path';
import type {LiveFoundation} from '../core/live-foundation.ts';
import {OwnedIdentityClient} from '../core/owned-identity.ts';
import {realLogin} from '../core/auth.ts';
import {readPrivate,writePrivate} from '../core/private-files.ts';
import {parseKubeconfig,executeOidc,identityKubeRequest} from '../core/oidc-exec.ts';
import {HarnessError,requireProof as requireSafe} from '../core/errors.ts';
import {poll} from '../core/poll.ts';

/** Exercise generated kubeconfig, the real PKCE exec plugin and actual RBAC.
 * Negative mutation checks use SelfSubjectAccessReview: a broken deny rule must
 * fail the test without creating an arbitrary Pod or reading a Secret. */
export async function kubernetesWorkflow(live:LiveFoundation,browser:Browser) {
  const profile=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!));
  requireSafe(profile.identity?.approveDisposableUsers === true && profile.kubernetes?.plugin && profile.kubernetes.approveAdminGrant === true,'PREREQUISITE');
  const users=new OwnedIdentityClient(live),api=users.client;
  const proofs=new Set<string>(),created=await users.create('kube','viewer');
  const grant=async(level:string)=>api.write({method:'PUT',path:`/api/kubernetes-access/${created.user.id}`,body:{accessLevel:level}},
    ()=>api.api.updateKubernetesAccess(created.user.id,level));
  let initialized=false;
  for(const level of ['viewer','operator','admin'] as const) {
    await grant(level);
    const context=await realLogin(browser,live.config,{actor:{username:created.user.username,subject:created.user.id,role:'magicstick-viewer',
      password:created.password,...(!initialized ? {initialPassword:created.initialPassword} : {})}}); initialized=true;
    try {
      const exported=await api.api.kubeconfig(created.user.id),oidc=parseKubeconfig(exported.content,live.config.identityUrl);
      requireSafe(exported.accessLevel === level,'API');
      const token=await executeOidc(context,live.config,oidc,profile.kubernetes.plugin);
      const access=async(group:string,resource:string,verb:string,namespace?:string)=>{
        const result=await identityKubeRequest(oidc,token,'/apis/authorization.k8s.io/v1/selfsubjectaccessreviews',
          {apiVersion:'authorization.k8s.io/v1',kind:'SelfSubjectAccessReview',spec:{resourceAttributes:{group,resource,verb,...(namespace ? {namespace} : {})}}},'POST');
        requireSafe(result.status === 201 && typeof result.value.status?.allowed === 'boolean','API');return result.value.status.allowed as boolean;
      };
      const pods=await identityKubeRequest(oidc,token,'/api/v1/namespaces/ai/pods');
      requireSafe(pods.status === 200 && pods.value.kind === 'PodList','API');
      if(level !== 'admin') {
        for(const [group,resource,verb,ns] of [['','secrets','get','ai'],['','pods','create','ai'],['apps','deployments','create','ai'],
          ['appliance.magicstick.dev','modelactivations','create','default']]) requireSafe(!await access(group!,resource!,verb!,ns),'API');
      }
      if(level === 'viewer') {
        requireSafe(!await access('appliance.magicstick.dev','modelactivations','create','ai-system'),'API');proofs.add('K8S-02');
      } else if(level === 'operator') {
        const resources=[['ModuleActivation','moduleactivations',{module:live.journal.prefix+'unknown',enabled:false}],
          ['AppInstance','appinstances',{application:live.journal.prefix+'unknown',enabled:false,targetNamespace:'ai'}],
          ['ModelActivation','modelactivations',{type:'local',enabled:false,targetNamespace:'ai',local:{engine:'OLlama',url:'ollama://disabled-fixture',computeTarget:'cpu'}}]] as const;
        for(const [kind,plural,spec] of resources) {
          requireSafe(await access('appliance.magicstick.dev',plural,'create','ai-system') && await access('appliance.magicstick.dev',plural,'delete','ai-system'),'API');
          const name=live.journal.prefix+'kube-'+plural.slice(0,5),path='/apis/appliance.magicstick.dev/v1alpha1/namespaces/ai-system/'+plural;
          const receipt=join(process.env.REGRESSION_RUN_DIR!,'kube-'+plural+'.json');
          requireSafe((await identityKubeRequest(oidc,token,path+'/'+name)).status === 404,'OWNERSHIP');
          await writePrivate(receipt,{version:1,kind,namespace:'ai-system',name,state:'requested'},true);
          await live.guard();
          const result=await identityKubeRequest(oidc,token,path,{apiVersion:'appliance.magicstick.dev/v1alpha1',kind,
            metadata:{name,labels:{'regression.magicstick.dev/run':live.journal.runId}},spec},'POST');
          requireSafe(result.status === 201 && result.value.metadata?.uid && result.value.spec?.enabled === false,'API');
          const uid=result.value.metadata.uid;
          await writePrivate(receipt,{version:1,kind,namespace:'ai-system',name,uid,state:'owned'});
          try {
            const get=await identityKubeRequest(oidc,token,path+'/'+name); requireSafe(get.status === 200 && get.value.metadata.uid === uid,'OWNERSHIP');
            await live.guard();
            const update=await identityKubeRequest(oidc,token,path+'/'+name,{...get.value,
              metadata:{...get.value.metadata,annotations:{'regression.magicstick.dev/update':'verified'}}},'PUT');
            requireSafe(update.status === 200 && update.value.metadata.uid === uid && update.value.spec.enabled === false,'API');
          } finally {
            const current=await identityKubeRequest(oidc,token,path+'/'+name);
            requireSafe(current.status === 200 && current.value.metadata.uid === uid && current.value.spec.enabled === false,'OWNERSHIP');
            await live.guard();
            const removed=await identityKubeRequest(oidc,token,path+'/'+name,{apiVersion:'v1',kind:'DeleteOptions',
              preconditions:{uid,resourceVersion:current.value.metadata.resourceVersion}},'DELETE');
            requireSafe([200,202].includes(removed.status),'CLEANUP');
            await poll(()=>identityKubeRequest(oidc,token,path+'/'+name),value=>value.status === 404,{timeoutMs:30_000,intervalMs:500,stage:'cleanup'});
            await writePrivate(receipt,{version:1,kind,namespace:'ai-system',name,uid,state:'removed'});
          }
        }
        proofs.add('K8S-03');
      } else requireSafe(await access('','secrets','get','ai') && await access('rbac.authorization.k8s.io','clusterroles','create'),'API');
      const page=await live.context.newPage();
      try {
        await page.goto(live.config.dashboardUrl+'/#/kubernetes-access');
        await page.getByPlaceholder('Username, name, or email').fill(created.user.username);
        await page.getByRole('button',{name:'Search',exact:true}).click();
        const row=page.getByRole('row').filter({hasText:created.user.username});await expect(row).toBeVisible();
        await row.getByRole('button',{name:'Download Kubeconfig',exact:true}).click();
        await expect(page.getByText(`Kubeconfig downloaded for ${created.user.username}. It contains no token or password.`,{exact:true})).toBeVisible();
        await live.context.grantPermissions(['clipboard-read','clipboard-write'],{origin:live.config.dashboardUrl});
        await row.getByRole('button',{name:'Copy to Clipboard',exact:true}).click();
        const copied=await page.evaluate(()=>navigator.clipboard.readText());
        const parsed=parseKubeconfig(copied,live.config.identityUrl);
        requireSafe(parsed.server === oidc.server && parsed.client === oidc.client && parsed.issuer === oidc.issuer &&
          parsed.ca.equals(oidc.ca) && parsed.issuerCa === oidc.issuerCa,'API');
        await page.evaluate(()=>navigator.clipboard.writeText(''));
      } finally {await page.close();}
      proofs.add('K8S-04');proofs.add('K8S-05');
      // A removed group may remain in an old JWT until expiry. Prove the
      // required fresh OIDC/session invalidation boundary, not instantaneous
      // revocation of an already signed offline token.
      await grant('none');
      const fresh=await executeOidc(context,live.config,oidc,profile.kubernetes.plugin);
      requireSafe([401,403].includes((await identityKubeRequest(oidc,fresh,'/api/v1/namespaces/ai/pods')).status),'API');
    } finally {await context.close(); await grant('none');}
    const none=(await api.api.kubernetesAccess(created.user.username)).users.find(user=>user.id === created.user.id);
    requireSafe(none?.accessLevel === 'none','API');
  }
  await users.enabled(created.user,false);
  let refused=false;
  try {await grant('viewer');}catch(error){refused=error instanceof HarnessError;}
  requireSafe(refused && (await api.api.kubernetesAccess(created.user.username)).users.find(user=>user.id === created.user.id)?.accessLevel === 'none','API');
  await live.cleanup(live.journal,{kind:'identity',name:created.user.username}); proofs.add('K8S-06');return proofs;
}
