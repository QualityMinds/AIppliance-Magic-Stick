import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {browserMutation} from '../core/browser-action.ts';
import {HarnessError} from '../core/errors.ts';

test('HAR-09 bounded real-browser actions distinguish an unsent request, rejected guard and lost forwarded response',async({browser})=>{
  for(const fault of ['none','no-request','body','lease','response'] as const) {
    let writes=0;
    const server=createServer((request,response)=>{
      if(request.url==='/') {response.end('<button id="enable">Enable</button>');return;}
      if(request.method!=='POST'){response.statusCode=204;response.end();return;}
      writes++;
      if(fault==='response')return; // Page cancellation must close this request.
      response.setHeader('Content-Type','application/json');response.end('{}');
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address() as {port:number},origin='http://127.0.0.1:'+address.port;
    const page=await browser.newPage();
    try {
      await page.goto(origin);
      const body=fault==='body'?{unexpected:true}:{};
      await page.evaluate(({origin,body,fault})=>{
        document.querySelector('button')!.addEventListener('click',()=>{
          if(fault!=='no-request')void fetch(origin+'/api/modules/fixture/enable',{method:'POST',body:JSON.stringify(body)}).catch(()=>{});
        });
      },{origin,body,fault});
      const action=browserMutation(page,{url:origin+'/api/modules/fixture/enable',body:{},timeoutMs:250,
        guard:async()=>{if(fault==='lease')throw new HarnessError('LOCK_LOST');}},
      ()=>page.getByRole('button',{name:'Enable',exact:true}).click({timeout:250}));
      if(fault==='none') {await action;expect(writes).toBe(1);expect(page.isClosed()).toBe(false);}
      else {
        await expect(action).rejects.toMatchObject({outcome:'Failed'});expect(page.isClosed()).toBe(true);
        expect(writes).toBe(fault==='response'?1:0);
      }
    } finally {await page.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }
});
