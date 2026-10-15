import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {browserMutation} from '../core/browser-action.ts';
import {HarnessError} from '../core/errors.ts';
import {modelActionButton,modelLifecycleReceipt} from '../core/model-ui.ts';
import {ResourceJournal,newRunId} from '../core/journal.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ModelActivation} from '@magicstick/dashboard-contracts';
import {OwnedAppClient,type AppCleaner} from '../core/owned-app.ts';
import type {LiveFoundation} from '../core/live-foundation.ts';

test('APP-02 HAR-07 app creation journals only forwarded requests and preserves acknowledged identity despite a failed UI action',async({browser})=>{
  const directory=await mkdtemp(join(tmpdir(),'app-creation-receipt-'));
  try {for(const fault of ['unsent','guard','rejected','lost','acknowledged'] as const) {
    const journal=await ResourceJournal.create(join(directory,fault+'.json'),newRunId(),'appliance');
    const requestedName=journal.prefix+'app',name='openclaw-'+requestedName,model=journal.prefix+'model';
    let writes=0,received:()=>void=()=>{},stored:unknown;
    const submitted=new Promise<void>(resolve=>{received=resolve;});
    const server=createServer((request,response)=>{
      if(request.url==='/'){response.end('<button>Create</button>');return;}
      response.setHeader('Content-Type','application/json');
      if(request.url==='/api/instances'){response.end(JSON.stringify({instances:{}}));return;}
      writes++;received();
      if(fault==='rejected'){response.statusCode=422;response.end('{}');return;}
      stored={metadata:{name,namespace:'ai-system',uid:'created-app-uid',generation:1}};
      if(fault==='lost')return;
      setTimeout(()=>response.end(JSON.stringify(stored)),100);
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,page=await browser.newPage();
    const live={journal,config:{dashboardUrl:origin,requestTimeoutMs:1000},guard:async()=>{},context:page.context(),
      registerDomainCleanup:()=>{}} as unknown as LiveFoundation;
    const client=new OwnedAppClient(live,{find:async()=>stored} as unknown as AppCleaner);
    try {
      await page.goto(origin);
      await expect(client.submitCreate(page,'openclaw',requestedName,model,false,async()=>{
        if(fault==='unsent')throw new HarnessError('DEADLINE','Failed','model-create');
        await page.evaluate(body=>{void fetch('/api/instances/openclaw',{method:'POST',body:JSON.stringify(body)}).catch(()=>{});},
          {name:requestedName,model:fault==='guard'?'foreign-model':model,namespace:'ai',enabled:true,access:{authentication:'sso',exposure:'local'}});
        if(fault==='acknowledged'){await submitted;throw new HarnessError('DEADLINE','Failed','model-create');}
      })).rejects.toThrow();
      expect(writes).toBe(['unsent','guard'].includes(fault)?0:1);
      const entries=(await ResourceJournal.resume(journal.filename,'appliance')).entries;
      if(['unsent','guard'].includes(fault))expect(entries).toEqual([]);
      else expect(entries).toEqual([expect.objectContaining(fault==='acknowledged'?{uid:'created-app-uid',generation:1,state:'owned'}:
        {uid:null,state:fault==='lost'?'requested':'removed'})]);
    }finally{await page.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }}finally{await rm(directory,{recursive:true,force:true});}
});

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
      const timeoutMs=fault==='none'?2000:250;
      const action=browserMutation(page,{url:origin+'/api/modules/fixture/enable',body:{},timeoutMs,
        guard:async()=>{if(fault==='lease')throw new HarnessError('LOCK_LOST');}},
      ()=>page.getByRole('button',{name:'Enable',exact:true}).click({timeout:timeoutMs}));
      if(fault==='none') {await action;expect(writes).toBe(1);expect(page.isClosed()).toBe(false);}
      else {
        await expect(action).rejects.toMatchObject({outcome:'Failed'});expect(page.isClosed()).toBe(true);
        expect(writes).toBe(fault==='response'?1:0);
      }
    } finally {await page.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }
});

test('HAR-06 HAR-09 LIFE-04 waits for the polled Start button before submitting the exact mutation',async({browser})=>{
  const page=await browser.newPage();
  try {
    await page.setContent('<button disabled>Start reg-fixture</button>');
    await page.evaluate(()=>setTimeout(()=>{document.querySelector('button')!.disabled=false;},500));
    const started=Date.now(),button=await modelActionButton(page,'reg-fixture','start',2000);
    expect(Date.now()-started).toBeGreaterThanOrEqual(400);await expect(button).toBeEnabled();
    await page.setContent('<button disabled>Start reg-fixture</button>');
    await expect(modelActionButton(page,'reg-fixture','start',100)).rejects.toMatchObject({code:'DEADLINE',stage:'model-ready',outcome:'Failed'});
  }finally{await page.close();}
});

test('HAR-06 HAR-07 HAR-09 an acknowledged write is journaled even if its browser action fails',async({browser})=>{
  const directory=await mkdtemp(join(tmpdir(),'magicstick-browser-receipt-')),runId=newRunId();
  const journal=await ResourceJournal.create(join(directory,'journal.json'),runId,'appliance'),name=journal.prefix+'model';
  const before:ModelActivation={metadata:{name,namespace:'ai-system',uid:'owned-uid',generation:2},
    spec:{enabled:false,targetNamespace:'ai',local:{engine:'OLlama',computeTarget:'cpu',url:'ollama://fixture'}}};
  const after=structuredClone(before);after.spec!.enabled=true;after.metadata!.generation=3;
  await journal.requested('model',name);await journal.owned('model',name,'owned-uid',2);
  let writes=0,accepted:()=>void=()=>{};const submitted=new Promise<void>(resolve=>{accepted=resolve;});
  const server=createServer((request,response)=>{
    if(request.method!=='POST'){response.end('<button>Start</button>');return;}
    writes++;accepted();setTimeout(()=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({activation:after}));},100);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,page=await browser.newPage();
  try {
    await page.goto(origin);
    await expect(browserMutation(page,{url:origin+'/api/models/'+name+'/start',body:{expectedRevision:'generation:owned-uid:2'},timeoutMs:2000,
      guard:async()=>{},acknowledge:async response=>{
        const receipt=modelLifecycleReceipt(before,await response.json(),'start');
        await journal.modelGeneration(name,receipt.uid,2,receipt.generation);
      }},async()=>{
        await page.evaluate(name=>{void fetch('/api/models/'+name+'/start',{method:'POST',body:JSON.stringify({expectedRevision:'generation:owned-uid:2'})});},name);
        // Represents a click/navigation failure after the guarded route has
        // forwarded the write. The operation remains Failed, not retried.
        await submitted;
        throw new HarnessError('DEADLINE','Failed','model-ready');
      })).rejects.toMatchObject({outcome:'Failed'});
    const resumed=await ResourceJournal.resume(join(directory,'journal.json'),'appliance');
    expect(writes).toBe(1);expect(resumed.entries[0]).toMatchObject({uid:'owned-uid',generation:3,state:'owned'});
  }finally{await page.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
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
