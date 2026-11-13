import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ConsoleSignInUnavailableError} from './auth';
import {createOidcNetworkFetch, createRuntime} from './runtime';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('CLI runtime transport', () => {
  it('routes only issuer traffic through the private console-network endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    const routedFetch = createOidcNetworkFetch(
      'https://id.magicstick.local/realms/magicstick',
      'http://keycloak.identity-system.svc.cluster.local:8080/realms/magicstick/',
      fetchMock,
    );

    await routedFetch('https://id.magicstick.local/realms/magicstick/.well-known/openid-configuration');
    await routedFetch('https://api.magicstick.local/api/session');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://keycloak.identity-system.svc.cluster.local:8080/realms/magicstick/.well-known/openid-configuration',
      undefined,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://api.magicstick.local/api/session', undefined);
  });

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

  describe('automatic appliance-console session', () => {
    const issuer = 'https://id.example.test/realms/magicstick';
    const setup = async (secret: string | null = 'CHANGEME') => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'magicstick-console-'));
      const secretFile = path.join(home, 'client-secret');
      if (secret !== null) await fs.writeFile(secretFile, `${secret}\n`);
      vi.stubEnv('MAGICSTICK_CONFIG_HOME', home);
      const tokens: string[] = [];
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/.well-known/openid-configuration')) return Response.json({token_endpoint: `${issuer}/token`});
        if (url.endsWith('/token')) {
          const form = init?.body as URLSearchParams;
          tokens.push(form.get('grant_type') ?? '');
          return form.get('client_secret') === 'CHANGEME'
            ? Response.json({access_token: `console-${tokens.length}`, expires_in: 300})
            : Response.json({error: 'unauthorized_client'}, {status: 401});
        }
        const bearer = new Headers(init?.headers).get('Authorization');
        return Response.json({subject: '1', username: bearer, roles: ['magicstick-admin'], localConsole: bearer?.includes('console-')});
      });
      vi.stubGlobal('fetch', fetchMock);
      return {home, secretFile, tokens, fetchMock};
    };

    it('signs in without any user interaction and never stores the token', async () => {
      const {home, secretFile, tokens} = await setup();
      const runtime = await createRuntime({apiUrl: 'https://api.example.test', issuer, consoleSecretFile: secretFile});

      expect(runtime.localConsole).toBe(true);
      expect(runtime.sessionKind()).toBe('console');
      expect((await runtime.api.session()).username).toBe('Bearer console-1');
      expect((await runtime.api.session()).localConsole).toBe(true);
      expect(tokens).toEqual(['client_credentials']); // Reused until shortly before expiry.
      expect(await fs.readdir(home)).toEqual(['client-secret']);
    });

    it('prefers a saved user login and returns to the console session on logout', async () => {
      const {home, secretFile} = await setup();
      await fs.writeFile(path.join(home, 'session.json'), JSON.stringify({accessToken: 'tova-token', expiresAt: Date.now() + 600_000}));
      const runtime = await createRuntime({apiUrl: 'https://api.example.test', issuer, consoleSecretFile: secretFile});

      expect(runtime.sessionKind()).toBe('user');
      expect((await runtime.api.session()).username).toBe('Bearer tova-token');

      await runtime.logout();

      expect(runtime.sessionKind()).toBe('console');
      expect((await runtime.api.session()).username).toBe('Bearer console-1');
      expect(await fs.readdir(home)).toEqual(['client-secret']);
    });

    it.each([['a missing secret', null], ['an empty secret', ''], ['a rejected secret', 'stale']])('reports %s as unavailable automatic sign-in', async (_name, secret) => {
      const {secretFile} = await setup(secret);
      const runtime = await createRuntime({apiUrl: 'https://api.example.test', issuer, consoleSecretFile: secretFile});

      await expect(runtime.api.session()).rejects.toBeInstanceOf(ConsoleSignInUnavailableError);
    });

    it('is not used by a workstation CLI without the console secret', async () => {
      await setup();
      const runtime = await createRuntime({apiUrl: 'https://api.example.test', issuer});

      expect(runtime.localConsole).toBe(false);
      expect(runtime.sessionKind()).toBe('none');
      await expect(runtime.api.session()).rejects.toThrow('Not signed in');
    });
  });
});
