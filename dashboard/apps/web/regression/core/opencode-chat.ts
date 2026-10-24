import {randomBytes} from 'node:crypto';
import type {Page} from '@playwright/test';
import {expect} from '@playwright/test';
import {HarnessError,requireProof,atStage} from './errors.ts';
import {poll} from './poll.ts';

// The repository's fresh KubeOpenCode AgentTemplate owns this workspace. The
// native OpenCode v1.17.11 SPA uses base64url directory/session routes.
export const openCodeWorkspace='/workspace';
export const openCodeChatPath='/'+Buffer.from(openCodeWorkspace).toString('base64url')+'/session';
type Turn={sessionId:string;messageId:string;model:string;prompt:string;marker:string};
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Native API observation after a GUI submission, not an API-only substitute.
 * A prompt echo, old parent, foreign model, partial/error or synthetic text is
 * never a completed assistant response. Raw messages remain in memory only. */
export function completedOpenCodeTurn(value:unknown,turn:Turn) {
  requireProof(Array.isArray(value)&&value.length<=1000,'API');
  const candidates=value.filter(row=>row?.info?.role==='assistant'&&row.info.parentID===turn.messageId);
  for(const row of candidates) {
    requireProof(row.info.sessionID===turn.sessionId&&identifier(row.info.id),'OWNERSHIP');
    requireProof(row.info.modelID===turn.model&&row.info.providerID==='litellm'&&!row.info.error,'API');
    if(typeof row.info.time?.completed==='number')requireProof(['stop','tool-calls','tool_calls'].includes(row.info.finish),'API');
  }
  const final=candidates.filter(row=>row.info.finish==='stop'&&typeof row.info.time?.completed==='number');
  requireProof(final.length<=1,'API');if(!final.length)return false;
  const row=final[0]!;
  requireProof(Number.isFinite(row.info.time.completed)&&Number.isFinite(row.info.time.created)&&
    row.info.time.completed>=row.info.time.created&&Array.isArray(row.parts)&&row.parts.length<=1000,'API');
  const text=row.parts.filter((part:any)=>part?.type==='text'&&part.synthetic!==true&&part.ignored!==true);
  requireProof(text.every((part:any)=>part.sessionID===turn.sessionId&&part.messageID===row.info.id&&typeof part.text==='string'),'OWNERSHIP');
  requireProof(text.some((part:any)=>part.text.includes(turn.marker)&&!part.text.includes(turn.prompt)),'API');
  return true;
}

export class OpenCodeChatEvidence {
  private turn?:Turn;
  private prompt?:string;
  private marker?:string;
  private requestUrl?:string;
  private workspace?:string;
  private acknowledged=false;
  private completed=false;
  private rendered=false;
  private composerReady=false;
  private failure?:HarnessError;
  readonly origin:string;
  readonly model:string;
  constructor(origin:string,model:string) {
    requireProof(new URL(origin).origin===origin&&new URL(origin).protocol==='https:'&&model.length>0&&model.length<256,'CONFIG');
    this.origin=origin;this.model=model;
  }
  check() {if(this.failure)throw this.failure;}
  fail(error:unknown) {this.failure??=error instanceof HarnessError?error:new HarnessError('UNEXPECTED','Failed','model-inference');}
  begin(marker:string) {
    requireProof(!this.prompt&&/^[A-Za-z0-9_-]{1,128}$/.test(marker),'CONFIG');
    this.marker=marker;this.prompt='Reply with exactly '+marker;return this.prompt;
  }
  submit(address:string,method:string,body:any,scope:{directory?:string;workspace?:string}={}) {
    this.check();const url=new URL(address),match=/^\/session\/([A-Za-z0-9_-]{1,128})\/prompt_async$/.exec(url.pathname);
    requireProof(!this.turn&&this.prompt&&this.marker&&url.origin===this.origin&&method==='POST'&&match&&
      [...url.searchParams.keys()].every(key=>['directory','workspace'].includes(key))&&
      (!url.searchParams.has('directory')||url.searchParams.get('directory')===openCodeWorkspace)&&
      (!url.searchParams.has('workspace')||identifier(url.searchParams.get('workspace')))&&
      (scope.directory===undefined||[openCodeWorkspace,encodeURIComponent(openCodeWorkspace)].includes(scope.directory))&&
      (url.searchParams.has('directory')||scope.directory!==undefined)&&
      (scope.workspace===undefined||identifier(scope.workspace))&&
      (!url.searchParams.has('workspace')||scope.workspace===undefined||url.searchParams.get('workspace')===scope.workspace)&&
      identifier(body?.messageID)&&body.model?.providerID==='litellm'&&body.model.modelID===this.model&&body.noReply!==true&&
      Array.isArray(body.parts)&&body.parts.length===1&&body.parts[0]?.type==='text'&&body.parts[0].text===this.prompt,'MUTATION');
    this.turn={sessionId:match[1]!,messageId:body.messageID,model:this.model,prompt:this.prompt,marker:this.marker};
    this.requestUrl=url.href;this.workspace=url.searchParams.get('workspace')??scope.workspace;
  }
  acknowledge(address:string,method:string,status:number) {
    if(address!==this.requestUrl||method!=='POST')return;
    if(status===204)this.acknowledged=true;else this.fail(new HarnessError('API','Failed','model-inference'));
  }
  accepted() {this.check();return this.acknowledged;}
  messageUrl() {
    this.check();requireProof(this.acknowledged&&this.turn,'API');
    const url=new URL(this.origin+'/session/'+this.turn.sessionId+'/message');url.searchParams.set('directory',openCodeWorkspace);
    if(this.workspace)url.searchParams.set('workspace',this.workspace);return url.href;
  }
  observe(value:unknown) {
    this.check();requireProof(this.acknowledged&&this.turn,'API');
    try {this.completed=completedOpenCodeTurn(value,this.turn);return this.completed;}
    catch(error){this.fail(error);throw error;}
  }
  renderedResponse() {this.check();requireProof(this.completed,'API');this.rendered=true;}
  ready() {this.check();this.composerReady=true;}
  snapshot() {return {composerReady:this.composerReady,submitted:Boolean(this.turn),acknowledged:this.acknowledged,completed:this.completed,rendered:this.rendered,failed:Boolean(this.failure)};}
}

/** Fence the browser's real native prompt request before it can use another
 * model/provider. Other app-local operations retain the existing guard. */
export async function observeOpenCodeChat(page:Page,evidence:OpenCodeChatEvidence,guard:()=>Promise<void>) {
  await page.route(url=>url.origin===evidence.origin&&/^\/session\/[^/]+\/prompt_async$/.test(url.pathname),async route=>{
    try {
      await guard();const request=route.request();
      // v1.17.11 sends directory/workspace headers on POST and rewrites them to
      // queries only on GET/HEAD. Verify either form, never conflicting scopes.
      evidence.submit(request.url(),request.method(),request.postDataJSON(),{
        directory:await request.headerValue('x-opencode-directory')??undefined,
        workspace:await request.headerValue('x-opencode-workspace')??undefined});
      await route.continue();
    }
    catch(error){evidence.fail(error);await route.abort('blockedbyclient').catch(()=>{});}
  });
  page.on('response',response=>evidence.acknowledge(response.url(),response.request().method(),response.status()));
}

export async function verifyOpenCodeChat(page:Page,evidence:OpenCodeChatEvidence,guard:()=>Promise<void>,responseMarker:string,
  options:{readyMs?:number;requestMs?:number;inferenceMs?:number}={}) {
  const input=page.locator('[data-component="prompt-input"][contenteditable="true"]');
  await atStage('app-ready',async()=>{
    const timeout=options.readyMs??120_000;
    await input.waitFor({state:'visible',timeout});
    // Native v1.17.11 exposes the editor before its agents/providers queries
    // complete. handleSubmit silently returns when either selection is absent;
    // a visible editor and an enabled Send button do not prove readiness.
    const model=page.locator('[data-action="prompt-model"]'),agent=page.locator('[data-action="prompt-agent"]');
    await expect(model).toBeVisible({timeout});await expect(model).toHaveText(evidence.model,{timeout});
    await expect(agent).toBeVisible({timeout});await expect(agent).toHaveText(/\S/,{timeout});
    await guard();evidence.ready();
  });
  return atStage('model-inference',async()=>{
    const marker=responseMarker+'_'+randomBytes(8).toString('hex'),prompt=evidence.begin(marker);
    await guard();await input.fill(prompt);await page.locator('[data-action="prompt-submit"]').click();
    await poll(async()=>{await guard();return evidence.accepted();},Boolean,
      {timeoutMs:options.requestMs??30_000,intervalMs:100,stage:'model-inference'});
    await poll(async()=>{
      await guard();evidence.check();
      const response=await page.context().request.get(evidence.messageUrl(),{maxRedirects:0,timeout:10_000});
      try {
        requireProof(response.status()===200&&response.headers()['content-type']?.includes('application/json'),'API');
        const body=await response.body();requireProof(body.length<=1024*1024,'API');return evidence.observe(JSON.parse(body.toString()));
      }finally{await response.dispose();}
    },Boolean,{timeoutMs:options.inferenceMs??180_000,intervalMs:250,stage:'model-inference'});
    const rendered=page.locator('[data-slot="session-turn-assistant-content"][aria-hidden="false"]').filter({hasText:marker});
    await expect(rendered).toHaveCount(1);await expect(rendered).toContainText(marker);
    evidence.renderedResponse();
  });
}
