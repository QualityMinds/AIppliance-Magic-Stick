import type {Page,Route} from '@playwright/test';
import {canonical} from './borrowed-sharing.ts';
import {HarnessError,requireSafe} from './errors.ts';
import {bounded} from './run-lifecycle.ts';

/** Only a guarded route that never forwarded the request can prove no write
 * was submitted. A network timeout after continue() is still ambiguous. */
export class MutationNotSubmitted extends HarnessError {
  readonly causeCode:'MUTATION'|'DEADLINE'|'LOCK_LOST';
  constructor(causeCode:'MUTATION'|'DEADLINE'|'LOCK_LOST') {super(causeCode,'Failed','model-update');this.causeCode=causeCode;}
}

export async function browserMutation(page:Page,options:{url:string;body:unknown;timeoutMs:number;guard:()=>Promise<void>},
  action:()=>Promise<void>) {
  let forwarded=false,routeError:unknown;
  const handler=async(route:Route)=>{
    try {
      requireSafe(!forwarded&&route.request().method()==='POST'&&canonical(route.request().postDataJSON())===canonical(options.body),'MUTATION');
      await options.guard();forwarded=true;await route.continue();
    } catch(error) {routeError=error;await route.abort('blockedbyclient').catch(()=>{});}
  };
  await page.route(options.url,handler);
  try {
    await bounded(async()=>{
      const [response]=await Promise.all([page.waitForResponse(value=>value.url()===options.url&&value.request().method()==='POST',
        {timeout:options.timeoutMs}),action()]);
      await response.finished();requireSafe(response.ok(),'API');
      if(routeError)throw routeError;
    },options.timeoutMs+1000,'model-update',()=>page.close());
  } catch(error) {
    // Closing the page settles outstanding route handlers before inspecting
    // unchanged state. Never treat a forwarded, lost response as rejection.
    await page.close().catch(()=>{});
    if(!forwarded)throw new MutationNotSubmitted(routeError instanceof HarnessError&&routeError.code==='LOCK_LOST'?'LOCK_LOST':
      routeError instanceof HarnessError&&routeError.code==='MUTATION'?'MUTATION':'DEADLINE');
    if(error instanceof HarnessError)throw error;
    throw new HarnessError('DEADLINE','Failed','model-update');
  } finally {if(!page.isClosed())await page.unroute(options.url,handler);}
}
