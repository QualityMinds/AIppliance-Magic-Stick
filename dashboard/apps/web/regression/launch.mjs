import {spawn, execFileSync} from 'node:child_process';
import {mkdtemp, rm, readFile, mkdir, lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join, resolve,dirname,basename} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {loadLabConfig} from './core/config.ts';
import {HarnessError, requireSafe} from './core/errors.ts';
import {ResourceJournal, newRunId, recoveryJournalPath} from './core/journal.ts';
import {privateDirectory, writePrivate, readPrivate} from './core/private-files.ts';
import {completeCases,guardedLiveCases,saveReport, stepCases,reportExitCode,summarize,summarizeExecutions} from './core/report.ts';
import {childEvidence} from './core/campaign-evidence.ts';
import {modeDescription} from './core/case-descriptions.ts';
import {phase0Ids, requirePhase0Profile} from './profiles/phase0-p0.ts';
import {phase1Ids, phase1FastVariants, requirePhase1Profile} from './profiles/phase1-p0.ts';
import {phase2Ids, phase2FastVariants, phase2FixtureVariants, phase2ModelIds, phase2ModelCases, requirePhase2Profile} from './profiles/phase2-p0.ts';
import {phaseSteps} from './profiles/selections.ts';
import {gpuModeIds,requireGpuProfile,phase3RuntimeCases,phase4SharingCases} from './profiles/gpu-p0.ts';
import {remainingIds,remainingPhase,hostDrillIds} from './profiles/remaining-p0.ts';
import {recipeBundle} from './core/host-drill-recipes.ts';
import {preparationArguments} from './core/input-preparation.ts';
import {verifyHostContinuation} from './core/setup-suite.ts';
import {preparationDiagnostic, requirePreparation, preparationDescription} from './core/preparation-diagnostic.ts';
import {runnerSession} from './core/runner-session.ts';
import {progressEvent} from './core/progress.ts';
import {blockedCounts,inheritRecoveryCause,recoveryCause} from './core/blocking.ts';
import {regressionBlockedSummary} from '../../../packages/core/src/regression-blocking.ts';
import {testMode,requireSafeStep,selectedSteps} from './core/test-mode.ts';
import {executionBudget} from './core/execution-budget.ts';
import {supervisedProcess} from './core/process-supervisor.ts';
import {assessRunCleanup} from './core/cleanup-state.ts';
import {phase4Scenarios,scenarioGrep} from './core/scenario-selection.ts';
import {interruptedEvidence} from './core/interrupted-evidence.ts';
import {executionIdentity} from './core/shared-workflow.ts';
import {saveExecutionTrace} from './core/execution-trace.ts';
import {ensureProcessInit} from './core/process-init.ts';

await ensureProcessInit();
process.umask(0o077);
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const mode = process.argv[2], runId = process.env.REGRESSION_CHILD_RUN_ID||newRunId();
const runTestMode=testMode(process.env.REGRESSION_TEST_MODE??'full'),nonDestructive=runTestMode==='non-destructive';
const modelCase = mode === 'phase2-models' ? process.argv[3] : undefined;
const selectedModelCase = modelCase && Object.hasOwn(phase2ModelCases, modelCase) ? phase2ModelCases[modelCase] : undefined;
const gpuCase = ['phase3-gpu','phase4-sharing'].includes(mode) ? process.argv[3] : undefined;
const gpuCases=mode === 'phase3-gpu' ? phase3RuntimeCases : phase4SharingCases;
const selectedGpuCase = gpuCase && Object.hasOwn(gpuCases,gpuCase) ? gpuCases[gpuCase] : undefined;
const hostCase = mode === 'phase6-drill' ? process.argv[3] : undefined;
const liveCase=/^phase[5-8]-live$/.test(mode)?process.argv[3]:undefined;
const recoveryRunId=mode==='campaign-recover'?process.argv[3]:undefined;
const output = resolve(process.env.REGRESSION_OUTPUT_DIR ?? '.regression/runs');
const directory = join(output, runId);
const playwrightCli = resolve('node_modules/@playwright/test/cli.js');
const typeScriptCli = resolve('node_modules/typescript/bin/tsc');
// Invalid drill arguments are handled by the redacted reporting path below.
const requiredBase = (mode === 'phase6-drill' ? hostDrillIds.includes(hostCase) ? [hostCase] : [] : liveCase?[liveCase]:remainingIds(mode)) ?? gpuModeIds(mode,selectedGpuCase ? gpuCase : undefined) ?? (mode==='campaign-recover'?['HAR-07']:mode === 'phase2' ? phase2Ids : mode === 'phase2-fast' ? [...new Set(Object.values(phase2FastVariants).map(item => item.id))] :
  mode === 'phase2-fixtures' ? [...new Set(Object.values(phase2FixtureVariants).map(item => item.id))] : mode === 'phase2-readonly' ? ['DISC-03'] :
  mode === 'phase2-models' ? selectedModelCase?.ids ?? phase2ModelIds :
  mode === 'phase2-faults' ? ['LIFE-12', 'NAV-06'] :
  mode === 'phase1' ? phase1Ids : mode === 'session-smoke' ? ['AUTH-01', 'AUTH-02', 'AUTH-06'] :
  mode === 'smoke-fast' ? [...new Set(Object.values(phase1FastVariants))] :
  mode === 'core-smoke' || mode === 'smoke-fixtures' ? phase1Ids :
  mode === 'phase0' ? phase0Ids : mode === 'foundations' ? ['HAR-02', 'HAR-03', 'HAR-04', 'HAR-05', 'HAR-06', 'HAR-07', 'HAR-09'] :
  mode === 'locktest' ? ['HAR-04', 'HAR-07', 'HAR-08', 'HAR-09'] : mode === 'ownedtest' ? ['HAR-05', 'HAR-06', 'HAR-07'] :
  mode === 'smoke' ? ['LIFE-01', 'ROUTE-01', 'LIFE-03', 'LIFE-04', 'LIFE-06'] :
  mode === 'model-edit' ? ['LIFE-01', 'ROUTE-01', 'LIFE-08', 'LIFE-07', 'LIFE-09', 'LIFE-03', 'LIFE-04', 'LIFE-06'] :
  mode === 'gpu-recover' ? ['HAR-07','HAR-08'] : mode === 'recover' ? ['HAR-07'] : ['HAR-01', 'HAR-02', 'HAR-03']);
const scenarioId=process.env.REGRESSION_SCENARIO_ID||undefined;
const required=scenarioId?(process.env.REGRESSION_SCENARIO_REQUIRED??'').split(','):mode==='non-destructive-live'?['HAR-01','HAR-02']:nonDestructive&&/^phase[0-8]$/.test(mode)?[]:requiredBase;
let home, child, interruptedSignal, session,targetUid,lastProcessResult,sessionFinished=false,campaignDeadline,deadlineReached=false;
const supervisors=new WeakMap();
const allocatedRuns=new WeakMap();
const allocatedModes=new WeakMap();
const phaseIds=phase=>nonDestructive?[]:phase === 0 ? phase0Ids : phase === 1 ? phase1Ids : phase === 2 ? phase2Ids :
  gpuModeIds(`phase${phase}`) ?? remainingIds(`phase${phase}`) ?? [];
async function waitChild(current) {
  let force,deadline;
  const supervisor=supervisors.get(current);
  const recovering=mode==='campaign-recover'||allocatedModes.get(current)==='campaign-recover';
  const forward=(signal,expired=false)=>{
    const expiredNow=expired||Boolean(campaignDeadline&&Date.now()>=campaignDeadline);
    if(expiredNow){if(deadlineReached)return;deadlineReached=true;if(recovering)return;}else interruptedSignal=signal;
    if(supervisor){supervisor.stop(signal);return;}if(force)return;current.kill(signal);
    // Nested coordinators can receive the same cancellation more than once.
    // Never shorten teardown by turning a forwarded duplicate into SIGKILL.
    force=setTimeout(()=>current.kill('SIGKILL'),executionBudget.outerTerminationMs);
  };
  const interrupt=()=>forward('SIGINT'),terminate=()=>forward('SIGTERM');
  process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
  // Recovery uses the reserved tail of the campaign, not the exhausted test
  // window. All ordinary children inherit the same absolute deadline.
  if(campaignDeadline&&!recovering)deadline=setTimeout(()=>forward('SIGINT',true),Math.max(0,campaignDeadline-Date.now()));
  try {if(supervisor){lastProcessResult=await supervisor.finished;return lastProcessResult.exitCode;}return await new Promise(resolveExit=>{
    current.once('error',()=>resolveExit(1));current.once('close',(code,signal)=>resolveExit(signal ? 2 : code ?? 1));
  });} finally {clearTimeout(force);clearTimeout(deadline);process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);}
}

try {
  requireSafe(/^reg-[0-9a-f-]{36}$/.test(runId),'CONFIG');
  requireSafeStep(mode,runTestMode);
  campaignDeadline=Number(process.env.REGRESSION_CAMPAIGN_DEADLINE??Date.now()+executionBudget.campaignMs-executionBudget.finalReserveMs);
  requireSafe(Number.isSafeInteger(campaignDeadline)&&campaignDeadline>0&&campaignDeadline<=Date.now()+executionBudget.campaignMs,'CONFIG');
  process.env.REGRESSION_CAMPAIGN_DEADLINE=String(campaignDeadline);
  requireSafe(!scenarioId||mode==='phase4-sharing'&&/^[a-zA-Z0-9_-]{1,200}$/.test(scenarioId)&&
    required.length>0&&required.every(id=>/^[A-Z][A-Z0-9]+-\d{2}$/.test(id)),'CONFIG');
  requireSafe([...['5','6','7','8'].flatMap(phase=>[`phase${phase}`,`phase${phase}-fast`,`phase${phase}-fixtures`,`phase${phase}-live`]),'all','selftest', 'phase0', 'phase1', 'phase2','phase3','phase4','phase3-fast','phase4-fast','phase3-fixtures','phase4-fixtures','phase3-gpu','phase3-validation','phase4-sharing', 'phase2-fast', 'phase2-fixtures', 'phase2-readonly',
    'phase2-models', 'phase2-faults', 'smoke-fast', 'smoke-fixtures', 'session-smoke', 'core-smoke', 'foundations',
    'phase6-drill','preflight', 'locktest', 'ownedtest', 'smoke', 'model-edit', 'recover','gpu-recover','campaign-recover', 'typecheck', 'cleanup-plan','non-destructive-live'].includes(mode), 'CONFIG');
  requireSafe(mode!=='campaign-recover'||/^reg-[0-9a-f-]{36}$/.test(recoveryRunId??''),'CONFIG');
  requireSafe(!modelCase || Boolean(selectedModelCase), 'CONFIG');
  requireSafe(!gpuCase || Boolean(selectedGpuCase), 'CONFIG');
  // Report generation runs in this parent as well as in Playwright children.
  // Keep the same validated diagnostic scope in both processes.
  if(selectedGpuCase)process.env.REGRESSION_GPU_CASE=gpuCase;
  requireSafe(mode !== 'phase6-drill' || hostDrillIds.includes(hostCase),'CONFIG');
  requireSafe(!process.env.REGRESSION_REMAINING_CASE || mode === 'phase6-drill' || liveCase===process.env.REGRESSION_REMAINING_CASE,'CONFIG');
  if(liveCase)requireSafe(remainingIds(mode,liveCase)?.includes(liveCase),'CONFIG');
  if(hostCase||liveCase)process.env.REGRESSION_REMAINING_CASE=hostCase??liveCase;
  await privateDirectory(output); await privateDirectory(directory);
  const environment = {...process.env, REGRESSION_MODE: mode, REGRESSION_RUN_ID: runId, REGRESSION_RUN_DIR: directory,
    REGRESSION_CHILD_RUN_ID:'',
    REGRESSION_MODEL_CASE: selectedModelCase ? modelCase : '', REGRESSION_GPU_CASE: selectedGpuCase ? gpuCase : '',
    REGRESSION_REMAINING_CASE:hostCase ?? liveCase ?? ''};
  const dnsPreload=new URL('./core/lab-dns.mjs',import.meta.url).href;
  if(!(environment.NODE_OPTIONS??'').includes(dnsPreload))
    environment.NODE_OPTIONS=((environment.NODE_OPTIONS??'')+' --import='+dnsPreload).trim();
  if(recoveryRunId)environment.REGRESSION_RECOVERY_RUN_ID=recoveryRunId;
  home = await mkdtemp(join(tmpdir(), 'magicstick-browser-'));
  if (process.platform === 'linux') environment.HOME = home;
  const aggregate=mode === 'all' || Object.hasOwn(phaseSteps,mode)||mode==='phase4-sharing'&&!scenarioId;
  const children=[];
  const recordChild=async(result,step,fixture)=>{
    if(!children.some(c=>c.runId===result.runId))children.push({runId:result.runId,mode:step,fixture});
    await writePrivate(join(directory,'child-runs.json'),{version:1,children});
  };
  const spawnStep=async(step,args=[],overrides={})=>{
    const childId=newRunId();
    // Persist the exact child identity before it can send its first write.
    // A killed launcher or lost completion receipt cannot orphan its journal.
    await recordChild({runId:childId},step,step==='selftest'||/(?:-fast|-fixtures)$/.test(step));
    const process_=spawn(process.execPath,[fileURLToPath(import.meta.url),step,...args],{stdio:'inherit',
      env:{...environment,...overrides,REGRESSION_CHILD_RUN_ID:childId}});
    allocatedRuns.set(process_,childId);allocatedModes.set(process_,step);return process_;
  };
  const lifecycle=async(recoveryAttempts=[])=>{
    const cleanup=nonDestructive?{state:'verified',checkedAt:new Date().toISOString()}:await assessRunCleanup(output,directory,true);
    return {cleanup,recoveryFenceActive:cleanup.state!=='verified',recoveryAttempts};
  };
  const stopped=()=>Boolean(interruptedSignal)||deadlineReached||Date.now()>=campaignDeadline;
  const stopReason=()=>deadlineReached||Date.now()>=campaignDeadline?'DEADLINE':'CANCELLED';
  const stopRows=async rows=>{
    if(!deadlineReached&&!interruptedSignal)return rows;
    const reason=stopReason(),outcome=reason==='DEADLINE'?'Failed':'Blocked',executionId=executionIdentity(runId,'runner-execution');
    await saveExecutionTrace(directory,{version:1,runId,executionId,outcome,durationMs:0,
      steps:[{index:1,category:'hook',title:'Setup/teardown hook',outcome,durationMs:0,reason,stage:'runner-execution'}]});
    return [...rows,{id:'HAR-10',layer:'A',environment:'live',outcome,durationMs:0,reason,stage:'runner-execution',executionId,executionOutcome:outcome,traceRunId:runId}];
  };
  if (!aggregate && ((remainingPhase(mode) && !/(?:-fast|-fixtures)$/.test(mode)) || ['phase3-gpu','phase3-validation','phase4-sharing', 'phase2-readonly', 'phase2-models', 'phase2-faults', 'session-smoke',
    'core-smoke', 'foundations', 'preflight', 'locktest', 'ownedtest', 'smoke', 'model-edit', 'recover','gpu-recover','campaign-recover', 'cleanup-plan'].includes(mode))) {
    requireSafe(process.env.REGRESSION_CONFIG, 'CONFIG');
    await requirePreparation();
    requireSafe(!process.env.REGRESSION_RECOVERY_FENCE||mode==='campaign-recover','RECOVERY');
    // An interrupted multi-file input acceptance must never run a partly
    // updated live profile. Fixtures remain independent of private inputs.
    for(const name of ['.preparation-accepting.json','.setup-access-restore.json','.setup-bootstrap.kubeconfig',
        '.setup-license-trust-pending.json','.setup-license-activation-pending.json','.setup-model-stops.json','.setup-module-fixture.json']) {
        try {await lstat(resolve(process.env.REGRESSION_INPUT_DIR ?? '/inputs',name));throw new HarnessError('CONFIG');}
        catch(error){if(error.code !== 'ENOENT')throw error;}
    }
    const config = await loadLabConfig(process.env.REGRESSION_CONFIG);
    if(['phase6-live','phase6-drill'].includes(mode) && process.env.REGRESSION_HOST_DRILLS_FILE) {
      let drills;try{drills=JSON.parse(await readPrivate(process.env.REGRESSION_HOST_DRILLS_FILE));}catch{/* Still blocked at the actual drill. */}
      if(drills?.version === 2) {
        recipeBundle(drills,config.expected.applianceUid,drills.nodeUid);
        environment.REGRESSION_HOST_DRILLS='approved';
      }
    }
    if (mode === 'phase0' || mode === 'foundations') requirePhase0Profile(config);
    if (['phase1', 'core-smoke', 'session-smoke'].includes(mode)) requirePhase1Profile(config);
    if (['phase2', 'phase2-readonly', 'phase2-models', 'phase2-faults'].includes(mode)) requirePhase2Profile(config);
    if (['phase3','phase4','phase3-gpu','phase3-validation','phase4-sharing','gpu-recover'].includes(mode)) requireGpuProfile(config);
    if (mode === 'cleanup-plan') {
      requireSafe(process.argv[3], 'CONFIG');
      const journal = await ResourceJournal.resume(resolve(process.argv[3]), config.expected.applianceUid);
      await writePrivate(join(directory, 'recovery-plan.json'), {version: 1, runId: journal.runId, mutationsEnabled: false, entries: journal.recoveryPlan()});
      console.log(`Read-only recovery plan saved (${journal.recoveryPlan().length} remaining entries). Nothing was removed.`);
      process.exitCode = journal.recoveryPlan().length ? 2 : 0;
    } else if (mode === 'recover' || mode === 'gpu-recover') {
      const journalPath = process.argv[3];
      requireSafe(recoveryJournalPath(journalPath,mode === 'gpu-recover'), 'CONFIG');
      const recovered = await ResourceJournal.resume(journalPath, config.expected.applianceUid);
      requireSafe(mode === 'gpu-recover' || recovered.recoveryPlan().length > 0, 'CONFIG');
      environment.REGRESSION_RECOVERY_JOURNAL = journalPath;
    } else {
      await ResourceJournal.create(join(directory, 'journal.json'), runId, config.expected.applianceUid);
    }
    targetUid=config.expected.applianceUid;
    if(mode!=='cleanup-plan')session=await runnerSession(directory,runId,targetUid);
    if(['recover','gpu-recover','campaign-recover'].includes(mode)) {
      let target=recoveryRunId;
      if(!target) {
        let path=dirname(environment.REGRESSION_RECOVERY_JOURNAL);
        if(/^worker-/.test(basename(path)))path=dirname(path);
        requireSafe(dirname(path)===output,'RECOVERY');target=basename(path);
      }
      requireSafe(/^reg-[0-9a-f-]{36}$/.test(target)&&target!==runId,'RECOVERY');
      await recordChild({runId:target},'recovery-target',false);
    }
    if (mode !== 'cleanup-plan') {
      if (config.caFile) {
        requireSafe(process.platform === 'linux', 'CONFIG');
        const bundle = await readFile(config.caFile, 'utf8');
        requireSafe(bundle.length < 256 * 1024 && !bundle.includes('PRIVATE KEY'), 'TLS');
        const certificates = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
        requireSafe(certificates.length > 0 && certificates.length < 20, 'TLS');
        const database = join(home, '.pki/nssdb'); await mkdir(database, {recursive: true, mode: 0o700});
        execFileSync('certutil', ['-N', '--empty-password', '-d', `sql:${database}`], {stdio: 'pipe'});
        for (const [index, certificate] of certificates.entries()) {
          const parsed = new X509Certificate(certificate);
          requireSafe(parsed.ca && Date.parse(parsed.validFrom) <= Date.now() && Date.parse(parsed.validTo) > Date.now(), 'TLS');
          const filename = join(home, `ca-${index}.pem`); await writePrivate(filename, certificate);
          execFileSync('certutil', ['-A', '-d', `sql:${database}`, '-n', `magicstick-lab-${index}`, '-t', 'C,,', '-i', filename], {stdio: 'pipe'});
        }
        environment.NODE_EXTRA_CA_CERTS = config.caFile;
      }
    }
  }
  if(mode==='phase4-sharing'&&!scenarioId) {
    const discovery=supervisedProcess(process.execPath,[playwrightCli,'test','--config','regression/playwright.config.ts','--list',
      ...(selectedGpuCase?['--grep',selectedGpuCase.grep]:[])],{stdio:'inherit',env:{...environment,REGRESSION_DISCOVER_ONLY:'1'}},
      {timeoutMs:executionBudget.preparationMs});
    child=discovery.child;supervisors.set(child,discovery);requireSafe(await waitChild(child)===0,'CONFIG');
    const scenarios=phase4Scenarios(JSON.parse(await readPrivate(join(directory,'scenario-selection.json'))),!selectedGpuCase,selectedGpuCase?.ids);
    const collected=[],recoveryAttempts=[],executed=new Set();
    for(const scenario of scenarios) {
      if(stopped()){deadlineReached||=Date.now()>=campaignDeadline;break;}
      const receipt=join(directory,'phase-result.json');await rm(receipt,{force:true});
      progressEvent({event:'step-start',step:'phase4-sharing',index:scenarios.indexOf(scenario)+1,total:scenarios.length});
      const ids=[...new Set(scenario.evidence.map(e=>e.id))];
      const priorFence=Boolean(environment.REGRESSION_RECOVERY_FENCE);
      child=await spawnStep('phase4-sharing',gpuCase?[gpuCase]:[],{REGRESSION_CAMPAIGN_RESULT:receipt,REGRESSION_SCENARIO_ID:scenario.id,
        REGRESSION_SCENARIO_REQUIRED:ids.join(','),REGRESSION_SCENARIO_SOURCE:scenario.source.file,REGRESSION_SCENARIO_TITLE:scenario.title});
      const exit=await waitChild(child),value=await childEvidence({output,receipt,mode:'phase4-sharing',required:ids,fixture:false,
        expectedRunId:allocatedRuns.get(child),sourceRevision:process.env.REGRESSION_SOURCE_REVISION,cancelled:Boolean(interruptedSignal)});
      await recordChild(value.result,'phase4-sharing',false);
      executed.add(scenario.id);
      collected.push(...stepCases(value.report.cases,exit,value.report.acceptable,false));
      inheritRecoveryCause(environment,value.report.cases,value.recoveryFence);
      if(value.recoveryFence&&!priorFence&&!interruptedSignal) {
        const recoveryReceipt=join(directory,'recovery-result.json');await rm(recoveryReceipt,{force:true});
        child=await spawnStep('campaign-recover',[value.result.runId],{REGRESSION_CAMPAIGN_RESULT:recoveryReceipt});
        const recoveryExit=await waitChild(child),recovered=await childEvidence({output,receipt:recoveryReceipt,mode:'campaign-recover',
          expectedRunId:allocatedRuns.get(child),required:['HAR-07'],fixture:false,sourceRevision:process.env.REGRESSION_SOURCE_REVISION});
        await recordChild(recovered.result,'campaign-recover',false);collected.push(...recovered.report.cases);
        const restored=recoveryExit===0&&recovered.report.acceptable&&!recovered.recoveryFence;
        const reason=recovered.report.cases.find(c=>c.outcome!=='Passed'&&c.reason)?.reason;
        recoveryAttempts.push({runId:value.result.runId,state:restored?'restored':'blocked',...(reason?{reason}:{})});
        if(restored)inheritRecoveryCause(environment,[],false);
      }
    }
    const state=await lifecycle(recoveryAttempts);
    const rows=await stopRows(collected);
    if(stopped())for(const scenario of scenarios.filter(s=>!executed.has(s.id)))for(const evidence of scenario.evidence)
      rows.push({...evidence,environment:'live',outcome:'Blocked',durationMs:0,reason:'DEPENDENCY',stage:'runner-execution',
        executionId:executionIdentity(runId,scenario.id),executionOutcome:'Blocked',
        blockedBy:{kind:deadlineReached?'failure':'cancelled',caseId:'HAR-10',reason:stopReason(),stage:'runner-execution',
          executionId:executionIdentity(runId,'runner-execution'),traceRunId:runId}});
    const report=await saveReport(directory,runId,stopped()?completeCases(mode,rows,required,stopReason()):rows,required,process.env.REGRESSION_SOURCE_REVISION,mode,undefined,state);
    process.exitCode=report.counts.Failed?1:report.counts.Blocked||report.recoveryFenceActive?2:0;
  } else if(mode === 'all') {
    let selected=[0,1,2,3,4,5,6,7,8];
    const arguments_=process.argv.slice(3);
    if(arguments_.length) {
      requireSafe(arguments_.length === 2 && arguments_[0] === '--phases','CONFIG');
      selected=preparationArguments(arguments_).phases;
    }
    environment.REGRESSION_PHASES=selected.join(',');process.env.REGRESSION_PHASES=selected.join(',');
    const preparation=await preparationDiagnostic();
    const phases=[],recoveryAttempts=[],collected=preparation?.outcome === 'Failed' ?
      [{id:'HAR-02',outcome:'Failed',layer:'A',environment:'live',durationMs:0,reason:preparation.reason ?? 'API'}] : [];
    for(const phase of selected) {
      if(stopped()){deadlineReached||=Date.now()>=campaignDeadline;break;}
      const receipt=join(directory,'phase-result.json');await rm(receipt,{force:true});
      console.log(`Regression campaign: Phase ${phase} P0 (isolated + installed layers).`);
      progressEvent({event:'phase-start',phase,selected});
      child=await spawnStep(`phase${phase}`,[],{REGRESSION_CAMPAIGN_RESULT:receipt});
      const code=await waitChild(child),ids=phaseIds(phase);
      const {result,report,recoveryFence}=await childEvidence({output,receipt,mode:`phase${phase}`,required:ids ?? [],
        expectedRunId:allocatedRuns.get(child),fixture:false,sourceRevision:process.env.REGRESSION_SOURCE_REVISION,cancelled:Boolean(interruptedSignal)});
      await recordChild(result,`phase${phase}`,false);
      const cases=stepCases(report.cases,code,report.acceptable === true,false);
      inheritRecoveryCause(environment,cases,recoveryFence);
      recoveryAttempts.push(...report.recoveryAttempts);
      if(result.continuation) {
        try {
          const next=await loadLabConfig(result.continuation),before=await loadLabConfig(environment.REGRESSION_CONFIG);
          verifyHostContinuation(before,next);
          environment.REGRESSION_CONFIG=result.continuation;
        } catch {
          cases.push({id:'HAR-10',outcome:'Failed',layer:'A',environment:'live',durationMs:0,reason:'RECOVERY'});
          environment.REGRESSION_RECOVERY_FENCE='1';
        }
      }
      const outcome=reportExitCode(cases);
      phases.push({phase,runId:result.runId,state:outcome === 0 ? 'Passed' : outcome === 1 ? 'Failed' : 'Blocked',counts:summarize(ids ?? [],cases).counts,
        executionCounts:summarizeExecutions(cases),blockedCounts:blockedCounts(cases),executionBlockedCounts:blockedCounts(cases,true)});
      progressEvent({event:'phase-end',phase,outcome:phases.at(-1).state});
      collected.push(...cases);
      await writePrivate(join(directory,'all-summary.json'),{version:1,phases,selectedPhases:selected,testMode:runTestMode,
        allSelectedPhasesPassed:phases.length === selected.length && phases.every(item=>item.state === 'Passed')});
    }
    if(stopped())for(const phase of selected.filter(value=>!phases.some(item=>item.phase === value))) {
      const cases=completeCases(`phase${phase}`,[],phaseIds(phase),stopReason());
      collected.push(...cases);phases.push({phase,state:'Blocked',counts:summarize(phaseIds(phase),cases).counts,
        executionCounts:summarizeExecutions(cases),blockedCounts:blockedCounts(cases),executionBlockedCounts:blockedCounts(cases,true)});
    }
    collected.push(...await stopRows([]));
    const passed=!stopped()&&phases.length === selected.length && phases.every(item=>item.state === 'Passed');
    await writePrivate(join(directory,'all-summary.json'),{version:1,phases,selectedPhases:selected,testMode:runTestMode,allSelectedPhasesPassed:passed});
    await saveReport(directory,runId,collected,[...new Set(collected.map(item=>item.id))],process.env.REGRESSION_SOURCE_REVISION,'all',undefined,
      await lifecycle(recoveryAttempts));
    const counts={Passed:0,Failed:0,Blocked:0};for(const item of collected)if(Object.hasOwn(counts,item.outcome))counts[item.outcome]++;
    await writePrivate(join(directory,'all-summary.txt'),(nonDestructive?'Magic Stick non-destructive regression (not full-phase acceptance)\n':'Magic Stick complete P0 regression\n')+
      (preparation ? preparationDescription(preparation)+'\n' : '')+
      'All checks\nCase / variant / layer evidence · isolated + live\n'+
      `Evidence rows (case × variant × layer): Passed: ${counts.Passed}; Failed: ${counts.Failed}; Blocked: ${counts.Blocked}\n`+
      `Blocked evidence: ${regressionBlockedSummary(blockedCounts(collected))}\n`+
      'Executable scenarios\n'+
      `Recorded executable scenarios: ${JSON.stringify(summarizeExecutions(collected))}\n`+
      `Blocked executable scenarios: ${regressionBlockedSummary(blockedCounts(collected,true))}\n`+
      phases.map(item=>`Phase ${item.phase}: ${item.state} (${item.runId ?? 'not executed: run cancelled'})`).join('\n')+'\nDetailed cases: summary.html; machine results: summary.json and junit.xml\n');
    console.log('Private campaign report: '+join(directory,'all-summary.txt'));
    progressEvent({event:'campaign-end',runId});
    process.exitCode=passed ? 0 : reportExitCode(collected);
  } else if (Object.hasOwn(phaseSteps,mode)) {
    const collected = [], steps = [],recoveryAttempts=[];
    const recoveryFenceAtStart=Boolean(environment.REGRESSION_RECOVERY_FENCE);
    const stepsToRun = selectedSteps(Number(mode.slice(-1)),runTestMode);
    for (const [index, step] of stepsToRun.entries()) {
      if(stopped()){deadlineReached||=Date.now()>=campaignDeadline;break;}
      const fixture = step === 'selftest' || /(?:-fast|-fixtures)$/.test(step);
      const priorFence=Boolean(environment.REGRESSION_RECOVERY_FENCE);
      const receipt=join(directory,'phase-result.json');await rm(receipt,{force:true});
      console.log(`Phase ${mode.slice(-1)} P0 step ${index + 1}/${stepsToRun.length}: ${step}`);
      progressEvent({event:'step-start',step,index:index+1,total:stepsToRun.length});
      console.log(`  ${modeDescription(step)}`);
      child = await spawnStep(step,[],{
        // Isolated tests exercise all product contracts against synthetic data;
        // they must not change assertions based on the live campaign's mode.
        ...(fixture?{REGRESSION_TEST_MODE:'full'}:{}),REGRESSION_CAMPAIGN_RESULT:receipt,...(step==='non-destructive-live'?{REGRESSION_READONLY_PHASE:mode.slice(-1)}:{}),
      });
      const exit=await waitChild(child);
      const {result,report,recoveryFence}=await childEvidence({output,receipt,mode:step,required:[],fixture,
        expectedRunId:allocatedRuns.get(child),sourceRevision:process.env.REGRESSION_SOURCE_REVISION,cancelled:Boolean(interruptedSignal)});
      await recordChild(result,step,fixture);
      if(recoveryFence)inheritRecoveryCause(environment,report.cases,true);
      collected.push(...stepCases(report.cases.map(item => index === stepsToRun.length - 1 && (item.variant === 'idle-baseline' ||
        step === 'preflight' && item.id === 'HAR-03' && item.reason === 'RECOVERY' && !item.executionId && !item.variant) ?
        {...item, variant: 'final-idle'} : item), exit, report.acceptable === true,
      fixture));
      let continued=true;
      if(result.continuation) {
        try {
          const next=result.continuation,continued=await loadLabConfig(next);
          verifyHostContinuation(await loadLabConfig(environment.REGRESSION_CONFIG),continued);
          environment.REGRESSION_CONFIG=next;
          await writePrivate(join(directory,'post-drill-lab.json'),continued,true);
        } catch {
          continued=false;
          collected.push({id:'HAR-10',outcome:'Failed',layer:'A',environment:'live',durationMs:0,reason:'RECOVERY'});
          environment.REGRESSION_RECOVERY_FENCE='1';
        }
      }
      steps.push({mode: step, runId: result.runId, passed: exit === 0 && report.acceptable === true && continued});
      await writePrivate(join(directory, 'steps.json'), steps);
      if(recoveryFence&&!report.recoveryAttempts.length&&!fixture&&!priorFence&&!interruptedSignal&&!nonDestructive) {
        const recoveryReceipt=join(directory,'recovery-result.json');await rm(recoveryReceipt,{force:true});
        console.log('Attempting exact finished-child restoration before independent live tests continue; original failure retained.');
        child=await spawnStep('campaign-recover',[result.runId],{REGRESSION_CAMPAIGN_RESULT:recoveryReceipt});
        const recoveryExit=await waitChild(child),recovered=await childEvidence({output,receipt:recoveryReceipt,mode:'campaign-recover',
          expectedRunId:allocatedRuns.get(child),required:['HAR-07'],fixture:false,sourceRevision:process.env.REGRESSION_SOURCE_REVISION,cancelled:Boolean(interruptedSignal)});
        await recordChild(recovered.result,'campaign-recover',false);
        collected.push(...stepCases(recovered.report.cases,recoveryExit,recovered.report.acceptable,false));
        const restored=recoveryExit===0&&recovered.report.acceptable&&!recovered.recoveryFence;
        if(restored)inheritRecoveryCause(environment,[],false);
        const reason=recovered.report.cases.find(item=>item.outcome!=='Passed'&&item.reason)?.reason;
        recoveryAttempts.push({runId:result.runId,state:restored?'restored':'blocked',...(reason?{reason}:{} )});
        await writePrivate(join(directory,'campaign-recovery-attempts.json'),{version:1,recoveryAttempts});
      }
    }
    const selectedRequired=nonDestructive?[...new Set(collected.map(item=>item.id))]:required;
    const rows=await stopRows(collected);
    const report = await saveReport(directory, runId, stopped() ? completeCases(mode,rows,selectedRequired,stopReason()) : rows,
      selectedRequired, process.env.REGRESSION_SOURCE_REVISION, mode,undefined,
      {...await lifecycle(recoveryAttempts),recoveryFenceAtStart});
    console.log(`Private Phase ${mode.slice(-1)} P0 report: ${join(directory, 'summary.txt')}`);
    const summary=JSON.parse(await readPrivate(join(directory,'summary.json')));
    process.exitCode = (mode === 'phase4' ? report.installedPhase4Accepted : report[`fullPhase${mode.slice(-1)}Accepted`]) ? 0 : reportExitCode(summary.cases);
  } else if (mode !== 'cleanup-plan') {
    const arguments_ = mode === 'typecheck' ? [typeScriptCli, '-p', 'regression/tsconfig.json'] :
      [playwrightCli, 'test', '--config', 'regression/playwright.config.ts',
        ...(selectedModelCase ? ['--grep', selectedModelCase.grep] : selectedGpuCase ? ['--grep',selectedGpuCase.grep] : [])];
    if(scenarioId) {
      requireSafe(/^regression\/hardware\/(?:sharing|multi-gpu)\.e2e\.spec\.ts$/.test(process.env.REGRESSION_SCENARIO_SOURCE??'')&&
        typeof process.env.REGRESSION_SCENARIO_TITLE==='string','CONFIG');
      arguments_.push(process.env.REGRESSION_SCENARIO_SOURCE,'--grep',scenarioGrep(process.env.REGRESSION_SCENARIO_TITLE));
    }
    const execution=supervisedProcess(process.execPath,arguments_,{env:environment,stdio:'inherit'},
      {hardTimeoutMs:scenarioId?executionBudget.scenarioProcessMs:undefined});
    child=execution.child;supervisors.set(child,execution);
    process.exitCode=await waitChild(child);
    if(mode !== 'typecheck') {
      if(lastProcessResult)await writePrivate(join(directory,'process-state.json'),{version:1,runId,targetUid,
        checkedAt:new Date().toISOString(),process:execution.identity,...lastProcessResult});
      if(session){await session.finish(Boolean(interruptedSignal)||lastProcessResult?.interrupted,lastProcessResult?.processesStopped===true);sessionFinished=true;}
      let report;
      try {report=JSON.parse(await readPrivate(join(directory,'summary.json')));}
      catch {
        const rows=await interruptedEvidence(directory,runId,lastProcessResult?.timedOut||deadlineReached?'DEADLINE':interruptedSignal?'CANCELLED':'UNEXPECTED');
        await saveReport(directory,runId,rows,required,process.env.REGRESSION_SOURCE_REVISION,mode);
        report=JSON.parse(await readPrivate(join(directory,'summary.json')));
      }
      if(lastProcessResult?.timedOut||lastProcessResult?.forced||lastProcessResult?.orphaned||lastProcessResult?.processesStopped===false) {
        const fixture=mode==='selftest'||/(?:-fast|-fixtures)$/.test(mode);
        report.cases.push({id:'HAR-10',layer:fixture?'U':'A',environment:fixture?'fixture':'live',outcome:'Failed',durationMs:0,
          reason:lastProcessResult.timedOut?'DEADLINE':lastProcessResult.processesStopped===false?'PROCESS_STATE':'UNEXPECTED',stage:'runner-execution'});
        report.acceptable=false;
        if(fixture||nonDestructive)await saveReport(directory,runId,report.cases,required,process.env.REGRESSION_SOURCE_REVISION,mode);
      }
      if(!nonDestructive&&!/^(?:selftest|.*-fast|.*-fixtures)$/.test(mode)) {
        const state=await lifecycle(report.recoveryAttempts??[]);
        const rows=[...report.cases];
        if(state.cleanup.state!=='verified'&&!rows.some(c=>c.recoveryRequired||c.reason==='CLEANUP'))
          rows.push({id:'HAR-07',layer:'A',environment:'live',outcome:'Failed',durationMs:0,reason:'CLEANUP',stage:state.cleanup.stage??'cleanup',recoveryRequired:true});
        await saveReport(directory,runId,rows,required,process.env.REGRESSION_SOURCE_REVISION,mode,undefined,state);
        report.cases=rows;report.acceptable=report.acceptable&&state.cleanup.state==='verified';
      }
      process.exitCode=reportExitCode(stepCases(report.cases,process.exitCode,report.acceptable === true,
        mode === 'selftest' || /(?:-fast|-fixtures)$/.test(mode)));
    }
  }
} catch (error) {
  const reason = error instanceof HarnessError ? error.code : 'UNEXPECTED';
  const outcome=error instanceof HarnessError ? error.outcome : 'Failed';
  console.error(new HarnessError(reason,outcome).message);
  try {
    const entryGuard=reason==='RECOVERY' && process.env.REGRESSION_RECOVERY_FENCE &&
      mode!=='all' && !Object.hasOwn(phaseSteps,mode);
    const rows=entryGuard?guardedLiveCases(mode,required,recoveryCause(process.env.REGRESSION_RECOVERY_CAUSE)):
      required.map(id => ({id, outcome, layer: 'A', environment: 'live', durationMs: 0, reason}));
    await saveReport(directory, runId, rows, required,
      process.env.REGRESSION_SOURCE_REVISION, mode);
    console.log(`Private report: ${join(directory, 'summary.txt')}`);
  } catch { console.error('A safe report could not be written; check private-directory permissions.'); }
  process.exitCode = outcome === 'Failed' ? 1 : 2;
} finally {
  if(session&&!sessionFinished)try{await session.finish(Boolean(interruptedSignal),lastProcessResult?.processesStopped??!child);}catch{process.exitCode=2;}
  if(process.env.REGRESSION_CAMPAIGN_RESULT)try{
    const receipt=resolve(process.env.REGRESSION_CAMPAIGN_RESULT);
    requireSafe(receipt.startsWith(output+'/') &&
      (receipt.endsWith('/phase-result.json')||mode==='campaign-recover'&&receipt.endsWith('/recovery-result.json')),'PRIVATE_FILE');
    let continuation;
    const next=join(directory,'post-drill-lab.json');
    try{await readPrivate(next);continuation=next;}catch{/* No verified host transition in this phase. */}
    await writePrivate(receipt,{version:1,mode,runId,directory,exitCode:process.exitCode ?? 0,...(continuation ? {continuation} : {})});
  }catch{process.exitCode=2;}
  if (home) await rm(home, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
