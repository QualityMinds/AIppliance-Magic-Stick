import {createHash} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {readPrivate,writePrivate} from './private-files.ts';
import {blockerFrom,checkedBlocker} from './blocking.ts';
import {HarnessError,requireSafe} from './errors.ts';

type Info={testId:string;annotations:Array<{type:string;description?:string}>};
type Scope={runId:string;targetUid:string};
export const executionIdentity=(runId:string,testId:string)=>createHash('sha256').update(runId).update(testId).digest('hex').slice(0,24);

/** A Playwright failure restarts the worker. Retain only the original failure
 * within this exact child run, not passing results from an earlier campaign.
 * Dependent cases must not repeat a 15-minute failed shared setup nine times. */
export class SharedWorkflow {
  private running=new Map<string,Promise<Set<string>>>();
  constructor(private directory:string,private scope:Scope) {
    requireSafe(/^reg-[a-f0-9-]{36}$/.test(scope.runId) && scope.targetUid.length>0,'CONFIG');
  }
  async execute(name:'applications'|'modules',id:string,info:Info,action:()=>Promise<Set<string>>) {
    const filename=join(this.directory,`workflow-${name}-failure.json`);
    try {
      await lstat(filename);
      const saved=JSON.parse(await readPrivate(filename)),cause=checkedBlocker(saved.cause);
      requireSafe(saved.version===1 && saved.runId===this.scope.runId && saved.targetUid===this.scope.targetUid && saved.workflow===name &&
        Object.keys(saved).sort().join(',')==='cause,runId,targetUid,version,workflow' && cause?.caseId && cause.executionId &&
        cause.traceRunId===this.scope.runId && JSON.stringify(cause)===JSON.stringify(saved.cause),'CONFIG');
      info.annotations.push({type:'regression-dependency',description:JSON.stringify(cause)});
      throw new HarnessError('DEPENDENCY','Blocked',cause.stage as import('./errors.ts').Stage|undefined);
    } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    let running=this.running.get(name);
    if(!running) {
      running=(async()=>{
        try{return await action();}
        catch(error) {
          const reason=error instanceof HarnessError?error.code:'UNEXPECTED',outcome=error instanceof HarnessError?error.outcome:'Failed';
          const cause=blockerFrom({id,reason,outcome,stage:error instanceof HarnessError?error.stage:undefined,
            executionId:executionIdentity(this.scope.runId,info.testId),traceRunId:this.scope.runId});
          await writePrivate(filename,{version:1,...this.scope,workflow:name,cause},true);
          throw error;
        }
      })();
      this.running.set(name,running);
    }
    requireSafe((await running).has(id),'CONFIG');
  }
}
