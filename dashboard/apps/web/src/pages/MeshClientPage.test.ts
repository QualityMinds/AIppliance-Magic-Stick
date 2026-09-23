import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const html = readFileSync(resolve(process.cwd(), '../../../magic-cluster/apps/ai/private-mesh/client.html'), 'utf8');
const script = html.match(/<script nonce="__NONCE__">([\s\S]*?)<\/script>/)![1]!;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const value = (id: string) => element<HTMLInputElement>(id).value;
let state: {configured: boolean; connected: boolean; mesh: string; node: string; models: string[]; relay: {mode: string; url: string}};
let fetchMock: ReturnType<typeof vi.fn>;
let copy: ReturnType<typeof vi.fn>;

const mount = async () => {
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  // Execute the actual packaged HTML script, not a duplicate implementation.
  new Function(script)();
  await vi.waitFor(() => expect(element('status').textContent).toContain(state.mesh));
};
const openConnection = async () => {
  element<HTMLDetailsElement>('api-details').open = true;
  await vi.waitFor(() => expect(value('api-base')).toBe('http://127.0.0.1:45678/v1'));
};

describe('MeshLLM endpoint client', () => {
  beforeEach(() => {
    state = {configured: true, connected: true, mesh: 'example-mesh', node: 'endpoint-a',
      models: ['share/stick-a/example-model', 'share/stick-b/other-model'], relay: {mode: 'auto', url: ''}};
    sessionStorage.setItem('mesh-session', 'fixture-ui-session');
    fetchMock = vi.fn(async (path: string) => new Response(JSON.stringify(path === '/status' ? state :
      {baseUrl: 'http://127.0.0.1:45678/v1', apiKey: 'fixture-inference-key', streaming: false}), {headers: {'content-type': 'application/json'}}));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('setInterval', vi.fn());
    copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: copy}});
  });
  afterEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('uses endpoint branding and loads credentials only when the section opens', async () => {
    await mount();
    expect(document.body.textContent).toContain('Magicstick MeshLLM Endpoint');
    expect(document.body.textContent).not.toContain('EMPLOYEE LAPTOP');
    expect(element<HTMLDetailsElement>('api-details').open).toBe(false);
    expect(fetchMock).not.toHaveBeenCalledWith('/connection', expect.anything());
    expect(value('api-key')).toBe('');
    await openConnection();
    expect(value('api-key')).toBe('fixture-inference-key');
    expect(element<HTMLInputElement>('api-key').type).toBe('password');
    expect(element('models-endpoint').textContent).toBe('http://127.0.0.1:45678/v1/models');
    expect(element('chat-endpoint').textContent).toBe('http://127.0.0.1:45678/v1/chat/completions');
  });

  it('copies the inference key and complete model identifier, never the browser session', async () => {
    await mount();
    await openConnection();
    element('copy-key').click();
    expect(copy).toHaveBeenCalledWith('fixture-inference-key');
    element('copy-model').click();
    expect(copy).toHaveBeenCalledWith('share/stick-a/example-model');
    expect(copy).not.toHaveBeenCalledWith('fixture-ui-session');
    element('show-key').click();
    expect(element<HTMLInputElement>('api-key').type).toBe('text');
    element<HTMLDetailsElement>('api-details').open = false;
    await vi.waitFor(() => expect(value('api-key')).toBe(''));
    expect(element<HTMLInputElement>('api-key').type).toBe('password');
  });

  it('keeps the connection example aligned with the selected model without embedding secrets', async () => {
    await mount();
    await openConnection();
    element<HTMLSelectElement>('model').value = 'share/stick-b/other-model';
    element('model').dispatchEvent(new Event('change'));
    expect(value('api-model')).toBe('share/stick-b/other-model');
    const example = element('api-curl').textContent;
    expect(example).toContain('share/stick-b/other-model');
    expect(example).toContain('"stream":false');
    expect(example).toContain('Authorization: Bearer $OPENAI_API_KEY');
    expect(example).not.toContain('fixture-inference-key');
    expect(example).not.toContain('fixture-ui-session');
  });

  it('disables chat examples when no shared model is available', async () => {
    state.models = [];
    await mount();
    await openConnection();
    expect(element<HTMLButtonElement>('copy-example').disabled).toBe(true);
    expect(element<HTMLButtonElement>('copy-model').disabled).toBe(true);
    expect(element<HTMLButtonElement>('copy-key').disabled).toBe(false);
  });
});
