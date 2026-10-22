import {join} from 'node:path';
import {rm} from 'node:fs/promises';
import {diagnosticSelection} from './diagnostic-selection.ts';
import {privateDirectory,readPrivate} from './private-files.ts';
import {childEvidence} from './campaign-evidence.ts';
import {requireSafe,HarnessError} from './errors.ts';
import {saveReport,type CaseResult} from './report.ts';

/** Scoped execution uses the existing serial launcher and cleanup evidence.
 * There is deliberately no whole-phase fallback for a bad child receipt. */
export async function runDiagnosticSelection(options:{selection:string;output:string;uid:string;sourceRevision?:string;
  execute:(args:string[],environment:Record<string,string>)=>Promise<number>;cancelled:()=>boolean}) {
  const selected=diagnosticSelection(options.selection,[4],'full')!;
  requireSafe(/^[a-f0-9-]{36}$/.test(options.uid),'CONFIG');
  const receiptDirectory=join(options.output,'diagnostic-'+options.uid);await privateDirectory(receiptDirectory);
  const receipt=join(receiptDirectory,'phase-result.json');await rm(receipt,{force:true});
  const exit=await options.execute(['phase4-sharing',selected.id],{REGRESSION_CAMPAIGN_RESULT:receipt});
  const evidence=await childEvidence({output:options.output,receipt,mode:'phase4-sharing',required:selected.caseIds,fixture:false,
    sourceRevision:options.sourceRevision,cancelled:options.cancelled()});
  const directory=evidence.result.directory;
  let summary=JSON.parse(await readPrivate(join(directory,'summary.json'),8*1024*1024));
  if(summary.diagnosticSelection?.id!==selected.id)throw new HarnessError('CONFIG','Failed','report-evidence');
  const cases:CaseResult[]=[...summary.cases];
  if(evidence.recoveryFence&&summary.cleanup?.state==='verified')
    cases.push({id:'HAR-07',layer:'A',environment:'live',outcome:'Failed',durationMs:0,reason:'CLEANUP',stage:'recovery-journal'});
  // Export the independently checked status too; the downloadable formats
  // must not retain a different cleanup claim from the public status object.
  await saveReport(directory,evidence.result.runId,cases,selected.caseIds,options.sourceRevision,'phase4-sharing',summary.automaticPreparation,
    {recoveryFenceActive:evidence.recoveryFence,recoveryAttempts:summary.recoveryAttempts??[],cleanup:evidence.cleanup});
  summary=JSON.parse(await readPrivate(join(directory,'summary.json'),8*1024*1024));
  const state=summary.counts.Failed||exit===1?'Failed':summary.counts.Blocked||exit||evidence.recoveryFence?'Blocked':'Passed';
  const campaign={phases:[{phase:4,state,counts:summary.counts,executionCounts:summary.executionCounts,
    blockedCounts:summary.blockedCounts,executionBlockedCounts:summary.executionBlockedCounts}]};
  return {directory,runId:evidence.result.runId,summary,campaign,exit:state==='Failed'?1:state==='Blocked'?2:0,state};
}
