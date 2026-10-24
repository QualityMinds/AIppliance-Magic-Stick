import {test, expect} from '@playwright/test';
import {createServer} from 'node:https';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {regressionContextOptions} from '../core/https-policy.ts';
import {probeModuleServices} from '../core/service-probes.ts';
import {verifiedEndpoint} from '../core/preflight.ts';
import {InferenceProbe} from '../core/inference.ts';
import {realtimeSession} from '../core/realtime-probe.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {HermesTerminalEvidence,observeHermesTerminal,verifyHermesTerminalChat} from '../core/hermes-terminal.ts';
import {OpenCodeChatEvidence,observeOpenCodeChat,verifyOpenCodeChat,openCodeChatPath} from '../core/opencode-chat.ts';
import type {Duplex} from 'node:stream';

/** Tiny native-protocol fixture, not another application or inference backend.
 * Actual Chromium keyboard, browser-created WSS feeds and clipboard are used. */
function terminalFixture(wrongCopy:()=>boolean) {
  let pty:Duplex|undefined,feed:Duplex|undefined,input='',answer='',bootstrapped=false;
  const send=(socket:Duplex,value:unknown)=>{
    const payload=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(payload.length<126?2:4);
    header[0]=0x81;header[1]=payload.length<126?payload.length:126;if(payload.length>=126)header.writeUInt16BE(payload.length,2);
    socket.write(Buffer.concat([header,payload]));
  };
  const event=(type:string,seq:number,payload?:unknown)=>{
    if(feed)send(feed,{jsonrpc:'2.0',method:'event',params:{type,seq,session_id:'fixture-root',payload}});
  };
  return (path:string,socket:Duplex)=>{
    if(path==='/api/events')feed=socket;else pty=socket;
    if(pty&&feed&&!bootstrapped){bootstrapped=true;event('session.info',1,{model:'reg-fixture-model',lazy:true});}
    let pending=Buffer.alloc(0);
    socket.on('data',(chunk:Buffer)=>{
      pending=Buffer.concat([pending,chunk]);
      while(pending.length>=2) {
        const opcode=pending[0]!&15,short=pending[1]!&127,header=short===126?4:2;
        if(short===127){socket.destroy();return;}if(pending.length<header)return;
        const length=short===126?pending.readUInt16BE(2):short;
        if(pending.length<header+4+length)return;
        const mask=pending.subarray(header,header+4),body=Buffer.from(pending.subarray(header+4,header+4+length));
        for(let index=0;index<body.length;index++)body[index]=body[index]!^mask[index%4]!;
        pending=pending.subarray(header+4+length);
        if(opcode===8){socket.end();return;}
        if(socket!==pty||opcode!==1)continue;
        input+=body.toString('utf8');if(!input.endsWith('\r'))continue;
        const prompt=/^Reply with exactly ([A-Za-z0-9_-]+)\r$/.exec(input);
        if(prompt){answer=prompt[1]!;event('session.info',2,{model:'reg-fixture-model',provider:'custom:litellm',version:'synthetic'});
          event('message.start',3);event('message.complete',4,{status:'complete',text:answer});}
        else if(input==='/copy\r')send(socket,{copy:wrongCopy()?'stale synthetic clipboard':answer});
        input='';
      }
    });
  };
}

test('HAR-01 HAR-10 functional browser, service, inference and Realtime checks exclude certificates; certificate checks remain strict',
  evidenceAnnotations({id: 'HAR-10', layer: 'B'}), async ({browser, playwright}) => {
    const directory = await mkdtemp(join(tmpdir(), 'regression-https-'));
    let server: ReturnType<typeof createServer> | undefined;
    const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
    const apis: Awaited<ReturnType<typeof playwright.request.newContext>>[] = [];
    const priorGlobalTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    let serviceStatus = 200, inferenceStatus = 200, sessionType = 'session.created',wrongCopy=false;
    let terminal=terminalFixture(()=>wrongCopy);
    let openCodeFault:'none'|'wrong-model'|'stale'='none',nativeMessages:unknown[]=[],nativeSubmissions=0;
    try {
      const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
        '-subj', '/CN=not-this-host.invalid', '-days', '1', '-addext', 'subjectAltName=DNS:not-this-host.invalid'], {stdio: 'pipe'});
      server = createServer({key: await readFile(key), cert: await readFile(cert)}, (request, response) => {
        const path=new URL(request.url??'/','https://fixture.invalid').pathname;
        if(path==='/session/ses_fixture/prompt_async'&&request.method==='POST') {
          nativeSubmissions++;let body='';request.on('data',chunk=>{body+=chunk;});
          request.on('end',()=>{
            const value=JSON.parse(body),text=String(value.parts[0].text).replace(/^Reply with exactly /,'');
            nativeMessages=[{info:{id:'msg_response',sessionID:'ses_fixture',parentID:openCodeFault==='stale'?'msg_old':value.messageID,
              role:'assistant',providerID:value.model.providerID,modelID:value.model.modelID,time:{created:1,completed:2},finish:'stop'},
              parts:[{type:'text',text,sessionID:'ses_fixture',messageID:'msg_response'}]}];
            response.writeHead(204);response.end();
          });
        }else if(path==='/session/ses_fixture/message') {
          response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(nativeMessages));
        }else if(path===openCodeChatPath) {
          response.writeHead(200,{'Content-Type':'text/html'});
          response.end(`<!doctype html><div data-component="prompt-input" contenteditable="true" role="textbox"></div>
            <button data-action="prompt-submit">Send message</button><div data-slot="session-turn-assistant-content" aria-hidden="false"></div><script>
            document.querySelector('button').onclick=async()=>{try{
              const parts=[{type:'text',text:document.querySelector('[contenteditable]').innerText}];
              const result=await fetch('/session/ses_fixture/prompt_async',{method:'POST',
                headers:{'Content-Type':'application/json','x-opencode-directory':'%2Fworkspace'},body:JSON.stringify({messageID:'msg_prompt',
                  model:{providerID:'litellm',modelID:${openCodeFault==='wrong-model'?'"foreign-model"':'"reg-fixture-model"'}},parts})});
              if(!result.ok)return;const messages=await(await fetch('/session/ses_fixture/message?directory=%2Fworkspace')).json();
              document.querySelector('[data-slot]').textContent=messages[0].parts[0].text;
            }catch{}};</script>`);
        }else if(request.url==='/chat') {
          response.writeHead(200,{'Content-Type':'text/html'});
          response.end(`<!doctype html><div class="hermes-chat-xterm-host"><textarea class="xterm-helper-textarea"></textarea></div>
            <button aria-label="Copy last assistant response">Copy</button><script>
            const root='wss://'+location.host,feed=new WebSocket(root+'/api/events?channel=fixture&ticket=synthetic'),
              pty=new WebSocket(root+'/api/pty?channel=fixture&token=synthetic');
            document.querySelector('textarea').addEventListener('keydown',e=>{
              if(e.key==='Enter'){e.preventDefault();pty.send('\\r');}else if(e.key.length===1)pty.send(e.key);
            });
            document.querySelector('button').onclick=()=>{pty.send('/copy');setTimeout(()=>pty.send('\\r'),100);};
            pty.onmessage=e=>{const result=JSON.parse(e.data);if(result.copy)void navigator.clipboard.writeText(result.copy);};
            </script>`);
        }else if (request.url === '/v1/chat/completions' || request.url === '/v1/models') {
          response.writeHead(inferenceStatus, {'Content-Type': 'application/json'});
          response.end(JSON.stringify(request.url === '/v1/models' ? {data: [{id: 'fixture'}]} :
            {model: 'fixture', choices: [{message: {content: 'OK'}}]}));
        } else {
          response.writeHead(serviceStatus, {'Content-Type': 'text/html',
            ...(serviceStatus === 302 ? {Location: 'https://unreachable.example.invalid/'} : {})});
          response.end('<h1>Synthetic functional service</h1>');
        }
      });
      server.on('upgrade', (request, socket) => {
        const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        const path=new URL(request.url!,'https://fixture.invalid').pathname;
        if(['/api/pty','/api/events'].includes(path)){terminal(path,socket);return;}
        const payload = Buffer.from(JSON.stringify({type: sessionType, session: {id: 'synthetic'}}));
        socket.end(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const origin = 'https://127.0.0.1:' + (server.address() as {port: number}).port;

      await expect(verifiedEndpoint(origin, 2000)).rejects.toMatchObject({code: 'TLS'});
      await expect(verifiedEndpoint(origin, 2000, await readFile(cert, 'utf8'))).rejects.toMatchObject({code: 'TLS'});
      const strict = await browser.newContext(regressionContextOptions('certificate')); contexts.push(strict);
      await expect((await strict.newPage()).goto(origin)).rejects.toThrow();
      const api = await playwright.request.newContext(); apis.push(api);
      await expect(api.get(origin)).rejects.toThrow();

      const functional = await browser.newContext(regressionContextOptions()); contexts.push(functional);
      const page = await functional.newPage();
      await page.goto(origin);
      await expect(page.getByRole('heading', {name: 'Synthetic functional service'})).toBeVisible();
      expect((await functional.request.get(origin)).status()).toBe(200);
      const links = [{url: origin, label: 'Synthetic service', scope: 'direct' as const}];
      await probeModuleServices(api, links, 2000); // Per-request purpose, even on a strict API context.
      serviceStatus = 302;
      await probeModuleServices(api, links, 2000); // Do not follow the unreachable redirect.
      serviceStatus = 503;
      await expect(probeModuleServices(api, links, 2000)).rejects.toMatchObject({code: 'API', outcome: 'Failed'});
      const inference = new InferenceProbe(api, origin, 'sk-synthetic-fixture', 2000);
      expect(await inference.advertised('fixture')).toBe(true);
      await inference.chat('fixture');
      inferenceStatus = 500;
      await expect(inference.chat('fixture')).rejects.toMatchObject({code: 'API', outcome: 'Failed'});
      await realtimeSession(origin, 'fixture', 'sk-synthetic-fixture', false, 2000);
      sessionType = 'error';
      await expect(realtimeSession(origin, 'fixture', 'sk-synthetic-fixture', false, 2000)).rejects.toMatchObject({code: 'API', outcome: 'Failed'});
      // No policy leaks into the explicit TLS check or process environment.
      await expect(verifiedEndpoint(origin, 2000)).rejects.toMatchObject({code: 'TLS'});
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(priorGlobalTls);
      for(wrongCopy of [false,true]) {
        terminal=terminalFixture(()=>wrongCopy);
        const chat=await functional.newPage(),proof=new HermesTerminalEvidence(origin,'reg-fixture-model');
        observeHermesTerminal(chat,proof);
        try {
          await chat.goto(origin+'/chat');
          const result=verifyHermesTerminalChat(chat,proof,async()=>{},'REGRESSION',{readyMs:3000,inferenceMs:3000,copyMs:750});
          if(wrongCopy)await expect(result).rejects.toMatchObject({code:'DEADLINE',outcome:'Failed',stage:'model-inference'});
          else {await result;expect(proof.snapshot()).toMatchObject({submitted:true,started:true,completed:true,copied:true,failed:false});}
          expect(await chat.evaluate(()=>navigator.clipboard.readText().then(value=>value===''))).toBe(true);
        }finally{await chat.close();}
      }
      for(openCodeFault of ['none','wrong-model','stale'] as const) {
        nativeMessages=[];nativeSubmissions=0;
        const chat=await functional.newPage(),proof=new OpenCodeChatEvidence(origin,'reg-fixture-model');
        await observeOpenCodeChat(chat,proof,async()=>{});
        try {
          await chat.goto(origin+openCodeChatPath);
          const result=verifyOpenCodeChat(chat,proof,async()=>{},'REGRESSION',{readyMs:3000,requestMs:1000,inferenceMs:750});
          if(openCodeFault==='wrong-model') {
            await expect(result).rejects.toMatchObject({code:'MUTATION',outcome:'Failed',stage:'model-inference'});
            expect(nativeSubmissions).toBe(0);
          }else if(openCodeFault==='stale')await expect(result).rejects.toMatchObject({code:'DEADLINE',outcome:'Failed',stage:'model-inference'});
          else {await result;expect(proof.snapshot()).toMatchObject({submitted:true,acknowledged:true,completed:true,rendered:true,failed:false});}
        }finally{await chat.close();}
      }
    } finally {
      for (const api of apis) await api.dispose();
      for (const context of contexts) await context.close();
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      await rm(directory, {recursive: true, force: true});
    }
  });
