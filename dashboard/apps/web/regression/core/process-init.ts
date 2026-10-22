import {spawn} from 'node:child_process';

/** Kubernetes overrides the image ENTRYPOINT with `node kubernetes*.mjs`.
 * If that makes Node PID 1, put its real coordinator beneath the bundled
 * subreaper as well. No extra privileges or operator/image version coupling.
 * Forward to the coordinator, not its whole group: teardown needs its workers. */
export async function ensureProcessInit() {
  if(process.platform!=='linux'||process.pid!==1)return;
  const child=spawn('/usr/bin/tini',['-s','--',process.execPath,...process.argv.slice(1)],{stdio:'inherit',env:process.env});
  const signals=['SIGINT','SIGTERM'] as const;
  const forward=(signal:NodeJS.Signals)=>{child.kill(signal);};
  const handlers=signals.map(signal=>()=>forward(signal));
  signals.forEach((signal,index)=>process.on(signal,handlers[index]!));
  const code=await new Promise<number>(resolve=>{
    child.once('error',()=>resolve(1));
    child.once('exit',(code,signal)=>resolve(signal?128+(signal==='SIGINT'?2:15):code??1));
  });
  signals.forEach((signal,index)=>process.off(signal,handlers[index]!));
  process.exit(code);
}
