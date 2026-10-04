import type {APIRequestContext} from '@playwright/test';
import {HarnessError, requireSafe} from './errors.ts';

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

  private async call(path: '/v1/models' | '/v1/chat/completions', body?: unknown, credential: string | null = this.key) {
    let response;
    try { response = await this.request.fetch(this.origin + path, {method: body ? 'POST' : 'GET',
      headers: {...(credential ? {Authorization: `Bearer ${credential}`} : {}), Accept: 'application/json', ...(body ? {'Content-Type': 'application/json'} : {})},
      ...(body ? {data: JSON.stringify(body)} : {}), timeout: this.timeoutMs, maxRedirects: 0, failOnStatusCode: false}); }
    catch { throw new HarnessError('API'); }
    const contentType = response.headers()['content-type'] ?? '';
    requireSafe(contentType.includes('application/json') && (await response.body()).length < 2 * 1024 * 1024, 'API');
    return response;
  }

  async advertised(name: string) {
    const response = await this.call('/v1/models');
    requireSafe(response.status() === 200, 'API');
    const body = await response.json() as {data?: Array<{id?: string}>};
    requireSafe(Array.isArray(body.data), 'API');
    return body.data.some(item => item.id === name);
  }

  async chat(name: string, upstreamModel?: string) {
    const response = await this.call('/v1/chat/completions', {model: name,
      messages: [{role: 'user', content: 'Reply with one short word.'}], max_tokens: 8, temperature: 0, stream: false});
    requireSafe(response.status() === 200, 'API');
    const body = await response.json() as {model?: string; choices?: Array<{message?: {content?: unknown}}>};
    const content = body.choices?.[0]?.message?.content;
    requireSafe(typeof content === 'string' && content.trim().length > 0 &&
      (!body.model || body.model === name || body.model.endsWith('/' + name) ||
        (upstreamModel && (body.model === upstreamModel || body.model.endsWith('/' + upstreamModel)))), 'API');
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
