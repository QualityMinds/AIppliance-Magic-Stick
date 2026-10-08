import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {staticDiagnosticTitles,webSource} from './case-descriptions.ts';

interface Assertion {title?:string;fullName?:string;status:string;failureMessages?:string[];location?:{line?:number;column?:number}}
interface ComponentResult {success?:boolean;testResults?:Array<{assertionResults?:Assertion[]}>}
export function componentDiagnostic(file:string,result:ComponentResult,process:{status:number|null;error?:unknown}) {
  const safeFile=/^src\/[A-Za-z0-9_./-]+\.test\.tsx?$/.test(file)&&!file.split('/').includes('..')?file:undefined;
  let titles:ReadonlySet<string>=new Set();
  if(safeFile)try{titles=staticDiagnosticTitles(readFileSync(resolve(webSource,safeFile),'utf8'),'component');}catch{/* A missing source cannot authorize a dynamic title. */}
  const assertions=(result.testResults??[]).flatMap(item=>item.assertionResults??[]);
  return {version:2,suite:safeFile??'unknown-component-suite',status:process.status,
    runner:process.error?'timeout-or-process-error':process.status!==0?'nonzero-exit':'assertion-failure',
    failedAssertions:assertions.map((item,index)=>({item,index})).filter(({item})=>item.status!=='passed').slice(0,100).map(({item,index})=>{
      const title=typeof item.title==='string'&&titles.has(item.title)?item.title:
        [...titles].find(value=>item.fullName===value||item.fullName?.endsWith(' '+value));
      const messages=(item.failureMessages??[]).filter(value=>typeof value==='string');
      const category=messages.some(value=>/timed? ?out|timeout/i.test(value))?'timeout':
        messages.some(value=>/AssertionError|expect\(|expected .* to /i.test(value))?'assertion':'test-error';
      const line=Number.isSafeInteger(item.location?.line)&&item.location!.line!>0&&item.location!.line!<100_000?item.location!.line:undefined;
      return {index,status:'failed',category,...(title?{title}:{}),...(line?{line}:{} )};
    })};
}
