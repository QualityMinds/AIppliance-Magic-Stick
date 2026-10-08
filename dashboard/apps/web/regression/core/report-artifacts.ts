import {lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {readExecutionTrace,type ExecutionTrace} from './execution-trace.ts';
import {publicDiagnosticTitle,webSource} from './case-descriptions.ts';
import {readPrivate,writePrivate} from './private-files.ts';
import {HarnessError,requireSafe,type ReasonCode} from './errors.ts';

export interface TraceArtifact {trace:ExecutionTrace;path:string;componentPath?:string}
/** Rebuild a bounded component diagnostic from allowlisted fields. Historical
 * raw titles/messages can never become an archive attachment. */
export function safeComponentDiagnostic(value:unknown) {
  const data=value as {version?:number;suite?:string;status?:number;runner?:string;failedAssertions?:Array<{
    index?:number;status?:string;title?:string;category?:string;line?:number}>};
  requireSafe([1,2].includes(data?.version??0)&&typeof data.suite==='string'&&
    /^src\/[A-Za-z0-9_./-]+\.test\.tsx?$/.test(data.suite)&&!data.suite.split('/').includes('..')&&
    Array.isArray(data.failedAssertions)&&data.failedAssertions.length<=100,'CONFIG');
  return {version:2,suite:data.suite,status:Number.isInteger(data.status)?data.status:null,
    ...(data.runner&&['timeout-or-process-error','nonzero-exit','assertion-failure'].includes(data.runner)?{runner:data.runner}:{}),
    failedAssertions:data.failedAssertions.map(item=>{
      requireSafe(Number.isInteger(item.index)&&item.index!>=0&&item.index!<100_000,'CONFIG');
      const title=typeof item.title==='string'?publicDiagnosticTitle(item.title,resolve(webSource,data.suite!),'component'):undefined;
      return {index:item.index,status:'failed',...(title?{title}:{}),
        ...(item.category&&['timeout','assertion','test-error'].includes(item.category)?{category:item.category}:{}),
        ...(Number.isInteger(item.line)&&item.line!>0&&item.line!<100_000?{line:item.line}:{} )};
    })};
}
export async function collectReportArtifacts(directory:string,runId:string,cases:Array<{executionId?:string;traceRunId?:string;reason?:ReasonCode}>) {
  const artifacts:TraceArtifact[]=[],seen=new Set<string>();
  for(const item of cases)if(item.executionId&&item.traceRunId) {
    const key=item.traceRunId+'/'+item.executionId;if(seen.has(key))continue;seen.add(key);
    requireSafe(seen.size<=5000,'CONFIG');
    const source=item.traceRunId===runId?directory:join(dirname(directory),item.traceRunId);
    const trace=await readExecutionTrace(source,item.traceRunId,item.executionId);
    const path=`report-artifacts/${trace.runId}/traces/${trace.executionId}.json`;
    await writePrivate(join(directory,path),trace);
    const componentFile=join(source,'component-failure.json');let componentPath:string|undefined;
    if(trace.outcome==='Failed'&&cases.some(row=>row.executionId===trace.executionId&&row.reason==='COMPONENT')&&
      await lstat(componentFile).catch(()=>undefined)) {
      const component=safeComponentDiagnostic(JSON.parse(await readPrivate(componentFile)));
      componentPath=`report-artifacts/${trace.runId}/component-failure.json`;
      await writePrivate(join(directory,componentPath),component);
    }
    artifacts.push({trace,path,...(componentPath?{componentPath}:{} )});
  }
  return artifacts;
}
/** Archive only sanitized report products, never the run directory, journals,
 * login snapshots, storage state, browser-temp, headers or raw upstream logs. */
export async function archiveReport(directory:string,runId:string,artifacts:TraceArtifact[],compress:boolean) {
  const files=['summary.json','summary.txt','summary.html','junit.xml',
    ...artifacts.flatMap(item=>[item.path,...(item.componentPath?[item.componentPath]:[])])];
  const members=[...new Set(files)];
  for(const file of members) {
    const stat=await lstat(join(directory,file));
    requireSafe(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'PRIVATE_FILE');
  }
  await writePrivate(join(directory,'report-artifacts.json'),{version:1,runId,files:members,
    traceFormat:'filtered-call-trace',rawPlaywrightTrace:false});
  if(!compress)return;
  // The members list is generated from fixed paths and validated run/execution
  // IDs. Nothing is swept recursively and no user-provided tar option is used.
  const list=join(directory,'.archive-members.txt');
  await writePrivate(list,[...members,'report-artifacts.json'].join('\n')+'\n');
  const archive=join(directory,'report-artifacts.tar.gz');
  const existing=await lstat(archive).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
  if(existing)requireSafe(existing.isFile()&&!existing.isSymbolicLink()&&(existing.mode&0o077)===0,'PRIVATE_FILE');
  else {
    const handle=await open(archive,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    await handle.close();
  }
  try {execFileSync('tar',['-czf',archive,'-C',directory,'-T',list],{stdio:'pipe',timeout:60_000,maxBuffer:64*1024});
  }catch{throw new HarnessError('PRIVATE_FILE');}
}
