import {test,expect} from '@playwright/test';
import {ServiceStageGates} from '../core/service-stage-gates.ts';
import {serviceMatrix,serviceStageEvidence,type ServiceStage} from '../core/service-matrix.ts';
import type {GpuScenarioSelection} from '../core/scenario-selection.ts';
import type {CaseResult} from '../core/report.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {spawnSync} from 'node:child_process';

const annotation=evidenceAnnotations({id:'HAR-10',layer:'U'}),campaign='reg-11111111-1111-1111-1111-111111111111',child='reg-22222222-2222-2222-2222-222222222222';
function fixture() {
  const capabilities={installation:{state:'supported' as const},access:{state:'supported' as const}};
  return serviceMatrix({modules:{},catalogJson:{modules:{one:{activationMode:'moduleactivation'},two:{activationMode:'moduleactivation'}},applications:{}}},
    {'module:one':capabilities,'module:two':capabilities});
}
function scenario(stage:ServiceStage,id='one'):GpuScenarioSelection {
  const entry=fixture().entries.find(entry=>entry.id===id)!;
  return {id:id+'-'+stage,title:'Service stage',source:{file:'regression/administration/services.e2e.spec.ts',line:1},evidence:serviceStageEvidence(stage,entry)};
}
function result(value= scenario('installation')) {
  return {runId:child,coordinatorRunId:campaign,exit:0,acceptable:true,recoveryFence:false,cleanup:{state:'verified' as const,checkedAt:'2026-11-12T10:00:00Z'},
    cases:value.evidence.map(row=>({...row,variant:row.variant as CaseResult['variant'],environment:'live' as const,outcome:'Passed' as const,durationMs:1,
      executionId:'a'.repeat(24),executionOutcome:'Passed' as const,traceRunId:child})) as CaseResult[]};
}

test('HAR-02 services stage gate imports under the plain Node launcher',annotation,()=>{
  const code=`await import(${JSON.stringify(new URL('../core/service-stage-gates.ts',import.meta.url).href)});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:15_000,env:{...process.env,NODE_OPTIONS:''}});
  expect(child.error).toBeUndefined();expect(child.status,child.stderr).toBe(0);
});

test('MOD-03 access requires every exact installation tuple and independently verified cleanup',annotation,()=>{
  const gates=new ServiceStageGates(fixture()),installation=scenario('installation'),access=scenario('access');
  expect(gates.blocked(installation,campaign)).toBeUndefined();expect(gates.record(installation,result())).toEqual([]);
  expect(gates.blocked(access,campaign)).toBeUndefined();expect(gates.record(access,result(access))).toEqual([]);
});

test('MOD-03 failed installation blocks only its own later stage with the original causal execution',annotation,()=>{
  const gates=new ServiceStageGates(fixture()),value=result(),root={...value.cases[0]!,outcome:'Failed' as const,executionOutcome:'Failed' as const,
    reason:'API' as const,stage:'module-ready' as const};
  gates.record(scenario('installation'),{...value,exit:1,acceptable:false,cases:[root,...value.cases.slice(1)]});
  const rows=gates.blocked(scenario('access'),campaign)!;
  expect(rows).toHaveLength(scenario('access').evidence.length);
  expect(rows.every(row=>row.outcome==='Blocked'&&row.reason==='DEPENDENCY'&&row.traceRunId===campaign&&/^[0-9a-f]{24}$/.test(row.executionId!))).toBe(true);
  expect(rows[0]!.blockedBy).toMatchObject({kind:'failure',caseId:'MOD-03',reason:'API',stage:'module-ready',executionId:'a'.repeat(24),traceRunId:child});
  expect(gates.blocked(scenario('installation','two'),campaign)).toBeUndefined();
});

test('MOD-04 green report/exit never qualifies partial or unknown cleanup, even after later recovery',annotation,()=>{
  for(const patch of [{cleanup:{state:'unknown' as const}},{cleanup:{state:'required' as const}},
    {cleanup:{state:'verified' as const,checkedAt:'invalid'}},{recoveryFence:true},{cleanup:undefined}]) {
    const gates=new ServiceStageGates(fixture()),failure=gates.record(scenario('installation'),{...result(),...patch});
    expect(failure).toContainEqual(expect.objectContaining({id:'HAR-07',outcome:'Failed',reason:'CLEANUP',recoveryRequired:true}));
    expect(failure[0]!.traceRunId).toBe(campaign);
    // Clearing the global fence cannot change the earlier stage's acceptance.
    const blocked=gates.blocked(scenario('access'),campaign,false)!;
    expect(blocked[0]!.blockedBy).toMatchObject({kind:'failure',caseId:'HAR-07',reason:'CLEANUP'});
  }
});

test('HAR-10 missing, duplicate or non-Passed installation tuples cannot be filled by another entry',annotation,()=>{
  const value=result();
  for(const cases of [value.cases.slice(1),[...value.cases,value.cases[0]!],result(scenario('installation','two')).cases,
    value.cases.map(row=>({...row,outcome:'Blocked' as const,reason:'PREREQUISITE' as const}))]) {
    const gates=new ServiceStageGates(fixture());gates.record(scenario('installation'),{...value,cases});
    expect(gates.blocked(scenario('access'),campaign)).toEqual(expect.arrayContaining([expect.objectContaining({outcome:'Blocked'})]));
  }
  for(const patch of [{acceptable:false},{exit:1},{cases:value.cases.map(row=>({...row,recoveryRequired:true as const}))}]) {
    const gates=new ServiceStageGates(fixture());expect(gates.record(scenario('installation'),{...value,...patch})).toHaveLength(1);
    expect(gates.blocked(scenario('access'),campaign)).toBeDefined();
  }
});

test('HAR-07 a held recovery fence prevents even unrelated service fixture starts',annotation,()=>{
  const gates=new ServiceStageGates(fixture()),cause={kind:'failure' as const,caseId:'HAR-07',reason:'CLEANUP' as const,stage:'cleanup' as const,
    executionId:'b'.repeat(24),traceRunId:child};
  const blocked=gates.blocked(scenario('installation','two'),campaign,true,cause)!;
  expect(blocked.every(row=>row.reason==='RECOVERY'&&row.blockedBy?.executionId===cause.executionId)).toBe(true);
  expect(gates.blocked(scenario('access','two'),campaign,false)![0]!.blockedBy).toEqual(cause);
});

test('HAR-10 out-of-order, mixed-entry or duplicate service stage credit is refused',annotation,()=>{
  const gates=new ServiceStageGates(fixture());expect(gates.blocked(scenario('access'),campaign)![0]!.blockedBy)
    .toMatchObject({caseId:'HAR-10',reason:'MISSING_EVIDENCE'});
  expect(()=>gates.record(scenario('access'),result(scenario('access')))).toThrow('[CONFIG]');
  const mixed={...scenario('installation'),evidence:[...scenario('installation').evidence,...scenario('installation','two').evidence]};
  expect(()=>new ServiceStageGates(fixture()).blocked(mixed,campaign)).toThrow('[CONFIG]');
});
