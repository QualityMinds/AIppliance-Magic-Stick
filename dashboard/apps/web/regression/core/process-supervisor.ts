import {spawn,type SpawnOptions} from 'node:child_process';
import {executionBudget} from './execution-budget.ts';
import {inspectLinuxGroup,processBirth,type ProcessGroupState} from './process-group.ts';

/** Each leaf owns one Unix process group, not the parent/recovery process.
 * Keep the parent alive until all writers stop, including after a CLI exit. */
export function supervisedProcess(command:string,args:string[],options:SpawnOptions,
  budget:{timeoutMs?:number;hardTimeoutMs?:number;graceMs?:number;drainMs?:number}={}) {
  const grouped=process.platform!=='win32',child=spawn(command,args,{...options,detached:grouped});
  const started=process.platform==='linux'&&child.pid?processBirth(child.pid):undefined;
  const grace=budget.graceMs??executionBudget.childTerminationMs,drain=budget.drainMs??60_000;
  let forced=false,timedOut=false,interrupted=false,orphaned=false,closed=false,graceEnds=0,force:ReturnType<typeof setTimeout>|undefined;
  const inspect=():ProcessGroupState=>{
    if(!child.pid)return {state:'stopped',members:[]};
    try{process.kill(grouped?-child.pid:child.pid,0);}catch(error){
      return {state:(error as NodeJS.ErrnoException).code==='ESRCH'?'stopped':'unknown',members:[],...((error as NodeJS.ErrnoException).code==='ESRCH'?{}:{detail:'unreadable' as const})};
    }
    return process.platform==='linux'?inspectLinuxGroup(child.pid,started):{state:'live',members:[]};
  };
  const alive=()=>inspect().state!=='stopped';
  const signal=(value:NodeJS.Signals)=>{
    if(!child.pid)return;
    // Do not signal an unreadable or recycled process group. Keep its fence.
    if(process.platform==='linux'&&inspectLinuxGroup(child.pid,started).state==='unknown'){
      if(!closed)child.kill(value); // The unreaped direct child is still ours.
      return;
    }
    try{process.kill(grouped?-child.pid:child.pid,value);}catch{}
  };
  const stop=(value:NodeJS.Signals='SIGINT')=>{
    if(interrupted)return;
    interrupted=true;
    // Ask Playwright's coordinator to unwind first. Killing its workers at
    // this point would prevent the dedicated teardown fixture from running.
    if(!closed)child.kill(value);else signal(value);
    graceEnds=Date.now()+grace;
    force=setTimeout(()=>{forced=true;signal('SIGKILL');},grace);
  };
  const timer=budget.timeoutMs?setTimeout(()=>{timedOut=true;stop();},budget.timeoutMs):undefined;
  const hard=budget.hardTimeoutMs?setTimeout(()=>{timedOut=true;forced=true;signal('SIGKILL');},budget.hardTimeoutMs):undefined;
  const finished=new Promise<{exitCode:number;processesStopped:boolean;timedOut:boolean;interrupted:boolean;forced:boolean;orphaned:boolean;processState:ProcessGroupState}>(resolve=>{
    let done=false;
    const complete=async(code:number|null,exitSignal:NodeJS.Signals|null)=>{
      if(done)return;done=true;closed=true;
      // Permit normal child exit/reaping to settle before declaring an orphan.
      // A persistent writer still gets the full existing cleanup/kill budget.
      const settle=Date.now()+Math.min(drain,1000);
      while(!interrupted&&!forced&&alive()&&Date.now()<settle)await new Promise(r=>setTimeout(r,20));
      if(alive()) {
        if(!interrupted&&!forced){orphaned=true;stop();}
        // CLI exit does not mean its workers finished. In particular, a
        // cancelled coordinator may exit while teardown is still writing.
        while(alive()&&!forced&&Date.now()<graceEnds)await new Promise(r=>setTimeout(r,20));
        if(alive()&&!forced){forced=true;signal('SIGKILL');}
        const end=Date.now()+Math.min(drain,30_000);
        while(alive()&&Date.now()<end)await new Promise(r=>setTimeout(r,20));
      }
      clearTimeout(timer);clearTimeout(hard);clearTimeout(force);
      const processState=inspect();
      resolve({exitCode:timedOut||orphaned?1:exitSignal?2:code??1,processesStopped:processState.state==='stopped',timedOut,interrupted,forced,orphaned,processState});
    };
    child.once('error',()=>void complete(1,null));child.once('exit',(code,sig)=>void complete(code,sig));
  });
  return {child,stop,finished,identity:{pid:child.pid,started,platform:process.platform,grouped}};
}
