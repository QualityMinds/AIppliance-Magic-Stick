import {join} from 'node:path';
import {writePrivate} from './private-files.ts';
import {HeartbeatLoop} from './run-lifecycle.ts';
import {requireSafe} from './errors.ts';
import {ResourceJournal,newRunId} from './journal.ts';
import {LabLease,type LeaseStore} from './lease.ts';

export interface RunnerSession {version:1;runId:string;targetUid:string;state:'running'|'finished';updatedAt:string;interrupted:boolean}
/** Parent-owned liveness receipt survives a killed Docker container. It is
 * separate from test evidence; completed never means the tests passed. */
export async function runnerSession(directory:string,runId:string,targetUid:string) {
  requireSafe(/^reg-[0-9a-f-]{36}$/.test(runId)&&targetUid.length>0,'OWNERSHIP');
  const filename=join(directory,'runner-session.json');
  const value:RunnerSession={version:1,runId,targetUid,state:'running',updatedAt:new Date().toISOString(),interrupted:false};
  await writePrivate(filename,value,true);
  const heartbeat=new HeartbeatLoop(async()=>{
    value.updatedAt=new Date().toISOString();await writePrivate(filename,value);
  },10_000).start();
  return {finish:async(interrupted=false)=>{await heartbeat.stop();value.state='finished';value.interrupted||=interrupted;
    value.updatedAt=new Date().toISOString();await writePrivate(filename,value);}};
}

/** Setup operations need the same durable run/owner relationship as live tests.
 * Existing model/module definitions are not adopted into this empty journal;
 * their reviewed setup receipts remain responsible for reconciliation. */
export async function recordedLeaseSession(store:LeaseStore,root:string,targetUid:string,durationSeconds=180) {
  const runId=newRunId(),directory=join(root,runId);
  const journal=await ResourceJournal.create(join(directory,'journal.json'),runId,targetUid);
  const session=await runnerSession(directory,runId,targetUid);
  const lease=new LabLease(store,runId,targetUid,Date.now,durationSeconds);
  try {await lease.acquire(runId);}catch(error){await session.finish(true);throw error;}
  const heartbeat=new HeartbeatLoop(()=>lease.backgroundHeartbeat()).start();
  let closing:Promise<void>|undefined;
  return {runId,directory,journal,session,lease,
    guard:async()=>{heartbeat.check();await lease.assertHeld();},
    close:()=>closing??=(async()=>{
      await heartbeat.stop();
      let interrupted=true;
      try {await lease.release();interrupted=false;}finally {await session.finish(interrupted);}
    })()};
}
