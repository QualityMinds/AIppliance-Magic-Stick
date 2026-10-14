import type {Page,Route,Response} from '@playwright/test';
import {canonical} from './borrowed-sharing.ts';
import {HarnessError,requireSafe,type Stage} from './errors.ts';
import {bounded} from './run-lifecycle.ts';

/** Only a guarded route that never forwarded the request can prove no write
 * was submitted. A network timeout after continue() is still ambiguous. */
export class MutationNotSubmitted extends HarnessError {
  readonly causeCode:'MUTATION'|'DEADLINE'|'LOCK_LOST';
  constructor(causeCode:'MUTATION'|'DEADLINE'|'LOCK_LOST',stage:Stage='model-update') {super(causeCode,'Failed',stage);this.causeCode=causeCode;}
}

export async function browserMutation(page:Page,options:{url:string;body:unknown;timeoutMs:number;guard:()=>Promise<void>;
  method?:'POST'|'PUT'|'PATCH'|'DELETE';stage?:Stage;acknowledge?:(response:Response)=>Promise<void>},
  action:()=>Promise<void>) {
  const method=options.method??'POST',stage=options.stage??'model-update';
  let forwarded=false,routeError:unknown,deny:(error:unknown)=>void=()=>{};
  const denied=new Promise<never>((_resolve,reject)=>{deny=reject;});
  const handler=async(route:Route)=>{
    try {
      requireSafe(!forwarded&&route.request().method()===method&&canonical(route.request().postDataJSON())===canonical(options.body),'MUTATION');
      await options.guard();forwarded=true;await route.continue();
    } catch(error) {routeError=error;deny(error);await route.abort('blockedbyclient').catch(()=>{});}
  };
  await page.route(options.url,handler);
  try {
    return await bounded(async():Promise<Response>=>{
      const receipt=page.waitForResponse(value=>value.url()===options.url&&value.request().method()===method,
        {timeout:options.timeoutMs}).then(async response=>{
        // An acknowledged write belongs in the durable journal even when the
        // click later fails (for example while the UI is rerendering). Do not
        // wait for action completion before retaining the validated receipt.
        requireSafe(response.ok(),'API');await options.acknowledge?.(response);return response;
      });
      const actionResult=action().catch(async error=>{
        // Once forwarded, preserve a possible receipt within the original
        // request deadline before closing the page. A lost response remains
        // ambiguous; this never infers ownership from a later generation.
        if(forwarded)await receipt.catch(()=>{});
        throw error;
      });
      const [response]=await Promise.race([Promise.all([receipt,actionResult]),denied]);
      await response.finished();requireSafe(response.ok(),'API');
      if(routeError)throw routeError;
      return response;
    },options.timeoutMs+1000,stage,()=>page.close());
  } catch(error) {
    // Closing the page settles outstanding route handlers before inspecting
    // unchanged state. Never treat a forwarded, lost response as rejection.
    await page.close().catch(()=>{});
    if(!forwarded)throw new MutationNotSubmitted(routeError instanceof HarnessError&&routeError.code==='LOCK_LOST'?'LOCK_LOST':
      routeError instanceof HarnessError&&routeError.code==='MUTATION'?'MUTATION':'DEADLINE',stage);
    if(error instanceof HarnessError)throw new HarnessError(error.code,error.outcome,error.stage??stage);
    throw new HarnessError('DEADLINE','Failed',stage);
  } finally {if(!page.isClosed())await page.unroute(options.url,handler);}
}
