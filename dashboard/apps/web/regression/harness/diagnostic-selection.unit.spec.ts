import {test,expect} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {diagnosticSelection,diagnosticSelections,diagnosticMetadata,diagnosticMode,diagnosticForMode} from '../core/diagnostic-selection.ts';
import {runDiagnosticSelection} from '../core/kubernetes-diagnostic.ts';
import {diagnosticScenarios,diagnosticRequirements,registeredScenarioSource} from '../core/scenario-selection.ts';
import {completeCases,saveReport,type CaseResult} from '../core/report.ts';
import {ResourceJournal,newRunId} from '../core/journal.ts';
import {attestCleanup} from '../core/cleanup-state.ts';
import {privateDirectory,readPrivate} from '../core/private-files.ts';
import {publicResult} from '../core/kubernetes-progress.ts';
import {owningEnvironment} from '../components/owning.ts';

let previous:NodeJS.ProcessEnv;
test.beforeEach(()=>{previous={...process.env};delete process.env.REGRESSION_SCENARIO_ID;delete process.env.REGRESSION_GPU_CASE;delete process.env.REGRESSION_DIAGNOSTIC_SELECTION;process.env.REGRESSION_TEST_MODE='full';});
test.afterEach(()=>{for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);});

test('HAR-02 HAR-10 diagnostic allowlist rejects arbitrary commands, invalid phases, safe mode and recovery',()=>{
  expect(diagnosticSelection(undefined,[0,1,4],'full')).toBeUndefined();
  for(const profile of diagnosticSelections) {
    expect(diagnosticSelection(profile.id,[profile.phase],'full')).toEqual(profile);
    expect(()=>diagnosticSelection(profile.id,[profile.phase===4?3:4],'full')).toThrow('[CONFIG]');
  }
  for(const value of [null,'',[],true,'SLOT-09','.*','../../all','unknown'])expect(()=>diagnosticSelection(value,[4],'full')).toThrow('[CONFIG]');
  for(const [phases,mode,operation] of [[[3,4],'full','tests'],[[3],'full','tests'],[[],'full','recover-lock'],[[4],'non-destructive','tests']] as const)
    expect(()=>diagnosticSelection('remaining',[...phases],mode,operation)).toThrow('[CONFIG]');
  process.env.REGRESSION_GPU_CASE='';
  expect(diagnosticForMode('phase4-sharing')).toBeUndefined();
  process.env.REGRESSION_DIAGNOSTIC_SELECTION='';
  expect(()=>diagnosticForMode('phase4-sharing')).toThrow('[CONFIG]');
});

test('HAR-10 real Playwright discovery selects exactly the registered diagnostic evidence without executing live fixtures',async()=>{
  const output=await mkdtemp(join(tmpdir(),'magicstick-diagnostic-discovery-'));
  try {
    for(const profile of diagnosticSelections) {
      const directory=join(output,profile.id);await privateDirectory(directory);
      const child=spawnSync(process.execPath,['node_modules/@playwright/test/cli.js','test','--config','regression/playwright.config.ts','--list','--grep',profile.grep],
        {env:{...owningEnvironment(),REGRESSION_MODE:diagnosticMode(profile),REGRESSION_DISCOVER_ONLY:'1',REGRESSION_DIAGNOSTIC_SELECTION:profile.id,
          REGRESSION_RUN_ID:newRunId(),REGRESSION_RUN_DIR:directory,REGRESSION_INPUT_DIR:directory,NODE_OPTIONS:''},
        encoding:'utf8',timeout:15_000,maxBuffer:1024*1024});
      expect(child.error).toBeUndefined();expect(child.status).toBe(0);
      const scenarios=diagnosticScenarios(JSON.parse(await readPrivate(join(directory,'scenario-selection.json'))),profile);
      expect(scenarios.length).toBeGreaterThan(0);
      expect(scenarios.every(s=>registeredScenarioSource(profile.phase,s.source.file))).toBe(true);
      if(profile.variants)expect(scenarios.every(s=>s.evidence.every(e=>profile.variants!.includes(e.variant!)))).toBe(true);
    }
  }finally{await rm(output,{recursive:true,force:true});}
});

for(const profile of diagnosticSelections)test(`HAR-10 ${profile.id} discovery requires every selected live tuple, not merely one case family`,()=>{
  const required=diagnosticRequirements(profile),mode=diagnosticMode(profile);
  const file=profile.phase===2?'regression/models/cpu-model-control.e2e.spec.ts':profile.phase===3?
    'regression/hardware/validation.e2e.spec.ts':'regression/hardware/sharing.e2e.spec.ts';
  const manifest={version:1,scenarios:required.map((e,index)=>({id:'selected-'+index,title:profile.title+' '+index,
    source:{file,line:1},evidence:[e]}))};
  expect(diagnosticScenarios(manifest,profile)).toHaveLength(required.length);
  expect(()=>diagnosticScenarios({...manifest,scenarios:manifest.scenarios.slice(1)},profile)).toThrow('[CONFIG]');
  expect(()=>diagnosticScenarios({...manifest,scenarios:[...manifest.scenarios,manifest.scenarios[0]]},profile)).toThrow('[CONFIG]');
  expect(()=>diagnosticScenarios({...manifest,scenarios:manifest.scenarios.map(s=>({...s,source:{file:'regression/harness/foreign.e2e.spec.ts',line:1}}))},profile)).toThrow('[CONFIG]');
  process.env.REGRESSION_DIAGNOSTIC_SELECTION=profile.id;
  const rows:CaseResult[]=required.map(r=>({...r,variant:r.variant as CaseResult['variant'],outcome:'Passed',durationMs:1}));
  expect(completeCases(mode,rows,profile.caseIds).some(r=>r.reason==='MISSING_EVIDENCE')).toBe(false);
  expect(completeCases(mode,rows.slice(1),profile.caseIds)).toEqual(expect.arrayContaining([
    expect.objectContaining({id:'HAR-10',outcome:'Failed',reason:'MISSING_EVIDENCE'})]));
  process.env.REGRESSION_SCENARIO_ID='one-selected-child';
  expect(completeCases(mode,rows.slice(0,1),[rows[0]!.id])).toHaveLength(1);
});

test('HAR-07 HAR-10 Kubernetes diagnostic uses the scoped serial launcher and exports the same bounded selection in every format',async()=>{
  const output=await mkdtemp(join(tmpdir(),'magicstick-diagnostic-'));
  try {
    for(const profile of diagnosticSelections) {
      process.env.REGRESSION_DIAGNOSTIC_SELECTION=profile.id;
      const mode=diagnosticMode(profile);
      const id=newRunId(),directory=join(output,id),journal=await ResourceJournal.create(join(directory,'journal.json'),id,'fixture-appliance');
      await attestCleanup(directory,{applianceUid:'fixture-appliance',nodeUids:['fixture-node']});
      const rows:CaseResult[]=diagnosticRequirements(profile)
        .map(r=>({...r,variant:r.variant as CaseResult['variant'],outcome:'Passed',durationMs:1}));
      await saveReport(directory,id,rows,profile.caseIds,'a'.repeat(40),mode,undefined,
        {cleanup:{state:'verified',checkedAt:new Date().toISOString()},recoveryFenceActive:false,recoveryAttempts:[]});
      let calls=0;
      const execute=async(args:string[],env:Record<string,string>)=>{
        calls++;expect(args).toEqual([mode,...(profile.phase===4?[profile.id]:[])]);
        expect(env.REGRESSION_DIAGNOSTIC_SELECTION).toBe(profile.id);
        // A real isolated child writes the same private launcher receipt; no
        // appliance, GPU or alternate orchestration engine is needed here.
        const child=spawnSync(process.execPath,['--input-type=module','-e',
          `import {writePrivate} from ${JSON.stringify(new URL('../core/private-files.ts',import.meta.url).href)};
           if(JSON.stringify(process.argv.slice(1))!==${JSON.stringify(JSON.stringify(args))})process.exit(91);
           await writePrivate(process.env.REGRESSION_CAMPAIGN_RESULT,${JSON.stringify({version:1,mode,runId:id,directory,exitCode:0})});`,
          '--',...args],{env:{...process.env,...env,NODE_OPTIONS:''},encoding:'utf8',timeout:10_000});
        expect(child.stderr).not.toMatch(/SyntaxError|ERR_MODULE_NOT_FOUND/);return child.status??1;
      };
      const options={selection:profile.id,phases:[profile.phase],output,uid:'11111111-2222-3333-4444-555555555555',execute,cancelled:()=>false};
      const value=await runDiagnosticSelection(options);
      expect(value.exit).toBe(0);expect(value.campaign.phases.map(p=>p.phase)).toEqual([profile.phase]);expect(calls).toBe(1);
      expect(value.summary.installedPhase4Accepted).toBe(false);expect(value.summary.fullPhase4Accepted).toBe(false);
      expect(publicResult(value.summary,value.campaign).diagnosticSelection).toEqual(diagnosticMetadata(profile));
      for(const name of ['summary.html','summary.txt','junit.xml']) {
        const text=await readPrivate(join(directory,name));expect(text).toContain(profile.title);
        for(const caseId of profile.caseIds)expect(text).toContain(caseId);
      }
      expect((await readPrivate(join(directory,'junit.xml')))).toContain('not assessed');
      // A green child flag cannot free retained worker resources. API and
      // downloadable report must both show the resulting cleanup failure.
      await journal.requested('model',journal.prefix+'left');await journal.owned('model',journal.prefix+'left','owned-uid',1);
      const fenced=await runDiagnosticSelection(options);
      expect(fenced.exit).toBe(1);expect(fenced.summary.cleanup.state).toBe('required');
      expect(fenced.summary.cases).toContainEqual(expect.objectContaining({id:'HAR-07',outcome:'Failed',reason:'CLEANUP'}));
      expect(await readPrivate(join(directory,'summary.html'))).toContain('Resource cleanup: required');
      const broken={...options,execute:async()=>{calls++;return 0;}};
      // Remove the old receipt; a no-op/crashed child must not reuse it.
      const crashed=await runDiagnosticSelection(broken);
      expect(crashed.exit).toBe(1);expect(crashed.runId).not.toBe(id);
      expect(crashed.summary.cases).toContainEqual(expect.objectContaining({id:'HAR-10',outcome:'Failed'}));
      expect(calls).toBe(3);
    }
  }finally{await rm(output,{recursive:true,force:true});}
});
