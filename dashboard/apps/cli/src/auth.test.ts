import {describe, expect, it, vi} from 'vitest';
import {certificateHint, loginWithDeviceFlow, refreshSession} from './auth';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {'Content-Type': 'application/json'},
});

describe('OIDC device authentication', () => {
  it('discovers endpoints, prompts the user and polls until authorized', async () => {
    const responses = [
      json({device_authorization_endpoint: 'https://id.example/device', token_endpoint: 'https://id.example/token'}),
      json({device_code: 'device', user_code: 'ABCD-EFGH', verification_uri: 'https://id.example/activate', expires_in: 600, interval: 1}),
      json({error: 'authorization_pending'}, 400),
      json({access_token: 'access', refresh_token: 'refresh', id_token: 'identity', expires_in: 300}),
    ];
    const fetchMock = vi.fn(async () => responses.shift() ?? json({error: 'unexpected'}, 500)) as unknown as typeof fetch;
    const prompt = vi.fn();
    const wait = vi.fn(async () => undefined);

    const session = await loginWithDeviceFlow({
      issuer: 'https://id.example/realms/magicstick',
      clientId: 'magicstick-cli',
      openBrowser: false,
      fetch: fetchMock,
      sleep: wait,
      onPrompt: prompt,
    });

    expect(session).toMatchObject({accessToken: 'access', refreshToken: 'refresh', idToken: 'identity'});
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(prompt).toHaveBeenCalledWith({verificationUri: 'https://id.example/activate', userCode: 'ABCD-EFGH', completeUri: undefined});
    expect(wait).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('refreshes an expired access token without discarding a retained refresh token', async () => {
    const responses = [
      json({token_endpoint: 'https://id.example/token'}),
      json({access_token: 'new-access', expires_in: 120}),
    ];
    const fetchMock = vi.fn(async () => responses.shift() ?? json({error: 'unexpected'}, 500)) as unknown as typeof fetch;
    const refreshed = await refreshSession(
      'https://id.example/realms/magicstick',
      'magicstick-cli',
      {accessToken: 'old', refreshToken: 'retained', expiresAt: 0},
      fetchMock,
    );

    expect(refreshed.accessToken).toBe('new-access');
    expect(refreshed.refreshToken).toBe('retained');
  });

  it('adds an actionable hint for a local certificate trust failure', () => {
    expect(certificateHint(new Error('self-signed certificate'))).toContain('NODE_EXTRA_CA_CERTS');
  });

  it('surfaces the nested Node leaf-signature error hidden by fetch', () => {
    const cause = Object.assign(new Error('verification failed'), {code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'});
    expect(certificateHint(new TypeError('fetch failed', {cause}))).toContain('--ca-file');
  });
});
