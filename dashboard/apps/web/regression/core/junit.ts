import {caseDescription} from './case-descriptions.ts';
import {reasons} from './errors.ts';
import type {CaseResult} from './report.ts';
import type {TraceArtifact} from './report-artifacts.ts';
import {blockerDescription} from './blocker-description.ts';
import {regressionBlockedLabel} from '../../../../packages/core/src/regression-blocking.ts';
import type {RegressionCleanup} from '@magicstick/dashboard-contracts';

const xml=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]!));
type Entry={name:string;classname:string;outcome:string;durationMs:number;detail:string;properties:Record<string,string>;
  source?:{file:string;line:number};output?:string};
function suite(name:string,entries:Entry[],excludedEngines:readonly string[]=[]) {
  return `<testsuite name="${name}" tests="${entries.length}" failures="${entries.filter(item=>item.outcome==='Failed').length}" skipped="${entries.filter(item=>['Blocked','Skipped'].includes(item.outcome)).length}">\n`+
    (excludedEngines.length ? `<properties><property name="excludedExperimentalEngines" value="${xml(excludedEngines.join(', '))}"/></properties>\n` : '')+
    entries.map(item=>`<testcase classname="${xml(item.classname)}" name="${xml(item.name)}" time="${(item.durationMs/1000).toFixed(3)}"`+
      (item.source?` file="${xml(item.source.file)}" line="${item.source.line}"`:'')+'>'+
      '<properties>'+Object.entries(item.properties).map(([name,value])=>`<property name="${xml(name)}" value="${xml(value)}"/>`).join('')+'</properties>'+
      (item.outcome==='Failed'?`<failure type="Failed" message="${xml(item.detail)}"/>`:['Blocked','Skipped'].includes(item.outcome)?`<skipped type="${item.outcome==='Blocked'?'Blocked':'NotSelected'}" message="${xml(item.detail)}"/>`:'')+
      (item.output?`<system-out>${xml(item.output)}</system-out>`:'')+'</testcase>').join('\n')+'\n</testsuite>';
}
/** Keep case/layer evidence, executable scenarios and steps as distinct suites.
 * Relative attachments work after extracting the sanitized report archive. */
export function junitReport(cases:CaseResult[],artifacts:TraceArtifact[],excludedEngines:readonly string[]=[],selection?:{testMode:string;excludedSteps:string[];cleanup?:RegressionCleanup}) {
  const lookup=new Map(artifacts.map(item=>[item.trace.executionId,item]));
  const evidence:Entry[]=cases.map(item=>{
    const artifact=item.executionId?lookup.get(item.executionId):undefined;
    return {name:item.id+(item.variant?'/'+item.variant:''),classname:`${item.environment}.${item.layer}`,outcome:item.outcome,
      durationMs:item.durationMs,detail:(item.blockedBy?regressionBlockedLabel(item.blockedBy.kind)+': ':'')+
        (item.reason?blockerDescription(item.reason,item.id,item.variant,item.layer):item.outcome),
      properties:{catalogueGoal:caseDescription(item.id),outcome:item.outcome,
        ...(item.executionId?{executionId:item.executionId}:{}),...(item.executionOutcome?{executionOutcome:item.executionOutcome}:{}),
        ...(item.reason?{reason:item.reason}:{}),...(item.stage?{stage:item.stage}:{}),
        ...(item.blockedBy?{blockedKind:item.blockedBy.kind,
          ...(item.blockedBy.caseId?{blockedByCase:item.blockedBy.caseId}:{}),
          ...(item.blockedBy.reason?{blockedByReason:item.blockedBy.reason}:{}),
          ...(item.blockedBy.stage?{blockedByStage:item.blockedBy.stage}:{}),
          ...(item.blockedBy.executionId?{blockedByExecution:item.blockedBy.executionId}:{}),
          ...(item.blockedBy.traceRunId?{blockedByRun:item.blockedBy.traceRunId}:{})}:{}),
        ...(item.recoveryRequired?{recoveryRequired:'true'}:{}),...(artifact?{trace:artifact.path}:{} )}};
  });
  const scenarios:Entry[]=artifacts.map(artifact=>{
    const {trace}=artifact,rows=cases.filter(item=>item.executionId===trace.executionId),reason=rows.find(item=>item.reason)?.reason;
    const attachments=[artifact.path,...(artifact.componentPath?[artifact.componentPath]:[])];
    return {name:trace.scenario??trace.executionId,classname:'scenario',outcome:trace.outcome,
      durationMs:trace.durationMs,detail:reason?reasons[reason]:trace.recoveryRequired?reasons.CLEANUP:trace.outcome,
      source:trace.source,properties:{executionId:trace.executionId,outcome:trace.outcome,
        cases:[...new Set(rows.map(item=>item.id))].join(', '),traceFormat:'filtered-call-trace',trace:artifact.path,
        traceComplete:String(!trace.omittedSteps),...(trace.omittedSteps?{omittedSteps:String(trace.omittedSteps)}:{}),
        ...(trace.runtimeDiagnostics?.length?{runtimeDiagnosticCount:String(trace.runtimeDiagnostics.length)}:{}),
        ...(artifact.componentPath?{componentDiagnostic:artifact.componentPath}:{}),...(trace.recoveryRequired?{recoveryRequired:'true'}:{} )},
      output:JSON.stringify({outcome:trace.outcome,steps:trace.steps.length,omittedSteps:trace.omittedSteps??0,trace:artifact.path,
        ...(trace.runtimeDiagnostics?.length?{runtimeDiagnostics:trace.runtimeDiagnostics}:{} )})+'\n'+
        attachments.map(path=>`[[ATTACHMENT|${path}]]`).join('\n')};
  });
  const steps:Entry[]=artifacts.flatMap(({trace,path})=>trace.steps.map(step=>({name:`${step.index}: ${step.title}`,
    classname:`steps.${trace.executionId}`,outcome:step.outcome,durationMs:step.durationMs,
    detail:step.reason?reasons[step.reason]:step.outcome,source:step.source,
    properties:{executionId:trace.executionId,stepIndex:String(step.index),category:step.category,outcome:step.outcome,trace:path,
      ...(step.parentIndex?{parentStep:String(step.parentIndex)}:{}),...(step.reason?{reason:step.reason}:{}),...(step.stage?{stage:step.stage}:{}),
      ...(step.handledError?{handledError:'true'}:{} )}})));
  if(selection)for(const item of evidence) {
    item.properties.testMode=selection.testMode;
    if(selection.cleanup) {
      item.properties.cleanupState=selection.cleanup.state;
      if(selection.cleanup.reason)item.properties.cleanupReason=selection.cleanup.reason;
      if(selection.cleanup.stage)item.properties.cleanupStage=selection.cleanup.stage;
    }
  }
  const excluded:Entry[]=(selection?.excludedSteps??[]).map(step=>({name:step,classname:'selection',outcome:'Skipped',durationMs:0,
    detail:'Not selected: non-destructive mode. No destructive or preparation-dependent live step was executed.',properties:{testMode:selection!.testMode,outcome:'Not selected',reason:'TEST_MODE'}}));
  return '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n'+suite('magicstick-selected-regression',evidence,excludedEngines)+'\n'+
    (excluded.length?suite('magicstick-not-selected-by-test-mode',excluded)+'\n':'')+
    suite('magicstick-executable-scenarios',scenarios)+'\n'+suite('magicstick-test-steps',steps)+'\n</testsuites>\n';
}
