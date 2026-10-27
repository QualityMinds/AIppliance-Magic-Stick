import {test,expect,type APIRequestContext} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {testMode,selectedSteps,excludedSteps,requireSafeStep} from '../core/test-mode.ts';
import {phaseSteps} from '../profiles/selections.ts';
import {readOnlyApi} from '../core/transport.ts';
import {observeReadOnlyPhase} from '../core/non-destructive.ts';
import {saveReport} from '../core/report.ts';
import {readPrivate} from '../core/private-files.ts';
import {publicResult} from '../core/kubernetes-progress.ts';
import {remainingRequirements,remainingIds} from '../profiles/remaining-p0.ts';
import type {CaseResult} from '../core/report.ts';
import {deferredApplicationSteps} from '../core/engine-policy.ts';

test('HAR-10 test modes preserve legacy full selection and reject unknown or coerced values',()=>{
  expect(testMode()).toBe('full');expect(testMode('non-destructive')).toBe('non-destructive');
  for(const value of [null,true,false,{},[],'readonly',''])expect(()=>testMode(value)).toThrow('[CONFIG]');
  for(let phase=0;phase<=8;phase++)expect(selectedSteps(phase,'full')).toEqual(phaseSteps[`phase${phase}` as keyof typeof phaseSteps]);
  const deferred=deferredApplicationSteps([5]);
  expect(deferred).toEqual(['phase5/applications-live (deferred to separate regression)',
    'phase5/services-live (deferred to separate regression)','phase5/service-credentials-live (deferred to separate regression)']);
  expect(excludedSteps('full',[5])).toEqual(deferred);
  expect(excludedSteps('full',[2,3,4])).toEqual([]);
  expect(excludedSteps('non-destructive',[5])).toEqual(expect.arrayContaining(deferred));
});
test('HAR-04 HAR-10 non-destructive phases never select setup, recovery or mutable installed workflows',()=>{
  for(let phase=0;phase<=8;phase++) {
    const steps=selectedSteps(phase,'non-destructive');
    expect(steps.at(-1)).toBe('non-destructive-live');
    for(const step of steps)expect(()=>requireSafeStep(step,'non-destructive')).not.toThrow();
    for(const step of ['locktest','foundations','preflight','phase2-models','phase2-faults','phase3-gpu','phase3-validation',
      'phase4-sharing','phase5-live','phase6-live','phase7-live','phase8-live','campaign-recover','recover','gpu-recover','phase6-drill'])
      expect(()=>requireSafeStep(step,'non-destructive')).toThrow('[MUTATION]');
  }
  expect(excludedSteps('non-destructive',[3])).toContain('phase3/phase3-validation');
  expect(excludedSteps('non-destructive',[3])).not.toContain('phase2/phase2-models');
});
test('HAR-10 new installed steps are excluded by default, never implicitly safe',()=>{
  phaseSteps.phase3.push('future-installed-workflow');
  try {
    expect(selectedSteps(3,'non-destructive')).not.toContain('future-installed-workflow');
    expect(excludedSteps('non-destructive',[3])).toContain('phase3/future-installed-workflow');
    expect(()=>requireSafeStep('future-installed-workflow','non-destructive')).toThrow('[MUTATION]');
  }finally{phaseSteps.phase3.pop();}
});
test('HAR-02 HAR-10 read-only inventory permits active models but cannot send product writes',async()=>{
  const calls:string[]=[];
  const request={fetch:async(url:string,options:{method:string})=>{
    calls.push(options.method+' '+new URL(url).pathname);
    const payload=new URL(url).pathname==='/api/appliance'?{metadata:{uid:'fixture-appliance'}}:
      {activations:[{spec:{type:'local',enabled:true}}],computeTargets:{targets:[]}};
    return {status:()=>200,headers:()=>({'content-type':'application/json'}),body:async()=>Buffer.from(JSON.stringify(payload))};
  }} as unknown as Pick<APIRequestContext,'fetch'>;
  const api=readOnlyApi(request,'https://dashboard.example.local',1000);
  await observeReadOnlyPhase(api,2,{applianceUid:'fixture-appliance',nodeUids:['fixture-node']});
  expect(calls).toEqual(['GET /api/appliance','GET /api/models']);
  await expect(api.createLocalModel({name:'must-not-be-created'})).rejects.toMatchObject({code:'MUTATION'});
  await expect(api.enableModule('gpu')).rejects.toMatchObject({code:'MUTATION'});
  await expect(api.updateSettings({publicDomain:'example.com',mdnsDomain:'example.local'})).rejects.toMatchObject({code:'MUTATION'});
  expect(calls).toHaveLength(2);
});
test('HAR-10 restricted reports name exclusions in JSON HTML text JUnit and never certify full phases',async()=>{
  const previous=process.env.REGRESSION_TEST_MODE;process.env.REGRESSION_TEST_MODE='non-destructive';
  const directory=await mkdtemp(join(tmpdir(),'regression-test-mode-'));
  try {
    const summary=await saveReport(directory,'reg-11111111-2222-3333-4444-555555555555',[
      {id:'HAR-02',variant:'p3-non-destructive-read',outcome:'Passed',layer:'A',environment:'live',durationMs:1,
        executionId:'a'.repeat(24),executionOutcome:'Passed'}],['HAR-02'],'b'.repeat(40),'phase3');
    expect(summary.acceptable).toBe(true);expect(summary.fullPhase3Accepted).toBe(false);
    const json=JSON.parse(await readPrivate(join(directory,'summary.json')));
    expect(json.testMode).toBe('non-destructive');expect(json.excludedSteps).toContain('phase3/phase3-gpu');
    expect(json.counts.Blocked).toBe(0);expect(json.counts.Failed).toBe(0);
    expect(await readPrivate(join(directory,'summary.html'))).toContain('Not selected in this mode');
    expect(await readPrivate(join(directory,'summary.txt'))).toContain('Installed Phase 3 P0 gate: NOT ASSESSED');
    const junit=await readPrivate(join(directory,'junit.xml'));
    expect(junit).toContain('magicstick-not-selected-by-test-mode');expect(junit).toContain('type="NotSelected"');
    expect(junit).toContain('name="testMode" value="non-destructive"');
    const result=publicResult({...json,excludedSteps:['synthetic-secret']},{phases:[{phase:3,state:'Passed',counts:json.counts}]});
    expect(result.testMode).toBe('non-destructive');expect(result.excludedSteps).toContain('phase3/phase3-gpu');
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    process.env.REGRESSION_TEST_MODE='full';
    const required=remainingRequirements('phase5')!,proofs:CaseResult[]=required.map(item=>({...item,
      variant:item.variant as CaseResult['variant'],outcome:'Passed',durationMs:1}));
    const complete=await saveReport(directory,'reg-11111111-2222-3333-4444-555555555555',proofs,
      remainingIds('phase5')!,'b'.repeat(40),'phase5');
    expect(complete.acceptable).toBe(true);
    const reduced=JSON.parse(await readPrivate(join(directory,'summary.json')));
    expect(reduced.fullPhase5Accepted).toBe(false);
    const deferred=deferredApplicationSteps([5]);
    expect(reduced.excludedSteps).toEqual(deferred);
    expect(reduced.counts).toMatchObject({Passed:proofs.length,Failed:0,Blocked:0,Skipped:0});
    for(const filename of ['summary.html','summary.txt','junit.xml'])for(const label of deferred)
      expect(await readPrivate(join(directory,filename))).toContain(label);
    const deferredJunit=await readPrivate(join(directory,'junit.xml'));
    expect(deferredJunit).toContain('name="reason" value="SEPARATE_REGRESSION"');
    const campaign={phases:[{phase:5,state:'Passed',counts:reduced.counts}]};
    expect(publicResult(reduced,campaign).excludedSteps).toEqual(deferred);
    expect(publicResult({...reduced,excludedSteps:undefined},campaign).excludedSteps).toEqual([]);
    const legacy='phase5/hermes-live (deferred to separate regression)';
    const historic={...reduced,counts:{Passed:8,Failed:2,Blocked:4},excludedSteps:[legacy,'synthetic-secret'],
      cases:[{id:'APP-02',outcome:'Failed',reason:'DEADLINE',layer:'A',environment:'live',durationMs:1}]};
    const publicHistoric=publicResult(historic,campaign);
    expect(publicHistoric.counts).toMatchObject({Failed:2,Blocked:4});
    expect(publicHistoric.excludedSteps).toEqual([legacy]);
    expect(publicHistoric.cases).toEqual(expect.arrayContaining([expect.objectContaining({id:'APP-02',outcome:'Failed'})]));
    expect(historic.excludedSteps).toEqual([legacy,'synthetic-secret']);
  }finally{if(previous===undefined)delete process.env.REGRESSION_TEST_MODE;else process.env.REGRESSION_TEST_MODE=previous;await rm(directory,{recursive:true,force:true});}
});
