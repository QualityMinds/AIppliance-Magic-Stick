import {join} from 'node:path';
import {readPrivate} from './private-files.ts';
import {requireSafe,type ReasonCode} from './errors.ts';
import {environmentFor,testLayers,type Evidence} from './evidence.ts';
import {reportVariants,type CaseResult} from './report.ts';
import {executionIdentity} from './shared-workflow.ts';
import {parseExecutionTrace,saveExecutionTrace,type ExecutionTrace} from './execution-trace.ts';

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
          executionOutcome:outcome,traceRunId:runId,...(outcome==='Blocked'?{blockedBy:cause}:{})});
      }
    }
    for(const value of ledger.traces) {
      const trace=parseExecutionTrace(value);requireSafe(trace.runId===runId&&seen.has(trace.executionId),'CONFIG');
      await saveExecutionTrace(directory,trace);
    }
  } catch {
    // A damaged/missing ledger is itself missing evidence. Preserve no
    // unvalidated passes; the explicit infrastructure error below remains.
    rows.length=0;
  }
  const trace:ExecutionTrace={version:1,runId,executionId,outcome:cancelled?'Blocked':'Failed',durationMs:0,
    steps:[{index:1,category:'hook',title:'Setup/teardown hook',outcome:cancelled?'Blocked':'Failed',durationMs:0,reason,stage:'runner-execution'}]};
  await saveExecutionTrace(directory,trace);
  rows.push({id:'HAR-10',layer,environment:'live',outcome:trace.outcome,durationMs:0,reason,stage:'runner-execution',
    executionId,executionOutcome:trace.outcome,traceRunId:runId,...(cancelled?{blockedBy:cause}:{})});
  return rows;
}
