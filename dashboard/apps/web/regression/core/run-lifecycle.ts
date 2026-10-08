import {HarnessError, type Stage} from './errors.ts';

/** One serialized heartbeat, independent of browser/polling progress. Failure
 * is sticky: a later successful read must not revive a fenced runner. */
export class HeartbeatLoop {
  private timer?:ReturnType<typeof setTimeout>;
  private pending?:Promise<void>;
  private failure?:unknown;
  private stopped=false;
  private readonly renew:()=>Promise<void>;
  private readonly intervalMs:number;
  constructor(renew:()=>Promise<void>,intervalMs=15_000) {this.renew=renew;this.intervalMs=intervalMs;}
  start() {if(!this.timer&&!this.stopped)this.schedule();return this;}
  private schedule() {
    this.timer=setTimeout(()=>{this.timer=undefined;void this.tick().catch(()=>{}).finally(()=>{
      if(!this.stopped&&!this.failure)this.schedule();
    });},this.intervalMs);
    this.timer.unref?.();
  }
  async tick() {
    this.check();
    if(!this.pending)this.pending=this.renew().catch(error=>{this.failure=error;throw error;}).finally(()=>{this.pending=undefined;});
    return this.pending;
  }
  check() {if(this.failure)throw new HarnessError('LOCK_LOST');}
  async stop() {this.stopped=true;clearTimeout(this.timer);this.timer=undefined;await this.pending?.catch(()=>{});}
}

/** The caller cancels the underlying operation on deadline; racing a timer
 * alone would leave a delayed write running behind cleanup. */
export async function bounded<T>(action:()=>Promise<T>,timeoutMs:number,stage:Stage,
  cancel:()=>Promise<void>):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  let expired:HarnessError|undefined,cancellation:Promise<void>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
    expired=new HarnessError('DEADLINE','Failed',stage);
    // Closing a broken page/context must not create a second unbounded wait.
    let cancellationTimer:ReturnType<typeof setTimeout>|undefined;
    cancellation=Promise.race([Promise.resolve().then(cancel).catch(()=>{}),new Promise<void>(resolve=>{
      cancellationTimer=setTimeout(resolve,1000);
    })]).finally(()=>clearTimeout(cancellationTimer));
    void cancellation.then(()=>reject(expired));
  },timeoutMs);});
  try {const value=await Promise.race([action(),deadline]);if(expired)throw expired;return value;}
  finally {clearTimeout(timer);await cancellation;}
}
