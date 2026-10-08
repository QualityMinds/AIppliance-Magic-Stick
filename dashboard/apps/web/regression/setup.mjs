/** Explicit setup only. Normal tests cannot call this bootstrap worker. */
import {spawn} from 'node:child_process';
import {lstat, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {browserTrust} from './core/browser-trust.ts';
import {realLogin} from './core/auth.ts';
import {AdministrationApi} from './core/administration-api.ts';
import {readPrivate, writePrivate} from './core/private-files.ts';
import {HarnessError, requireSafe} from './core/errors.ts';
import {verifiedEndpoint} from './core/preflight.ts';
import {parseKubeconfig} from './core/oidc-exec.ts';
import {setupFacts, sameSetupTarget, setupOidcToken, withSetupAdmin, publicIssuerCa} from './core/setup-bootstrap.ts';
import {createTestLicenseSigner,validateTestLicenseSigner,testLicenseDocument} from './core/test-license-fixtures.ts';
import {suiteInventory} from './core/setup-suite.ts';
import {KubectlObserver,KubernetesLeaseStore} from './core/observer.ts';
import {recordedLeaseSession} from './core/runner-session.ts';
import {createHash,randomUUID} from 'node:crypto';
import {editRevision} from './core/owned-model.ts';
import {poll} from './core/poll.ts';
import {bootstrapRegisteredLab,bootstrapTestLicenses} from './core/automatic-bootstrap.ts';
import {parseRegistration} from './core/lab-policy.ts';
import {AutomaticRecovery} from './core/automatic-recovery.ts';
import {recoveryAdapters} from './core/recovery-adapters.ts';

process.umask(0o077);
const directory = resolve(process.env.REGRESSION_INPUT_DIR ?? '/inputs');
const worker = process.argv[2] === '--worker';
let home, browser, context, client, grantActive = false, facts, journal, request, setupStage = 'request', recoveredRunIds=[];
const grantFile = join(directory, '.setup-access-restore.json');
async function exists(path) {try {await lstat(path); return true;} catch (error) {if(error.code === 'ENOENT') return false; throw error;}}
function inputFile(name) {
  requireSafe(['username.txt', 'password.txt', 'appliance-ca.pem'].includes(name), 'PRIVATE_FILE');
  return join(directory, name);
}
async function connect() {
  await context?.close();
  const config = {dashboardUrl: request.dashboardUrl, identityUrl: request.identityUrl,
    usernameFile: inputFile(request.usernameFile), passwordFile: inputFile(request.passwordFile),
    requestTimeoutMs: 15_000, loginTimeoutMs: 45_000, expected: {role: 'magicstick-admin'}};
  context = await realLogin(browser, config);
  client = new AdministrationApi(context.request, config.dashboardUrl, config.requestTimeoutMs, async () => {
    const session = await client.api.session();
    requireSafe(session.subject === facts.subject && session.username === facts.username && session.roles.includes('magicstick-admin'), 'AUTH');
  });
}
async function inventory(restoringFacts) {
  const session = await client.api.session();
  const [access, bases, appliance] = await Promise.all([client.api.kubernetesAccess(session.username, 0, 100),
    // Restoring an identity privilege must not require a healthy LiteLLM key
    // store. The endpoint is only a previously reviewed comparison field here;
    // identity, subject, access and Appliance UID are still independently read.
    restoringFacts ? {items: [], total: 0, apiBases: [{url: restoringFacts.inferenceUrl + '/v1'}]} : client.api.apiAccess(),
    client.api.appliance()]);
  return setupFacts(request.dashboardUrl, request.identityUrl, session, access, bases, appliance.metadata?.uid);
}
async function changeAccess(level) {
  const permit = {method: 'PUT', path: '/api/kubernetes-access/' + encodeURIComponent(facts.subject), body: {accessLevel: level}};
  await client.write(permit, () => client.api.updateKubernetesAccess(facts.subject, level));
  // The API deliberately signs out all sessions after a role change. Reuse the
  // private credentials through the real SSO flow, not the revoked session.
  await connect();
}
async function restoreAccess() {
  if(!journal) journal = JSON.parse(await readPrivate(grantFile));
  sameSetupTarget(facts, journal.facts, false);
  await connect();
  const current = await inventory(journal.facts);
  sameSetupTarget(current, journal.facts, false);
  requireSafe([journal.facts.accessLevel, 'admin'].includes(current.accessLevel), 'CONFLICT');
  if(current.accessLevel !== journal.facts.accessLevel) await changeAccess(journal.facts.accessLevel);
  const restored = await inventory(journal.facts);
  sameSetupTarget(restored, journal.facts);
  await rm(grantFile); grantActive = false;
}
async function stopReviewedModels() {
  requireSafe(request.approveStopModels === true && Array.isArray(request.reviewed.inventory?.activeModels),'PREREQUISITE');
  const observer=new KubectlObserver(join(directory,'observer.yaml'),15_000);
  await observer.verifyConfiguration();
  const observed=await observer.get('appliances.appliance.magicstick.dev','ai-system','local');
  requireSafe(observed.metadata.uid === facts.applianceUid,'IDENTITY');
  const filename=join(directory,'.setup-model-stops.json'),items=request.reviewed.inventory.activeModels;
  requireSafe(!await exists(filename),'CONFLICT');
  const reservation=await recordedLeaseSession(new KubernetesLeaseStore(join(directory,'locker.yaml'),'magicstick-regression','lab-lock'),
    resolve(process.env.REGRESSION_OUTPUT_DIR??'/private/runs'),facts.applianceUid);
  const {lease}=reservation;
  const receipt={version:1,applianceUid:facts.applianceUid,state:'requested',items:items.map(item=>({...item,stopped:false}))};
  try {
    await writePrivate(filename,receipt,true);
    for(const item of receipt.items) {
      await lease.heartbeat();
      const fresh=(await client.api.models()).activations.find(model=>model.metadata?.name === item.name);
      const independent=await observer.get('modelactivations.appliance.magicstick.dev','ai-system',item.name);
      requireSafe(fresh?.spec?.type === 'local' && fresh.metadata?.uid === item.uid && fresh.metadata.generation === item.generation &&
        independent.metadata.uid === item.uid && independent.metadata.generation === item.generation && editRevision(fresh) === item.revision,'CONFLICT');
      const body={expectedRevision:item.revision},path='/api/models/'+encodeURIComponent(item.name)+'/stop';
      await reservation.guard();
      await client.write({method:'POST',path,body},()=>client.api.request(path,{method:'POST',body:JSON.stringify(body)}));
      await poll(async()=>{await lease.heartbeat();return (await client.api.models()).activations.find(model=>model.metadata?.name === item.name);},
        model=>model?.metadata?.uid === item.uid && model.spec?.enabled === false && model.status?.phase === 'Stopped',
        {timeoutMs:90_000,intervalMs:1500,stage:'model-update'});
      item.stopped=true;await writePrivate(filename,receipt);
    }
    receipt.state='verified';await writePrivate(join(directory,'setup-stopped-models.json'),receipt);
    await rm(filename);
  }finally {await reservation.close();}
}

const documentHash=value=>createHash('sha256').update(value).digest('hex');
async function recoverReviewedActions() {
  requireSafe(request.approveRecovery === true,'PREREQUISITE');
  const activation=join(directory,'.setup-license-activation-pending.json');
  if(await exists(activation)) {
    const pending=JSON.parse(await readPrivate(activation)),status=await client.api.licenseStatus();
    requireSafe(pending.version === 1 && pending.applianceUid === facts.applianceUid && /^[a-f0-9]{64}$/.test(pending.documentHash),'IDENTITY');
    const current=status.hasDocument ? (await client.api.exportLicense()).content : '';
    if(documentHash(current) === pending.documentHash)await writePrivate(join(directory,'license-original.license'),current);
    else requireSafe(status.revision === pending.revision && documentHash(current) === pending.previousHash,'CONFLICT');
    await writePrivate(join(directory,'setup-license-recovery.json'),{version:1,applianceUid:facts.applianceUid,verifiedAt:new Date().toISOString(),state:'reconciled'});
    await rm(activation);
  }
  const filename=join(directory,'.setup-model-stops.json');
  if(await exists(filename)) {
    const pending=JSON.parse(await readPrivate(filename));
    requireSafe(pending.version === 1 && pending.applianceUid === facts.applianceUid && Array.isArray(pending.items) && pending.items.length <= 256,'IDENTITY');
    const observer=new KubectlObserver(join(directory,'observer.yaml'),15_000);await observer.verifyConfiguration();
    requireSafe((await observer.get('appliances.appliance.magicstick.dev','ai-system','local')).metadata.uid === facts.applianceUid,'IDENTITY');
    const models=await client.api.models();
    for(const item of pending.items) {
      requireSafe(/^[a-z0-9][a-z0-9-]{0,62}$/.test(item.name) && Number.isSafeInteger(item.generation),'CONFIG');
      const api=models.activations.find(model=>model.metadata?.name === item.name),observed=await observer.get('modelactivations.appliance.magicstick.dev','ai-system',item.name);
      requireSafe(api?.metadata?.uid === item.uid && observed.metadata.uid === item.uid && api.metadata.generation === observed.metadata.generation,'CONFLICT');
      if(api.spec?.enabled === false) {
        requireSafe(api.metadata.generation === item.generation+1 && api.status?.phase === 'Stopped','CONFLICT');item.stopped=true;
      } else requireSafe(!item.stopped && api.metadata.generation === item.generation && editRevision(api) === item.revision,'CONFLICT');
    }
    pending.state='reconciled';await writePrivate(join(directory,'setup-stopped-models.json'),pending);await rm(filename);
  }
  if(await exists(join(directory,'.setup-module-fixture.json')))await prepareModuleFixture();
}
async function prepareModuleFixture() {
  requireSafe(request.approveModuleFixture === true,'PREREQUISITE');
  const reservation=await recordedLeaseSession(new KubernetesLeaseStore(join(directory,'locker.yaml'),'magicstick-regression','lab-lock'),
    resolve(process.env.REGRESSION_OUTPUT_DIR??'/private/runs'),facts.applianceUid);
  const {lease}=reservation;
  try {
  const profile=JSON.parse(await readPrivate(join(directory,'remaining-p0.json'))),id=profile.modules?.id;
  requireSafe(typeof id === 'string' && /^[a-z0-9-]{1,63}$/.test(id) && !/identity|dashboard|basis|kubeai|gpu|amd|nvidia|intel|litellm|private-mesh|model-catalog|magicstick-operator/.test(id),'PREREQUISITE');
  const modules=await client.api.modules(),catalog=modules.catalogJson?.modules?.[id];
  requireSafe(catalog?.activationMode === 'moduleactivation' && modules.modules[id]?.enabled !== true,'PREREQUISITE');
  const instances=Object.values((await client.api.instances()).instances).flat();
  requireSafe(!instances.some(item=>modules.catalogJson?.applications?.[String(item.spec?.application)]?.requiredModules?.includes(id)),'PREREQUISITE');
  const observer=new KubectlObserver(join(directory,'observer.yaml'),15_000);await observer.verifyConfiguration();
  requireSafe((await observer.get('appliances.appliance.magicstick.dev','ai-system','local')).metadata.uid === facts.applianceUid,'IDENTITY');
  const matches=(await observer.list('moduleactivations.appliance.magicstick.dev','ai-system')).filter(item=>item.spec?.module === id);
  requireSafe(matches.length <= 1,'CONFLICT');
  const parameters=profile.modules.parameters ?? {};
  requireSafe(parameters && typeof parameters === 'object' && !Array.isArray(parameters) && Object.entries(parameters).every(([key,value])=>
    typeof value === 'string' && value.length < 128 && catalog.parameters?.some(field=>field.name === key)),'CONFIG');
  const marker=join(directory,'.setup-module-fixture.json');
  if(await exists(marker)) {
    const pending=JSON.parse(await readPrivate(marker));
    requireSafe(pending.applianceUid === facts.applianceUid && pending.id === id && documentHash(JSON.stringify(parameters)) === pending.parametersHash &&
      matches.length === 1 && matches[0].spec?.enabled === false && JSON.stringify(matches[0].spec.parameters ?? {}) === JSON.stringify(parameters),'CONFLICT');
    await writePrivate(join(directory,'setup-module-fixture.json'),{version:1,applianceUid:facts.applianceUid,id,uid:matches[0].metadata.uid,state:'verified-disabled'});await rm(marker);return;
  }
  if(matches.length) {
    requireSafe(matches[0].spec?.enabled === false && JSON.stringify(matches[0].spec.parameters ?? {}) === JSON.stringify(parameters),'CONFLICT');return;
  }
  await writePrivate(marker,{version:1,applianceUid:facts.applianceUid,id,parametersHash:documentHash(JSON.stringify(parameters)),state:'requested'},true);
  const body=Object.keys(parameters).length ? {parameters} : {},path='/api/modules/'+id+'/disable';
  await reservation.guard();
  await client.write({method:'POST',path,body},()=>client.api.request(path,{method:'POST',body:JSON.stringify(body)}));
  const created=await poll(async()=>{await lease.heartbeat();return observer.get('moduleactivations.appliance.magicstick.dev','ai-system',id);},
    item=>item.spec?.enabled === false && JSON.stringify(item.spec.parameters ?? {}) === JSON.stringify(parameters),
    {timeoutMs:30_000,intervalMs:1000,stage:'host-readiness'});
  requireSafe(created.metadata.uid,'OWNERSHIP');
  await writePrivate(join(directory,'setup-module-fixture.json'),{version:1,applianceUid:facts.applianceUid,id,uid:created.metadata.uid,state:'verified-disabled'});await rm(marker);
  }finally {await reservation.close();}
}

try {
  request = JSON.parse(await readPrivate(join(directory, '.setup-api-request.json')));
  requireSafe(request.version === 1 && ['inspect','suite-inventory','stop-models','authorize','register','refresh','restore','license-fixtures','verify-fixtures','export-license','module-fixture','recover-actions'].includes(request.mode), 'CONFIG');
  for(const name of ['dashboardUrl', 'identityUrl']) {
    const url = new URL(request[name]);
    requireSafe(url.protocol === 'https:' && url.origin === request[name] && !url.username && !url.password, 'CONFIG');
  }
  if(!worker) {
    const trust = await browserTrust(request.caFile ? inputFile(request.caFile) : undefined);
    home = trust.home;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {env: trust.environment, stdio: 'inherit'});
    for(const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
    process.exitCode = await new Promise(resolveExit => {child.once('error', () => resolveExit(2)); child.once('close', code => resolveExit(code ?? 2));});
  } else {
    setupStage = 'tls';
    const ca = request.caFile ? await readPrivate(inputFile(request.caFile)) : undefined;
    await verifiedEndpoint(request.dashboardUrl, 15_000, ca);
    await verifiedEndpoint(request.identityUrl, 15_000, ca);
    browser = await chromium.launch();
    setupStage = 'login';
    await connect();
    if(request.mode === 'restore') journal = JSON.parse(await readPrivate(grantFile));
    setupStage = 'discovery';
    facts = await inventory(journal?.facts);
    if(request.mode === 'restore') {
      requireSafe(await exists(grantFile), 'CONFIG');
      journal = JSON.parse(await readPrivate(grantFile)); grantActive = true;
      await restoreAccess();
      await writePrivate(join(directory, '.setup-api-result.json'), {version: 1, restored: true});
      console.log('Previous Kubernetes access restored; no lab objects or accepted pins were changed.');
    } else {
      requireSafe(!await exists(grantFile), 'CONFLICT');
      let licenseFixture,suite;
      if(request.mode === 'recover-actions') {sameSetupTarget(facts,request.reviewed);await recoverReviewedActions();}
      if(request.mode === 'module-fixture') {sameSetupTarget(facts,request.reviewed);await prepareModuleFixture();}
      if(request.mode === 'export-license') {
        sameSetupTarget(facts,request.reviewed);requireSafe((await client.api.licenseStatus()).hasDocument,'PREREQUISITE');
        await writePrivate(join(directory,'license-original.license'),(await client.api.exportLicense()).content);
      }
      if(request.mode === 'suite-inventory') {
        sameSetupTarget(facts,request.reviewed);
        const [models,modules,status,hosts,license]=await Promise.all([client.api.models(),client.api.modules(),client.api.status(),client.api.hostManagement(),client.api.licenseStatus()]);
        suite={...suiteInventory(models,modules,status,hosts.nodes),runnerArchitecture:process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : 'unsupported',
          license:{hasDocument:license.hasDocument,installationId:license.installationId}};
      }
      if(request.mode === 'stop-models') {sameSetupTarget(facts,request.reviewed);await stopReviewedModels();}
      if(request.mode === 'license-fixtures') {
        sameSetupTarget(facts,request.reviewed);
        requireSafe(request.approveTestSigner === true,'PREREQUISITE');
        const status=await client.api.licenseStatus(),filename=join(directory,'test-license-signer.json');
        if(await exists(filename)) {
          const previous=JSON.parse(await readPrivate(filename));
          if(previous.applianceUid !== facts.applianceUid || previous.installationId !== status.installationId) {
            await writePrivate(join(directory,'test-license-signer-previous-'+randomUUID()+'.json'),previous,true);await rm(filename);
          }
        }
        const signer=await exists(filename) ? validateTestLicenseSigner(JSON.parse(await readPrivate(filename)),facts.applianceUid,status.installationId) : createTestLicenseSigner(facts.applianceUid,status.installationId);
        if(!await exists(filename))await writePrivate(filename,signer,true);
        for(const mode of ['valid','expired','wrong-installation','tampered','short-lived'])
          await writePrivate(join(directory,'license-'+mode+'.license'),testLicenseDocument(signer,mode));
        licenseFixture={kid:signer.kid,publicKey:signer.publicKey,fingerprint:signer.fingerprint,installationId:signer.installationId};
      }
      if(request.mode === 'verify-fixtures') {
        sameSetupTarget(facts,request.reviewed);requireSafe(request.approveTestSigner === true,'PREREQUISITE');
        const document=await readPrivate(join(directory,'license-valid.license'));
        const inspect=()=>client.write({method:'POST',path:'/api/license/validate',body:{document}},()=>client.api.inspectLicense(document));
        await poll(inspect,result=>result.candidate.valid,{timeoutMs:120_000,intervalMs:2500,stage:'host-readiness'});
        for(const kind of ['expired','wrong-installation','tampered']) {
          const invalid=await readPrivate(join(directory,'license-'+kind+'.license'));
          const result=await client.write({method:'POST',path:'/api/license/validate',body:{document:invalid}},()=>client.api.inspectLicense(invalid));
          requireSafe(result.candidate.valid === false,'API');
        }
      }
      if(['authorize','register','refresh'].includes(request.mode)) {
        sameSetupTarget(facts, request.reviewed);
        await verifiedEndpoint(facts.inferenceUrl, 15_000, ca);
        let oidc;
        setupStage = 'kubernetes-access';
        const token = await withSetupAdmin(facts, request.approveAdminGrant, {
          save: async () => {
            journal = {version: 1, facts, createdAt: new Date().toISOString()};
            await writePrivate(grantFile, journal, true); grantActive = true;
          }, grant: () => changeAccess('admin'), restore: restoreAccess,
        }, async () => {
          const current = await inventory();
          sameSetupTarget(current, facts, false); requireSafe(current.accessLevel === 'admin', 'AUTH');
          const config = await client.api.kubeconfig(facts.subject);
          requireSafe(config.accessLevel === 'admin', 'AUTH');
          oidc = parseKubeconfig(config.content, facts.identityUrl);
          requireSafe(oidc.issuer === facts.identityUrl + '/realms/magicstick' && oidc.client === 'magicstick-kubernetes' &&
            oidc.server === facts.kubernetesApiUrl, 'AUTH');
          publicIssuerCa(oidc.ca.toString('base64'));
          setupStage = 'oidc-session';
          return setupOidcToken(context, oidc, facts.subject, ca);
        });
        // Only the explicitly requested host bootstrap sees this transient
        // administrator ID token; it is removed by the host in a finally block.
        setupStage = 'bootstrap-file';
        await writePrivate(join(directory, '.setup-bootstrap.kubeconfig'), {apiVersion: 'v1', kind: 'Config',
          clusters: [{name: 'setup', cluster: {server: oidc.server, 'certificate-authority-data': oidc.ca.toString('base64')}}],
          users: [{name: 'setup', user: {token}}],
          contexts: [{name: 'setup', context: {cluster: 'setup', user: 'setup'}}], 'current-context': 'setup'}, true);
        if(request.mode !== 'authorize') {
          try {
            const registration=parseRegistration(JSON.parse(await readPrivate(join(directory,'lab-registration.json'))));
            requireSafe(registration.applianceUid === facts.applianceUid && registration.dashboardUrl === facts.dashboardUrl &&
              registration.identityUrl === facts.identityUrl,'LAB');
            setupStage = 'lab-bootstrap';
            const bootstrapped=await bootstrapRegisteredLab(directory,registration,request.mode === 'register',async lease=>{
              setupStage='run-recovery';
              const plan=await AutomaticRecovery.prepare(resolve(process.env.REGRESSION_OUTPUT_DIR??'/private/runs'),lease,registration);
              return async()=>{
                const id=await plan.execute(await recoveryAdapters(directory,context,registration));
                console.log('Previous interrupted regression run automatically restored; original failed evidence retained.');
                return id;
              };
            });
            if(bootstrapped.recoveredRunId)recoveredRunIds.push(bootstrapped.recoveredRunId);
            const license=await client.api.licenseStatus();
            setupStage = 'license-fixtures';
            await bootstrapTestLicenses(directory,registration,license.installationId);
            // The optional trust ConfigMap reloads the API. Wait for the
            // actual verifier, not merely the Kubernetes patch response.
            const document=await readPrivate(join(directory,'license-valid.license'));
            setupStage = 'license-validation';
            await poll(async()=>{
              try {return await client.write({method:'POST',path:'/api/license/validate',body:{document}},()=>client.api.inspectLicense(document));}
              catch(error){if(error instanceof HarnessError && error.code === 'API')return undefined;throw error;}
            },value=>value?.candidate.valid === true,{timeoutMs:120_000,intervalMs:2500,stage:'host-readiness'});
          }finally{await rm(join(directory,'.setup-bootstrap.kubeconfig'),{force:true});}
        }
      }
      await writePrivate(join(directory, '.setup-api-result.json'), {...facts,...(recoveredRunIds.length?{recoveredRunIds}:{}),
        ...(licenseFixture ? {licenseFixture} : {}),...(suite ? {inventory:suite} : {})}, true);
      console.log(request.mode === 'inspect' ? 'Dashboard/API discovery completed with verified administrator identity.' :
        request.mode === 'license-fixtures' ? 'Disposable installation-bound license fixtures generated locally. No official key or license was changed.' :
        request.mode !== 'authorize' ? 'Explicit setup action completed; inspect the private setup receipts.' :
        'Scoped-credential bootstrap authorized; temporary access, if used, has been restored.');
    }
  }
} catch(error) {
  console.error(error instanceof HarnessError ? error.message : new HarnessError('UNEXPECTED').message);
  const browserCode = error?.message?.match(/net::(ERR_[A-Z_]+)/)?.[1];
  const detail = ['ENOENT','EACCES','ENOSPC'].includes(error?.code) ? error.code :
    error instanceof TypeError ? 'TYPE_ERROR' : error instanceof SyntaxError ? 'SYNTAX_ERROR' :
    ['ERR_FAILED','ERR_BLOCKED_BY_CLIENT','ERR_CONNECTION_REFUSED','ERR_NAME_NOT_RESOLVED',
      'ERR_CERT_AUTHORITY_INVALID','ERR_HTTP2_PROTOCOL_ERROR'].includes(browserCode) ? browserCode : undefined;
  console.error(`[SETUP_STAGE:${setupStage}]${detail ? ` [detail:${detail}]` : ''}`);
  if(grantActive || worker && await exists(grantFile)) console.error('Access restoration requires review: run setup --restore-kubernetes-access. No further tests are allowed until it is resolved.');
  process.exitCode = error instanceof HarnessError && error.outcome === 'Blocked' ? 2 : 1;
} finally {
  await context?.close(); await browser?.close();
  if(home) await rm(home, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
