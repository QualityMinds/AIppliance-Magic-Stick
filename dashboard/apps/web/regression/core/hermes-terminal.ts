import {randomBytes} from 'node:crypto';
import type {Page,WebSocket} from '@playwright/test';
import {HarnessError,requireProof,atStage} from './errors.ts';
import {poll} from './poll.ts';
import {withCleanup} from './run-lifecycle.ts';

type Stream={kind:'pty'|'events';channel:string;closed:boolean};

/** Observe the browser's own PTY and its notification-only events feed. The
 * independent /api/ws sidecar, configuration badges and prompt echoes are not
 * inference evidence. Never retain WS URLs, tokens or arbitrary event payloads.
 * Contract: the pinned Hermes v2026.9.24 ChatPage/EventsFeedClient and gateway. */
export class HermesTerminalEvidence {
  private pty?:Stream;
  private feed?:Stream;
  private session?:string;
  private sequence=-1;
  private bootstrap=false;
  private agent=false;
  private prompt?:string;
  private marker?:string;
  private input='';
  private submitted=false;
  private started=false;
  private answer?:string;
  private copied=false;
  private failure?:HarnessError;
  readonly origin:string;
  readonly model:string;
  constructor(origin:string,model:string) {
    requireProof(new URL(origin).origin===origin&&new URL(origin).protocol==='https:'&&model.length>0&&model.length<256,'CONFIG');
    this.origin=origin;this.model=model;
  }
  private fail() {this.failure??=new HarnessError('API','Failed',this.prompt?'model-inference':'app-ready');}
  private check() {if(this.failure)throw this.failure;}
  open(address:string):Stream|undefined {
    let url:URL;try{url=new URL(address);}catch{return;}
    if(url.protocol!=='wss:'||url.host!==new URL(this.origin).host||!['/api/pty','/api/events'].includes(url.pathname))return;
    const channel=url.searchParams.get('channel');
    if(!channel||channel.length>256||/[^\x21-\x7e]/.test(channel)){this.fail();return;}
    const stream:Stream={kind:url.pathname==='/api/pty'?'pty':'events',channel,closed:false};
    if(stream.kind==='pty') {
      if(this.prompt)this.fail();
      this.pty=stream;this.session=undefined;this.sequence=-1;this.bootstrap=false;this.agent=false;
    }else this.feed=stream;
    return stream;
  }
  close(stream:Stream) {
    stream.closed=true;
    if(stream===this.pty||stream===this.feed) {
      if(this.prompt)this.fail();else this.bootstrap=false;
    }
  }
  sent(stream:Stream,payload:string|Buffer) {
    if(stream!==this.pty||stream.closed||!this.prompt||this.submitted)return;
    const text=typeof payload==='string'?payload:payload.toString('utf8');
    if(text.length>this.prompt.length+1||this.input.length+text.length>this.prompt.length+1){this.fail();return;}
    this.input+=text;
    this.submitted=this.input===this.prompt+'\r'||this.input===this.prompt+'\n';
  }
  received(stream:Stream,payload:string|Buffer) {
    if(stream!==this.feed||stream.closed||!this.pty||this.pty.closed||stream.channel!==this.pty.channel)return;
    if(Buffer.byteLength(payload)>1024*1024){this.fail();return;}
    let frame:any;try{frame=JSON.parse(payload.toString());}catch{this.fail();return;}
    if(frame?.jsonrpc!=='2.0'||frame.id!==undefined||frame.method!=='event')return;
    const event=frame.params;
    if(!event||!['session.info','message.start','message.complete','error'].includes(event.type)||event.replayed===true)return;
    if(typeof event.session_id!=='string'||!event.session_id||event.session_id.length>256||
      !Number.isSafeInteger(event.seq)||event.seq<0){this.fail();return;}
    if(this.session&&event.session_id!==this.session)return;
    if(event.seq<=this.sequence)return;
    if(event.type==='session.info') {
      const info=event.payload;
      if(info?.model!==this.model||info.provider!==undefined&&info.provider!=='custom:litellm'||info.credential_warning){this.fail();return;}
      this.session=event.session_id;this.sequence=event.seq;
      // Lazy creation intentionally defers agent construction until the first
      // real prompt. It is enough to type, but never enough to credit a reply.
      this.bootstrap=info.lazy===true||typeof info.version==='string'&&info.version.length>0;
      this.agent=info.lazy!==true&&typeof info.version==='string'&&info.version.length>0&&info.provider==='custom:litellm';
      return;
    }
    if(!this.session)return;
    this.sequence=event.seq;
    if(event.type==='error'){this.fail();return;}
    if(!this.prompt||!this.submitted)return;
    if(event.type==='message.start'){if(this.started||this.answer)this.fail();else this.started=true;return;}
    const result=event.payload;
    if(!this.started||!this.agent||result?.status!=='complete'||result.partial===true||result.error||result.failure_reason||
      typeof result.text!=='string'||!result.text.includes(this.marker!)||result.text.includes(this.prompt)){this.fail();return;}
    this.answer=result.text;
  }
  ready() {this.check();return this.bootstrap&&Boolean(this.pty&&!this.pty.closed&&this.feed&&!this.feed.closed&&this.pty.channel===this.feed.channel);}
  begin(marker:string) {
    requireProof(this.ready()&&!this.prompt&&/^[A-Za-z0-9_-]{1,128}$/.test(marker),'API');
    this.marker=marker;this.prompt='Reply with exactly '+marker;return this.prompt;
  }
  complete() {this.check();return this.answer!==undefined;}
  expectedCopy() {this.check();requireProof(this.answer!==undefined,'API');return this.answer;}
  copiedResponse() {this.check();requireProof(this.answer!==undefined,'API');this.copied=true;}
  snapshot() {return {bootstrap:this.bootstrap,agent:this.agent,submitted:this.submitted,started:this.started,
    completed:this.answer!==undefined,copied:this.copied,failed:Boolean(this.failure)};}
}

/** Install before navigation so a fast initial session.info cannot be missed.
 * Observe only: no new RPC client, request or backend-only inference fallback. */
export function observeHermesTerminal(page:Page,evidence:HermesTerminalEvidence) {
  const opened=(socket:WebSocket)=>{
    const stream=evidence.open(socket.url());if(!stream)return;
    socket.on('framereceived',frame=>evidence.received(stream,frame.payload));
    socket.on('framesent',frame=>evidence.sent(stream,frame.payload));
    socket.on('close',()=>evidence.close(stream));
    socket.on('socketerror',()=>evidence.close(stream));
  };
  page.on('websocket',opened);
  return ()=>page.off('websocket',opened);
}

export async function verifyHermesTerminalChat(page:Page,evidence:HermesTerminalEvidence,guard:()=>Promise<void>,
  responseMarker:string,options:{readyMs?:number;inferenceMs?:number;copyMs?:number}={}) {
  await poll(async()=>{await guard();return evidence.ready();},Boolean,
    {timeoutMs:options.readyMs??120_000,intervalMs:250,stage:'app-ready'});
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:evidence.origin});
  return withCleanup(()=>atStage('model-inference',async()=>{
    await page.evaluate(()=>navigator.clipboard.writeText(''));
    const prompt=evidence.begin(responseMarker+'_'+randomBytes(8).toString('hex'));
    const input=page.locator('.hermes-chat-xterm-host .xterm-helper-textarea');
    requireProof(await input.count()===1,'API');
    await guard();await input.focus();await input.pressSequentially(prompt,{delay:20});await input.press('Enter');
    await poll(async()=>{await guard();return evidence.complete();},Boolean,
      {timeoutMs:options.inferenceMs??180_000,intervalMs:250,stage:'model-inference'});
    await page.getByRole('button',{name:'Copy last assistant response',exact:true}).click();
    // Only a boolean crosses out of the page; no raw answer/clipboard data is
    // used in assertions, attachments or public diagnostics.
    const expected=evidence.expectedCopy().replace(/\r\n/g,'\n').trim();
    await poll(async()=>{await guard();evidence.complete();return page.evaluate(text=>
      navigator.clipboard.readText().then(value=>value.replace(/\r\n/g,'\n').trim()===text),expected);},Boolean,
    {timeoutMs:options.copyMs??10_000,intervalMs:100,stage:'model-inference'});
    evidence.copiedResponse();
  }),async()=>{if(!page.isClosed())await page.evaluate(()=>navigator.clipboard.writeText(''));});
}
