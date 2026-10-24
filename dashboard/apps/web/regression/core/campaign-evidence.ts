import {join} from 'node:path';
import {privateDirectory,readPrivate} from './private-files.ts';
import {newRunId} from './journal.ts';
import {reasons,stages,requireSafe} from './errors.ts';
import {testLayers,environmentFor} from './evidence.ts';
import {saveReport,summarize,type CaseResult,type RecoveryAttempt} from './report.ts';
import {checkedBlocker} from './blocking.ts';
import {assessRunCleanup} from './cleanup-state.ts';
import {interruptedEvidence} from './interrupted-evidence.ts';

/** A crashed child is a harness failure, not permission to abandon the other
 * phases or silently report its missing scenarios as successful. */
export async function childEvidence(options:{output:string;receipt:string;mode:string;required:string[];
  fixture:boolean;sourceRevision?:string;cancelled?:boolean;expectedRunId?:string}) {
  try {
    const result=JSON.parse(await readPrivate(options.receipt));
    requireSafe(result?.version === 1 && result.mode === options.mode && /^reg-[a-f0-9-]{36}$/.test(result.runId) &&
      result.directory === join(options.output,result.runId) && Number.isInteger(result.exitCode),'CONFIG');
    requireSafe(!options.expectedRunId||result.runId===options.expectedRunId,'CONFIG');
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
        ...(item.outcome==='Blocked'&&checkedBlocker(item.blockedBy)?{blockedBy:checkedBlocker(item.blockedBy)}:{}),
        ...(item.executionId && /^[a-f0-9]{24}$/.test(item.executionId) &&
          ['Passed','Failed','Blocked'].includes(item.executionOutcome ?? '') ? {executionOutcome:item.executionOutcome} : {}),
        ...(typeof item.variant === 'string' ? {variant:item.variant} : {})};
    });
    const recoveryAttempts:RecoveryAttempt[]=[];
    for(const item of report.recoveryAttempts??[])if(item&&/^reg-[0-9a-f-]{36}$/.test(item.runId)&&['restored','blocked'].includes(item.state))
      recoveryAttempts.push({runId:item.runId,state:item.state,...(item.reason&&Object.hasOwn(reasons,item.reason)?{reason:item.reason}:{})});
    const cleanup=options.fixture?undefined:await assessRunCleanup(options.output,result.directory,true);
    return {result:{mode:options.mode,runId:result.runId as string,directory:result.directory as string,
      continuation:result.continuation as string|undefined},report:{cases,acceptable:report.acceptable,
      recoveryAttempts,counts:summarize(options.required,cases).counts},
      cleanup,recoveryFence:options.fixture?false:cleanup?.state!=='verified'};
  } catch {
    const runId=options.expectedRunId&&/^reg-[0-9a-f-]{36}$/.test(options.expectedRunId)?options.expectedRunId:newRunId(),directory=join(options.output,runId);
    await privateDirectory(directory);
    const reason=options.cancelled?'CANCELLED':'UNEXPECTED';
    const rows=options.expectedRunId?await interruptedEvidence(directory,runId,reason):[{id:'HAR-10',layer:options.fixture ? 'U' as const : 'A' as const,
      environment:options.fixture ? 'fixture' : 'live',outcome:options.cancelled ? 'Blocked' : 'Failed',durationMs:0,
      reason}] as CaseResult[];
    const cleanup=options.fixture?undefined:await assessRunCleanup(options.output,directory,true);
    await saveReport(directory,runId,rows,options.required,options.sourceRevision,options.mode,undefined,
      cleanup?{cleanup,recoveryFenceActive:cleanup.state!=='verified',recoveryAttempts:[]}:undefined);
    const report=JSON.parse(await readPrivate(join(directory,'summary.json')));
    return {result:{mode:options.mode,runId,directory,continuation:undefined},
      report:{cases:report.cases as CaseResult[],acceptable:false,recoveryAttempts:[] as RecoveryAttempt[],counts:report.counts},
      cleanup,recoveryFence:options.fixture?false:cleanup?.state!=='verified'};
  }
}
