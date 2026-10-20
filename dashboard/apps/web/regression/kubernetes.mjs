/** Existing suite in Kubernetes; no Docker-in-Docker or parallel test engine. */
import {spawn} from 'node:child_process';
import {readFile,copyFile,rename,lstat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {privateDirectory,writePrivate,readPrivate} from './core/private-files.ts';
import {newRunId} from './core/journal.ts';
import {saveReport} from './core/report.ts';
import {KubernetesProgress,publicResult} from './core/kubernetes-progress.ts';
import {recoverLockWithSetup} from './core/lock-recovery-workflow.ts';
import {parseRecoveryLock} from './core/lock-recovery.ts';
import {HarnessError} from './core/errors.ts';
import {harnessFailure} from './reporter.ts';
import {setupWorkerMarker} from './core/preparation-diagnostic.ts';

process.umask(0o077);
const uid=process.env.REGRESSION_RUN_UID;
if(!/^[a-f0-9-]{36}$/.test(uid??''))throw new Error('Invalid run identity.');
const operation=process.env.REGRESSION_OPERATION??'tests';
if(!['tests','recover-lock'].includes(operation))throw new Error('Invalid run operation.');
const recovery=operation==='recover-lock';
const testMode=process.env.REGRESSION_TEST_MODE??'full';
if(!['full','non-destructive'].includes(testMode)||recovery&&testMode!=='full')throw new Error('Invalid test mode.');
const nonDestructive=testMode==='non-destructive';
const phases=recovery?[]:(process.env.REGRESSION_PHASES??'0,1,2,3,4,5,6,7,8').split(',').map(Number);
if((!recovery&&!phases.length)||new Set(phases).size!==phases.length||phases.some(n=>!Number.isInteger(n)||n<0||n>8))throw new Error('Invalid phase selection.');
const privateRoot=nonDestructive?'/tmp/non-destructive-'+uid:'/private';
const input=nonDestructive?join(privateRoot,'inputs'):'/inputs',output=join(privateRoot,'runs'),published=join('/state/reports',uid),progress=new KubernetesProgress(phases,process.env.REGRESSION_APPLIANCE_UID);
const environment={...process.env,REGRESSION_EXECUTION:'kubernetes',REGRESSION_INPUT_DIR:input,REGRESSION_CONFIG:input+'/lab.json',
  REGRESSION_REMAINING_PROFILE:input+'/remaining-p0.json',REGRESSION_OUTPUT_DIR:output,REGRESSION_PRIVATE_DIR:privateRoot,
  REGRESSION_HOST_DRILLS_FILE:input+'/host-drills.json',REGRESSION_HOST_DRILLS:'disabled',REGRESSION_PROGRESS_EVENTS:'1',
  PYTHONDONTWRITEBYTECODE:'1',NODE_EXTRA_CA_CERTS:input+'/appliance-ca.pem'};
let current,interrupted=false,force,saveChain=Promise.resolve();
let recoveryDiagnostic;
const snapshot={version:1,runUid:uid,testMode,message:nonDestructive?'Preparing an isolated read-only connection.':'Preparing automatic test credentials and fixtures.',reportAvailable:false,credentialRecoveryRequired:!nonDestructive};
const save=()=>{saveChain=saveChain.then(async()=>{await writePrivate(join(published,'.status.json'),{...snapshot,progress:progress.snapshot(Boolean(snapshot.outcome))});
  await rename(join(published,'.status.json'),join(published,'status.json'));});return saveChain;};
async function execute(command,args,env=environment,onFailure,onSetupMarker) {
  current=spawn(command,args,{env,stdio:['ignore','pipe','pipe']});let buffer='',diagnostic='';
  current.stdout.on('data',chunk=>{
    buffer+=chunk.toString();if(buffer.length>256*1024)buffer='';
    let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
      if(line.startsWith('REGRESSION_EVENT '))try{progress.consume(JSON.parse(line.slice(17)));snapshot.message='Running the existing regression suite.';void save();}catch{/* Not a structured event. */}}
  });
  // Only exact repository-owned error messages can become diagnostic metadata.
  // Discard upstream text; never publish raw logs, credentials or error bodies.
  current.stderr.on('data',chunk=>{
    if(!onFailure)return;
    diagnostic+=chunk.toString();if(diagnostic.length>64*1024)diagnostic='';
    let at;while((at=diagnostic.indexOf('\n'))>=0){const line=diagnostic.slice(0,at);diagnostic=diagnostic.slice(at+1);
      const failure=harnessFailure(line);if(failure)onFailure(failure);
      const marker=setupWorkerMarker(line);if(marker)onSetupMarker?.(marker);
      if(/^Error \[ERR_MODULE_NOT_FOUND\]:/.test(line))onSetupMarker?.({setupStage:'request',detail:'ERR_MODULE_NOT_FOUND'});}
  });
  return await new Promise(resolve=>{current.once('error',()=>resolve(1));current.once('close',(code,signal)=>resolve(signal?2:code??1));});
}
async function publish(directory) {
  for(const filename of ['summary.html','junit.xml','report-artifacts.tar.gz']) {
    const source=join(directory,filename),stat=await lstat(source);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64*1024*1024)throw new Error('Invalid report artifact.');
    await copyFile(source,join(published,'.'+filename));await rename(join(published,'.'+filename),join(published,filename));
  }
  snapshot.reportAvailable=true;
}
async function recoverOnly() {
  const expected=parseRecoveryLock(JSON.parse(process.env.REGRESSION_RECOVERY_LOCK??'null'));
  const started=Date.now();
  await recoverLockWithSetup(input,process.env.REGRESSION_APPLIANCE_UID,expected,async()=>{
    let failure,marker;
    const exit=await execute(process.execPath,[fileURLToPath(new URL('./setup.mjs',import.meta.url))],environment,
      value=>{failure??=value;},value=>{marker=value;});
    if(interrupted)throw new HarnessError('CANCELLED','Blocked','cleanup');
    if(exit) {
      recoveryDiagnostic={version:1,outcome:'Failed',reason:failure?.code??(marker?.detail==='ERR_MODULE_NOT_FOUND'?'CONFIG':'UNEXPECTED'),
        setupStage:marker?.setupStage??'request',...(marker?.detail?{detail:marker.detail}:{})};
      throw failure?new HarnessError(failure.code,failure.outcome,failure.stage):
        new HarnessError(recoveryDiagnostic.reason,'Failed','cleanup');
    }
  },async(step,index)=>{
    progress.consume({version:1,event:'step-start',step,index,total:3});
    snapshot.message=step==='recovery-access'?'Verifying the retained recovery identity.':step==='recovery-journal'?
      'Restoring the exact old journal; no tests will start.':'The old journal and released lock were verified.';await save();
  });
  snapshot.credentialRecoveryRequired=false;
  const runId=newRunId(),directory=join(output,runId);await privateDirectory(directory);
  await saveReport(directory,runId,[{id:'HAR-07',outcome:'Passed',layer:'A',environment:'live',durationMs:Date.now()-started,
    executionId:runId.slice(4).replaceAll('-','').slice(0,24),executionOutcome:'Passed'}],
    ['HAR-07'],process.env.REGRESSION_SOURCE_REVISION,'recover');
  snapshot.result=publicResult(JSON.parse(await readPrivate(join(directory,'summary.json'),8*1024*1024)),{phases:[]});
  snapshot.outcome='Passed';await publish(directory);
  snapshot.message='Previous-run resources and retained setup access were verified clean. No regression tests were started; original results were retained.';
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  interrupted=true;if(current)current.kill(signal);
  if(force&&current)current.kill('SIGKILL');else force=setTimeout(()=>current?.kill('SIGKILL'),150_000);
});
try {
  for(const dir of [privateRoot,input,output,published])await privateDirectory(dir);
  await save();
  const account=JSON.parse(await readFile('/account/account.json','utf8'));
  if(account.runUid!==(process.env.REGRESSION_ACCOUNT_RUN_UID??uid)||!account.registration||!account.caPem||!account.password||!account.username)throw new Error('Account ownership mismatch.');
  if((account.testMode??'full')!==testMode)throw new Error('Account test mode mismatch.');
  const saved=await lstat(join(input,'lab-registration.json')).catch(()=>undefined);
  if(saved) {
    const previous=JSON.parse(await readPrivate(join(input,'lab-registration.json')));
    if(JSON.stringify(previous)!==JSON.stringify(account.registration))throw new Error('The persistent lab registration changed.');
  } else await writePrivate(join(input,'lab-registration.json'),account.registration);
  await writePrivate(join(input,'username.txt'),account.username+'\n');
  await writePrivate(join(input,'password.txt'),account.password+'\n');
  await writePrivate(join(input,'appliance-ca.pem'),account.caPem);
  if(recovery) {
    await recoverOnly();
  } else {
  if(nonDestructive) {
    await writePrivate(join(input,'non-destructive.json'),{version:1,testMode,dashboardUrl:account.registration.dashboardUrl,
      identityUrl:account.registration.identityUrl,applianceUid:account.registration.applianceUid,nodeUids:account.registration.nodeUids});
    snapshot.message='Running non-destructive checks. Existing workloads and settings are not changed.';await save();
  } else {
  const diagnostic='/private/.preparation-'+uid.replaceAll('-','').slice(0,6);
  await writePrivate(diagnostic,{});
  environment.REGRESSION_PREPARATION_STATUS_FILE=diagnostic;environment.REGRESSION_PREPARATION_DIAGNOSTIC=diagnostic;
  const args=[fileURLToPath(new URL('../../../../tools/regression_inputs.py',import.meta.url)),
    '--url',account.registration.dashboardUrl,'--username',account.username,'--password-file',input+'/password.txt','--ca-file',input+'/appliance-ca.pem','--no-host-mapping'];
  const prepared=await execute('python3',args);
  if(prepared)environment.REGRESSION_PREPARATION_FAILED=prepared===1?'Failed':'Blocked';
  if(interrupted)throw new Error('Cancelled during preparation.');
  // Mirror the external launcher's fence: retained transient admin inputs must
  // never be passed to ordinary tests after an interrupted setup.
  snapshot.credentialRecoveryRequired=false;
  for(const name of ['.setup-bootstrap.kubeconfig','.setup-access-restore.json'])if(await lstat(join(input,name)).catch(()=>undefined)) {
    snapshot.credentialRecoveryRequired=true;
    const blocked='/private/blocked-inputs';await privateDirectory(blocked);
    environment.REGRESSION_PREPARATION_FAILED='Blocked';environment.REGRESSION_INPUT_DIR=blocked;
    environment.REGRESSION_CONFIG=blocked+'/lab.json';environment.REGRESSION_REMAINING_PROFILE=blocked+'/remaining-p0.json';
  }
  snapshot.message=prepared?'Preparation is unavailable; independent tests continue and dependent cases report Blocked.':'Running all selected P0 phases.';await save();
  }
  if(interrupted)throw new Error('Cancelled before test execution.');
  const exit=await execute(process.execPath,[fileURLToPath(new URL('./launch.mjs',import.meta.url)),'all','--phases',phases.join(',')]);
  if(!progress.campaignRunId)throw new Error('Campaign did not publish a receipt.');
  // A full case × variant × layer matrix is larger than a private input file.
  // Keep the normal input limit, but explicitly bound these two generated reports.
  const directory=join(output,progress.campaignRunId),summary=JSON.parse(await readPrivate(join(directory,'summary.json'),8*1024*1024)),
    campaign=JSON.parse(await readPrivate(join(directory,'all-summary.json'),8*1024*1024));
  if(nonDestructive&&(summary.testMode!==testMode||campaign.testMode!==testMode))throw new Error('Campaign test mode changed.');
  snapshot.result=publicResult(summary,campaign);snapshot.outcome=interrupted?'Blocked':exit===0?'Passed':exit===1?'Failed':'Blocked';
  if(snapshot.result.recoveryRequired&&!nonDestructive)snapshot.credentialRecoveryRequired=true;
  await publish(directory);snapshot.message=interrupted?'Cancelled; unexecuted tests remain Blocked.':'Execution finished. Missing external prerequisites are not successful tests.';
  }
} catch(error) {
  snapshot.credentialRecoveryRequired=!nonDestructive;
  snapshot.outcome=interrupted?'Blocked':recovery&&error instanceof HarnessError?error.outcome:'Failed';snapshot.message=interrupted?'Cancelled during preparation or execution. Recovery journals were retained.':recovery?'Previous-run cleanup was not verified. The private restoration receipts were retained; inspect its cleanup report.':'The Kubernetes runner could not complete its setup or report export.';
  if(recoveryDiagnostic&&!interrupted)snapshot.message=`Previous-run cleanup failed at ${recoveryDiagnostic.setupStage} (${recoveryDiagnostic.reason}${recoveryDiagnostic.detail?`; ${recoveryDiagnostic.detail}`:''}). The exact restoration receipts are retained.`;
  try {
    const runId=newRunId(),directory=join(output,runId);await privateDirectory(directory);
    const id=recovery?'HAR-07':'HAR-02';
    await saveReport(directory,runId,[{id,outcome:snapshot.outcome,layer:'A',environment:'live',durationMs:0,
      reason:interrupted?'CANCELLED':recovery&&error instanceof HarnessError?error.code:'UNEXPECTED',
      ...(recovery?{executionId:runId.slice(4).replaceAll('-','').slice(0,24),executionOutcome:snapshot.outcome}:{})}],[id],process.env.REGRESSION_SOURCE_REVISION,recovery?'recover':'all',
      recovery?recoveryDiagnostic:undefined,recovery?{recoveryFenceActive:true,recoveryAttempts:[]}:undefined);
    // The displayed result must match the exported infrastructure/cancellation
    // report, not retain an earlier green campaign after export failed.
    snapshot.result=publicResult(JSON.parse(await readPrivate(join(directory,'summary.json'),8*1024*1024)),{phases:[]});
    for(const name of ['summary.html','junit.xml','report-artifacts.tar.gz'])await copyFile(join(directory,name),join(published,name));
    snapshot.reportAvailable=true;
  } catch {/* Scheduling/storage failures remain visible even without an archive. */}
} finally {
  clearTimeout(force);
  if(interrupted&&!nonDestructive)snapshot.credentialRecoveryRequired=true;
  // Even a preparation failure/cancellation must retain the original identity
  // when a durable access-restoration receipt is still present. Unknown state
  // stays protected, never an implicit cleanup success.
  if(!nonDestructive)for(const name of ['.setup-bootstrap.kubeconfig','.setup-access-restore.json'])if(await lstat(join(input,name)).catch(()=>undefined))snapshot.credentialRecoveryRequired=true;
  await save();
}
// A Job completes after execution even when tests failed/blocked. Status and
// reports carry the real outcomes; Kubernetes must never retry destructive tests.
process.exitCode=0;
