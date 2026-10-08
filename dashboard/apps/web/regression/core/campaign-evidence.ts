import {join} from 'node:path';
import {privateDirectory,readPrivate} from './private-files.ts';
import {newRunId} from './journal.ts';
import {reasons,stages,requireSafe} from './errors.ts';
import {testLayers,environmentFor} from './evidence.ts';
import {saveReport,summarize,needsRecovery,type CaseResult,type RecoveryAttempt} from './report.ts';

/** A crashed child is a harness failure, not permission to abandon the other
 * phases or silently report its missing scenarios as successful. */
export async function childEvidence(options:{output:string;receipt:string;mode:string;required:string[];
  fixture:boolean;sourceRevision?:string;cancelled?:boolean}) {
  try {
    const result=JSON.parse(await readPrivate(options.receipt));
    requireSafe(result?.version === 1 && result.mode === options.mode && /^reg-[a-f0-9-]{36}$/.test(result.runId) &&
      result.directory === join(options.output,result.runId) && Number.isInteger(result.exitCode),'CONFIG');
    requireSafe(!result.continuation || result.continuation === join(result.directory,'post-drill-lab.json'),'PRIVATE_FILE');
    const report=JSON.parse(await readPrivate(join(result.directory,'summary.json')));
    requireSafe(report.runId === result.runId && Array.isArray(report.cases) && report.cases.length <= 20_000 &&
      typeof report.acceptable === 'boolean','CONFIG');
    const cases:CaseResult[]=report.cases.map((item:CaseResult)=>{
      requireSafe(/^[A-Z][A-Z0-9]+-\d{2}$/.test(item.id) && ['Passed','Failed','Blocked'].includes(item.outcome) &&
        testLayers.includes(item.layer) && Number.isFinite(item.durationMs) && item.durationMs >= 0 &&
        (item.environment === 'fixture' || item.environment === 'live') &&
        item.environment === environmentFor(item.layer),'CONFIG');
      return {id:item.id,outcome:item.outcome,layer:item.layer,environment:item.environment,durationMs:item.durationMs,
        ...(item.reason && Object.hasOwn(reasons,item.reason) ? {reason:item.reason} : {}),
        ...(item.stage && stages.includes(item.stage) ? {stage:item.stage} : {}),
        ...(item.executionId && /^[a-f0-9]{24}$/.test(item.executionId) ? {executionId:item.executionId} : {}),
        ...(item.executionId&&typeof item.traceRunId==='string'&&/^reg-[0-9a-f-]{36}$/.test(item.traceRunId)?{traceRunId:item.traceRunId}:{}),
        ...(item.recoveryRequired===true?{recoveryRequired:true}:{}),
        ...(item.executionId && /^[a-f0-9]{24}$/.test(item.executionId) &&
          ['Passed','Failed','Blocked'].includes(item.executionOutcome ?? '') ? {executionOutcome:item.executionOutcome} : {}),
        ...(typeof item.variant === 'string' ? {variant:item.variant} : {})};
    });
    const recoveryAttempts:RecoveryAttempt[]=[];
    for(const item of report.recoveryAttempts??[])if(item&&/^reg-[0-9a-f-]{36}$/.test(item.runId)&&['restored','blocked'].includes(item.state))
      recoveryAttempts.push({runId:item.runId,state:item.state,...(item.reason&&Object.hasOwn(reasons,item.reason)?{reason:item.reason}:{})});
    return {result:{mode:options.mode,runId:result.runId as string,directory:result.directory as string,
      continuation:result.continuation as string|undefined},report:{cases,acceptable:report.acceptable,
      recoveryAttempts,counts:summarize(options.required,cases).counts},
      recoveryFence:typeof report.recoveryFenceActive==='boolean'?report.recoveryFenceActive:needsRecovery(cases)};
  } catch {
    const runId=newRunId(),directory=join(options.output,runId);
    await privateDirectory(directory);
    await saveReport(directory,runId,[{id:'HAR-10',layer:options.fixture ? 'U' : 'A',
      environment:options.fixture ? 'fixture' : 'live',outcome:options.cancelled ? 'Blocked' : 'Failed',durationMs:0,
      reason:options.cancelled ? 'CANCELLED' : 'UNEXPECTED'}],
      options.required,options.sourceRevision,options.mode);
    const report=JSON.parse(await readPrivate(join(directory,'summary.json')));
    return {result:{mode:options.mode,runId,directory,continuation:undefined},
      report:{cases:report.cases as CaseResult[],acceptable:false,recoveryAttempts:[] as RecoveryAttempt[],counts:report.counts},recoveryFence:!options.fixture};
  }
}
