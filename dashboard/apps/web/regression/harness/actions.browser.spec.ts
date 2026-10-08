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

test('HAR-09 model estimates and edits use exact methods payloads and operation stages without waiting out a rejected guard',async({browser})=>{
  let writes=0;
  const server=createServer((request,response)=>{
    if(request.url==='/'){response.end('<button>Apply</button>');return;}
    if(!['POST','PUT','PATCH'].includes(request.method??'')){response.statusCode=204;response.end();return;}
    writes++;response.setHeader('Content-Type','application/json');response.end('{"ok":true}');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  try {
    for(const method of ['POST','PUT'] as const) {
      const page=await browser.newPage();
      try {
        await page.goto(origin);
        await page.evaluate(method=>document.querySelector('button')!.addEventListener('click',()=>{
          void fetch('/api/models/fixture',{method,body:JSON.stringify({memory:64})}).catch(()=>{});
        }),method);
        const response=await browserMutation(page,{url:origin+'/api/models/fixture',method,body:{memory:64},
          timeoutMs:5000,stage:method==='POST'?'model-estimate':'model-update',guard:async()=>{}},
        ()=>page.getByRole('button',{name:'Apply',exact:true}).click());
        expect(await response.json()).toEqual({ok:true});expect(page.isClosed()).toBe(false);
      }finally{await page.close();}
    }
    const page=await browser.newPage();await page.goto(origin);
    await page.evaluate(()=>document.querySelector('button')!.addEventListener('click',()=>{
      void fetch('/api/models/fixture',{method:'PUT',body:JSON.stringify({memory:64})}).catch(()=>{});
    }));
    const started=Date.now();
    await expect(browserMutation(page,{url:origin+'/api/models/fixture',method:'PUT',body:{memory:64},timeoutMs:5000,
      stage:'model-create',guard:async()=>{throw new HarnessError('LOCK_LOST');}},()=>page.getByRole('button',{name:'Apply',exact:true}).click()))
      .rejects.toMatchObject({code:'LOCK_LOST',stage:'model-create',outcome:'Failed'});
    expect(Date.now()-started).toBeLessThan(3000);expect(writes).toBe(2);expect(page.isClosed()).toBe(true);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
