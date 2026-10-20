import {test,expect} from '@playwright/test';
import {createServer,type Server} from 'node:http';
import type {LabConfig} from '../core/config.ts';
import {completeOidcBrowserLogin,oidcBrowserStart} from '../core/oidc-exec.ts';
import {evidenceAnnotations} from '../core/evidence.ts';

const identity='https://identity.example.invalid',issuer=identity+'/realms/fixture',callback='http://localhost:18000/';
const oidc={server:'https://cluster.example.invalid',ca:Buffer.from('synthetic'),issuer,client:'fixture-kubernetes',issuerCa:'synthetic'};
const lab={identityUrl:identity,requestTimeoutMs:2000,loginTimeoutMs:5000} as LabConfig;
function authorization() {
  const url=new URL(issuer+'/protocol/openid-connect/auth');
  url.search=new URLSearchParams({client_id:oidc.client,response_type:'code',redirect_uri:callback,
    code_challenge_method:'S256',code_challenge:'a'.repeat(43),state:'synthetic-state'}).toString();return url;
}
const annotation=evidenceAnnotations({id:'HAR-10',layer:'B'},{id:'K8S-02',layer:'B'});

test('HAR-10 K8S-02 parses complete pinned-plugin instructions, never incidental or partial URLs',annotation,()=>{
  const instruction='Please visit the following URL in your browser: '+callback;
  expect(oidcBrowserStart(instruction)).toBeUndefined();
  expect(oidcBrowserStart(instruction+'\n')).toBe(callback);
  expect(oidcBrowserStart('Error from https://unrelated.example.invalid\n'+instruction+'\n')).toBe(callback);
  expect(oidcBrowserStart('https://unrelated.example.invalid\n')).toBeUndefined();
});

test('HAR-10 K8S-02 opens the real loopback redirect and completes the validated PKCE browser callback',annotation,async({browser})=>{
  const auth=authorization(),context=await browser.newContext();let server:Server|undefined,callbackCount=0;
  try {
    server=createServer((request,response)=>{
      const url=new URL(request.url!,callback);
      if(url.searchParams.has('code')) {callbackCount++;response.writeHead(200,{'Content-Type':'text/html'});response.end('<p>Authentication complete</p>');}
      else {response.writeHead(302,{Location:auth.href});response.end();}
    });
    await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(18000,'127.0.0.1',resolve);});
    await context.route(identity+'/**',route=>route.fulfill({status:302,headers:{Location:callback+'?code=synthetic-code&state=synthetic-state'}}));
    await completeOidcBrowserLogin(context,lab,oidc,callback);
    expect(callbackCount).toBe(1);
  }finally{await context.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));}
});

test('HAR-10 K8S-02 refuses a local redirect to another IdP, client, callback or weakened PKCE',annotation,async({browser})=>{
  const context=await browser.newContext();
  try {
    for(const fault of ['issuer','client','callback','pkce','challenge','state']) {
      const url=authorization();
      if(fault==='issuer')url.hostname='foreign.example.invalid';
      if(fault==='client')url.searchParams.set('client_id','another-client');
      if(fault==='callback')url.searchParams.set('redirect_uri','http://foreign.example.invalid:18000/');
      if(fault==='pkce')url.searchParams.set('code_challenge_method','plain');
      if(fault==='challenge')url.searchParams.set('code_challenge','short');
      if(fault==='state')url.searchParams.delete('state');
      let opened=false;
      const fake={request:{get:async()=>({status:()=>302,headers:()=>({location:url.href})})},
        newPage:async()=>{opened=true;throw new Error('Unsafe authorization must not open a page');}} as unknown as typeof context;
      await expect(completeOidcBrowserLogin(fake,lab,oidc,callback)).rejects.toThrow('[AUTH]');expect(opened).toBe(false);
    }
  }finally{await context.close();}
});

test('HAR-10 K8S-02 rejects a completed callback with the wrong state, including HTTP redirect chains',annotation,async({browser})=>{
  const auth=authorization(),context=await browser.newContext();let delivered=0;
  const server=createServer((_request,response)=>{delivered++;response.end('Callback must not be delivered');});
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(18000,'127.0.0.1',resolve);});
    await context.route(identity+'/**',route=>route.fulfill({status:302,headers:{Location:callback+'?code=synthetic-code&state=wrong-state'}}));
    await expect(completeOidcBrowserLogin(context,lab,oidc,auth.href)).rejects.toThrow('[AUTH]');
    // Redirected requests can bypass Playwright route handlers. The final URL
    // must still fail, even when the synthetic callback server answered 200.
    expect(delivered).toBe(1);
  }finally{await context.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
