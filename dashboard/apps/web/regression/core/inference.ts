import type {APIRequestContext} from '@playwright/test';
import {HarnessError, requireSafe} from './errors.ts';

export interface InferenceObservation {
  httpStatus:number;hasContent:boolean;modelMatches:boolean;
  failure?:'transport'|'non-json'|'oversize'|'schema';
  transportReason?:'timeout'|'tls'|'connection'|'other';
}

/** Inference key exists in memory only; no requests or responses enter reports. */
export class InferenceProbe {
  private readonly request: APIRequestContext;
  private readonly origin: string;
  private readonly key: string;
  private readonly timeoutMs: number;
  constructor(request: APIRequestContext, origin: string, key: string, timeoutMs = 90_000) {
    this.request = request; this.origin = origin; this.key = key; this.timeoutMs = timeoutMs;
    requireSafe(new URL(origin).protocol === 'https:' && origin === new URL(origin).origin && key.startsWith('sk-'), 'CONFIG');
  }

  private async call(path: '/v1/models' | '/v1/chat/completions', body?: unknown, credential: string | null = this.key,
    observe?: (value:InferenceObservation)=>Promise<void>) {
    let response;
    try { response = await this.request.fetch(this.origin + path, {method: body ? 'POST' : 'GET',
      headers: {...(credential ? {Authorization: `Bearer ${credential}`} : {}), Accept: 'application/json', ...(body ? {'Content-Type': 'application/json'} : {})},
      ...(body ? {data: JSON.stringify(body)} : {}), timeout: this.timeoutMs, maxRedirects: 0, failOnStatusCode: false}); }
    catch(error) {
      const message=error instanceof Error ? error.message : '';
      const transportReason=/timeout|timed out/i.test(message) ? 'timeout' : /certificate|SSL|TLS/i.test(message) ? 'tls' :
        /ECONN|ENOTFOUND|socket|connection/i.test(message) ? 'connection' : 'other';
      if(observe) await observe({httpStatus:0,hasContent:false,modelMatches:false,failure:'transport',transportReason});
      throw new HarnessError('API');
    }
    const contentType = response.headers()['content-type'] ?? '';
    const json=contentType.includes('application/json'),bounded=(await response.body()).length < 2 * 1024 * 1024;
    if(!json || !bounded) {
      if(observe) await observe({httpStatus:response.status(),hasContent:false,modelMatches:false,failure:json ? 'oversize' : 'non-json'});
      throw new HarnessError('API');
    }
    return response;
  }

  async advertised(name: string) {
    const response = await this.call('/v1/models');
    requireSafe(response.status() === 200, 'API');
    const body = await response.json() as {data?: Array<{id?: string}>};
    requireSafe(Array.isArray(body.data), 'API');
    return body.data.some(item => item.id === name);
  }

  async chat(name: string, upstreamModel?: string, maxTokens = 8,
    observe?: (value:InferenceObservation)=>Promise<void>) {
    requireSafe(Number.isSafeInteger(maxTokens) && maxTokens >= 1 && maxTokens <= 256, 'CONFIG');
    const response = await this.call('/v1/chat/completions', {model: name,
      messages: [{role: 'user', content: 'Reply with one short word.'}], max_tokens: maxTokens, temperature: 0, stream: false},this.key,observe);
    let body:{model?:string;choices?:Array<{message?:{content?:unknown}}>};
    try {body=await response.json();requireSafe(body && typeof body === 'object' && !Array.isArray(body) &&
      (body.model === undefined || typeof body.model === 'string') && (body.choices === undefined || Array.isArray(body.choices)),'API');}
    catch {
      if(observe) await observe({httpStatus:response.status(),hasContent:false,modelMatches:false,failure:'schema'});
      throw new HarnessError('API');
    }
    const content = body.choices?.[0]?.message?.content;
    const hasContent=typeof content === 'string' && content.trim().length > 0;
    const modelMatches=!body.model || body.model === name || body.model.endsWith('/' + name) ||
      Boolean(upstreamModel && (body.model === upstreamModel || body.model.endsWith('/' + upstreamModel)));
    if(observe) await observe({httpStatus:response.status(),hasContent,modelMatches});
    requireSafe(response.status() === 200 && hasContent && modelMatches,'API');
  }

  async refusesStopped(name: string) {
    const response = await this.call('/v1/chat/completions', {model: name,
      messages: [{role: 'user', content: 'health probe'}], max_tokens: 1, stream: false});
    requireSafe(response.status() >= 400 && response.status() < 500, 'API');
  }

  async refusesUnauthorized(name: string, kind: 'missing' | 'invalid' | 'revoked') {
    const credential = kind === 'missing' ? null : kind === 'invalid' ? 'sk-magicstick-regression-invalid' : this.key;
    const response = await this.call('/v1/chat/completions', {model: name,
      messages: [{role: 'user', content: 'health probe'}], max_tokens: 1, stream: false}, credential);
    requireSafe([401, 403].includes(response.status()), 'AUTH');
  }
}
