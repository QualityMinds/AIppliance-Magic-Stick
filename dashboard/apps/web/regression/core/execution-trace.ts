import {realpathSync} from 'node:fs';
import {relative,resolve,sep,join} from 'node:path';
import {publicDiagnosticTitle,publicScenarioTitle,webSource} from './case-descriptions.ts';
import {reasons,stages,type ReasonCode,type Stage,requireSafe} from './errors.ts';
import {readPrivate,writePrivate} from './private-files.ts';

export const traceCategories=['test.step','expect','pw:api','fixture','hook','test.attach','test.skip'] as const;
const operations=['click','fill','check','uncheck','selectOption','press','goto','reload','waitForResponse','waitForURL',
  'waitFor','fetch','get','post','put','delete','json','body','close','newPage','route','unroute','evaluate'] as const;
export type TraceOutcome='Passed'|'Failed'|'Blocked';
export interface TraceSource {file:string;line:number;column?:number}
export interface TraceStep {index:number;parentIndex?:number;category:typeof traceCategories[number];title:string;
  durationMs:number;outcome:TraceOutcome;handledError?:true;reason?:ReasonCode;stage?:Stage;source?:TraceSource}
export interface ExecutionTrace {version:1;runId:string;executionId:string;outcome:TraceOutcome;scenario?:string;
  durationMs:number;source?:TraceSource;steps:TraceStep[];omittedSteps?:number;recoveryRequired?:true}
export function safeTraceSource(location:{file:string;line:number;column?:number}|undefined):TraceSource|undefined {
  try {
    if(!location||!Number.isInteger(location.line)||location.line<1||location.line>100_000)return;
    const file=realpathSync(location.file),path=relative(webSource,file).split(sep).join('/');
    if(!file.startsWith(webSource+sep)||!/^regression\/[A-Za-z0-9_./-]+\.ts$/.test(path)||path.split('/').includes('..'))return;
    return {file:path,line:location.line,...(Number.isInteger(location.column)&&location.column!>0&&location.column!<100_000?{column:location.column}:{})};
  }catch{return;}
}
/** Never retain selectors, fill values, URLs, HTTP bodies or error text. */
export function safeStepTitle(title:string,category:TraceStep['category'],source?:TraceSource) {
  if(category==='test.step'&&source) {
    const approved=publicDiagnosticTitle(title,resolve(webSource,source.file),'step');
    if(approved)return approved;
  }
  const operation=/^(?:[A-Za-z]+\.)?([A-Za-z]+)(?:\(|$|\s)/.exec(title)?.[1];
  return category==='pw:api'&&operations.includes(operation as typeof operations[number])?`Browser/API ${operation}`:
    category==='expect'?'Assertion':category==='hook'?'Setup/teardown hook':category==='fixture'?'Fixture':
      category==='test.attach'?'Diagnostic attachment':category==='test.skip'?'Skipped prerequisite':'Test step';
}
export function parseExecutionTrace(value:unknown):ExecutionTrace {
  const trace=value as ExecutionTrace;
  requireSafe(trace?.version===1&&/^reg-[0-9a-f-]{36}$/.test(trace.runId)&&/^[a-f0-9]{24}$/.test(trace.executionId)&&
    ['Passed','Failed','Blocked'].includes(trace.outcome)&&Number.isFinite(trace.durationMs)&&trace.durationMs>=0&&
    Array.isArray(trace.steps)&&trace.steps.length<=2000&&
    (trace.omittedSteps===undefined||Number.isSafeInteger(trace.omittedSteps)&&trace.omittedSteps>0),'CONFIG');
  const source=trace.source?safeTraceSource({...trace.source,file:resolve(webSource,trace.source.file)}):undefined;
  const scenario=source&&typeof trace.scenario==='string'?publicScenarioTitle(trace.scenario,resolve(webSource,source.file)):undefined;
  const seen=new Set<number>();
  const steps=trace.steps.map(item=>{
    requireSafe(Number.isInteger(item.index)&&item.index>0&&!seen.has(item.index)&&traceCategories.includes(item.category)&&
      Number.isFinite(item.durationMs)&&item.durationMs>=0&&['Passed','Failed','Blocked'].includes(item.outcome)&&
      (item.parentIndex===undefined||Number.isInteger(item.parentIndex)&&seen.has(item.parentIndex)),'CONFIG');
    seen.add(item.index);
    const at=item.source?safeTraceSource({...item.source,file:resolve(webSource,item.source.file)}):undefined;
    const title=safeStepTitle(typeof item.title==='string'?item.title:'',item.category,at);
    // Already reduced browser labels are stable across aggregate imports.
    const reduced=/^Browser\/API ([A-Za-z]+)$/.exec(String(item.title));
    const approvedReduced=item.category==='pw:api'&&operations.includes(reduced?.[1] as typeof operations[number]);
    return {index:item.index,category:item.category,title:approvedReduced?item.title:title,outcome:item.outcome,
      durationMs:Math.round(item.durationMs),...(item.parentIndex!==undefined?{parentIndex:item.parentIndex}:{}),
      ...(item.handledError===true?{handledError:true as const}:{}),...(at?{source:at}:{}),
      ...(item.reason&&Object.hasOwn(reasons,item.reason)?{reason:item.reason}:{}),
      ...(item.stage&&stages.includes(item.stage)?{stage:item.stage}:{} )};
  });
  return {version:1,runId:trace.runId,executionId:trace.executionId,outcome:trace.outcome,durationMs:Math.round(trace.durationMs),steps,
    ...(trace.omittedSteps?{omittedSteps:trace.omittedSteps}:{}),...(source?{source}:{}),
    ...(scenario?{scenario}:{}),...(trace.recoveryRequired===true?{recoveryRequired:true as const}:{})};
}
export async function saveExecutionTrace(directory:string,trace:ExecutionTrace) {
  await writePrivate(join(directory,'traces',trace.executionId+'.json'),parseExecutionTrace(trace));
}
export async function readExecutionTrace(directory:string,runId:string,executionId:string) {
  requireSafe(/^reg-[0-9a-f-]{36}$/.test(runId)&&/^[a-f0-9]{24}$/.test(executionId),'CONFIG');
  const trace=parseExecutionTrace(JSON.parse(await readPrivate(join(directory,'traces',executionId+'.json'))));
  requireSafe(trace.runId===runId&&trace.executionId===executionId,'CONFIG');return trace;
}
