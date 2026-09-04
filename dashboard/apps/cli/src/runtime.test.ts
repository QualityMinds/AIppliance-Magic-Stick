import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createRuntime} from './runtime';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('CLI runtime transport', () => {
  it('sends the device-session token and mutation marker through the shared API client', async () => {
    vi.stubEnv('MAGICSTICK_CONFIG_HOME', path.join(os.tmpdir(), `magicstick-cli-missing-${process.pid}`));
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/session')) {
        return new Response(JSON.stringify({subject: '1', username: 'tova', roles: ['magicstick-admin']}), {
          status: 200, headers: {'Content-Type': 'application/json'},
        });
      }
      return new Response(JSON.stringify({ok: true}), {status: 200, headers: {'Content-Type': 'application/json'}});
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtime = await createRuntime({apiUrl: 'https://api.example.test', issuer: 'https://id.example.test/realms/magicstick', accessToken: 'device-access'});

    expect((await runtime.api.session()).username).toBe('tova');
    await runtime.api.enableModule('litellm');

    const readHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const mutationHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(readHeaders.get('Authorization')).toBe('Bearer device-access');
    expect(mutationHeaders.get('Authorization')).toBe('Bearer device-access');
    expect(mutationHeaders.get('X-MagicStick-CSRF')).toBe('dashboard');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.example.test/api/modules/litellm/enable');
  });
});
