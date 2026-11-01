import {join} from 'node:path';
import {readPrivate} from './private-files.ts';
import {requireSafe,type ReasonCode} from './errors.ts';
import {environmentFor,testLayers,type Evidence} from './evidence.ts';
import {reportVariants,type CaseResult} from './report.ts';
import {executionIdentity} from './shared-workflow.ts';
import {parseExecutionTrace,saveExecutionTrace,type ExecutionTrace} from './execution-trace.ts';
import {runCleanupCaptures} from './cleanup-diagnostic.ts';

/** Recover only this coordinator's durable evidence after its entire process
 * group stopped. Never fill a missing test with an older run's result. */
export async function interruptedEvidence(directory:string,runId:string,reason:ReasonCode):Promise<CaseResult[]> {
  const layer='A',executionId=executionIdentity(runId,'runner-execution'),cancelled=reason==='CANCELLED';
  const cause={kind:cancelled?'cancelled' as const:'failure' as const,caseId:'HAR-10',reason,stage:'runner-execution',executionId,traceRunId:runId};
  const rows:CaseResult[]=[];
  try {
    const ledger=JSON.parse(await readPrivate(join(directory,'runner-evidence.json'),8*1024*1024));
    requireSafe(ledger.version===1&&ledger.runId===runId&&Array.isArray(ledger.scenarios)&&ledger.scenarios.length<=5000&&
      Array.isArray(ledger.cases)&&ledger.cases.length<=20_000&&Array.isArray(ledger.traces)&&ledger.traces.length<=5000,'CONFIG');
    const seen=new Set<string>();
    for(const scenario of ledger.scenarios) {
      requireSafe(/^[a-f0-9]{24}$/.test(scenario.executionId)&&!seen.has(scenario.executionId)&&
        ['selected','running','completed'].includes(scenario.state)&&Array.isArray(scenario.evidence)&&scenario.evidence.length<=500,'CONFIG');
      seen.add(scenario.executionId);
      if(scenario.state==='completed') {
        const completed=ledger.cases.filter((c:CaseResult)=>c.executionId===scenario.executionId);
        requireSafe(completed.every((c:CaseResult)=>['Passed','Failed','Blocked'].includes(c.outcome)&&testLayers.includes(c.layer)&&
          /^[A-Z][A-Z0-9]+-\d{2}$/.test(c.id)&&Number.isFinite(c.durationMs)&&c.durationMs>=0),'CONFIG');
        rows.push(...completed);continue;
      }
      for(const evidence of scenario.evidence as Evidence[]) {
        requireSafe(/^[A-Z][A-Z0-9]+-\d{2}$/.test(evidence.id)&&testLayers.includes(evidence.layer)&&
          (!evidence.variant||reportVariants[evidence.variant]===evidence.id),'CONFIG');
        const outcome=scenario.state==='running'&&!cancelled?'Failed':'Blocked';
        rows.push({...evidence,variant:evidence.variant as CaseResult['variant'],environment:environmentFor(evidence.layer),outcome,durationMs:0,
          reason:scenario.state==='running'?reason:'DEPENDENCY',stage:'runner-execution',executionId:scenario.executionId,
          executionOutcome:outcome,...(scenario.state==='running'?{traceRunId:runId}:{}),...(outcome==='Blocked'?{blockedBy:cause}:{})});
      }
    }
    for(const value of ledger.traces) {
      const trace=parseExecutionTrace(value);requireSafe(trace.runId===runId&&seen.has(trace.executionId),'CONFIG');
      await saveExecutionTrace(directory,trace);
    }
    if(ledger.pendingTraces!==undefined) {
      requireSafe(Array.isArray(ledger.pendingTraces)&&ledger.pendingTraces.length<=5000,'CONFIG');
      const pending=new Set<string>();
      for(const value of ledger.pendingTraces) {
        const trace=parseExecutionTrace(value);
        requireSafe(trace.runId===runId&&!pending.has(trace.executionId)&&ledger.scenarios.some((s:{executionId:string;state:string})=>
          s.executionId===trace.executionId&&s.state==='running'),'CONFIG');pending.add(trace.executionId);
        const steps=[...trace.steps],index=(trace.steps.at(-1)?.index??0)+1;
        if(steps.length===2000) {
          const firstFailure=steps.find(step=>step.outcome==='Failed');
          const removal=steps.findIndex((step,i)=>i>=16&&i<steps.length-1&&step!==firstFailure);
          const removed=steps.splice(removal,1)[0]!;
          for(const step of steps)if(step.parentIndex===removed.index) {
            if(removed.parentIndex)step.parentIndex=removed.parentIndex;else delete step.parentIndex;
          }
        }
        await saveExecutionTrace(directory,{...trace,outcome:cancelled?'Blocked':'Failed',steps:[...steps,
          {index,category:'hook',title:'Setup/teardown hook',outcome:cancelled?'Blocked':'Failed',durationMs:0,reason,stage:'runner-execution'}],
          ...(trace.steps.length===2000?{omittedSteps:(trace.omittedSteps??0)+1}:{})});
      }
    }
  } catch {
    // A damaged/missing ledger is itself missing evidence. Preserve no
    // unvalidated passes; the explicit infrastructure error below remains.
    rows.length=0;
  }
  const captures=await runCleanupCaptures(directory,runId);
  const trace:ExecutionTrace={version:1,runId,executionId,outcome:cancelled?'Blocked':'Failed',durationMs:0,
    ...(captures.diagnostics.length?{cleanupDiagnostics:captures.diagnostics}:{}),
    ...(captures.unavailable?{diagnosticsUnavailable:captures.unavailable}:{}),
    ...(captures.omitted?{omittedCleanupDiagnostics:captures.omitted}:{}),
    steps:[{index:1,category:'hook',title:'Setup/teardown hook',outcome:cancelled?'Blocked':'Failed',durationMs:0,reason,stage:'runner-execution'}]};
  await saveExecutionTrace(directory,trace);
  rows.push({id:'HAR-10',layer,environment:'live',outcome:trace.outcome,durationMs:0,reason,stage:'runner-execution',
    executionId,executionOutcome:trace.outcome,traceRunId:runId,...(cancelled?{blockedBy:cause}:{})});
  return rows;
}
