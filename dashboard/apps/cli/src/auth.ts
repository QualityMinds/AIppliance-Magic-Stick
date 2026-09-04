import {spawn} from 'node:child_process';
import type {StoredSession} from './config';

interface OidcMetadata {
  device_authorization_endpoint?: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

interface OAuthError {
  error?: string;
  error_description?: string;
}

export interface DeviceLoginOptions {
  issuer: string;
  clientId: string;
  openBrowser?: boolean;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  onPrompt?: (details: {verificationUri: string; userCode: string; completeUri?: string}) => void;
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const jsonResponse = async <T>(response: Response): Promise<T> => {
  const body = await response.json().catch(() => ({})) as T & OAuthError;
  if (!response.ok) throw new Error(body.error_description || body.error || `OIDC request failed with HTTP ${response.status}`);
  return body;
};

const postForm = (fetchImpl: typeof globalThis.fetch, url: string, values: Record<string, string>) => fetchImpl(url, {
  method: 'POST',
  headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
  body: new URLSearchParams(values),
});

export const discoverOidc = async (issuer: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch) => {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  return jsonResponse<OidcMetadata>(await fetchImpl(url, {headers: {Accept: 'application/json'}}));
};

const storedSession = (tokens: TokenResponse): StoredSession => ({
  accessToken: tokens.access_token,
  refreshToken: tokens.refresh_token,
  idToken: tokens.id_token,
  expiresAt: Date.now() + Math.max(30, Number(tokens.expires_in ?? 300)) * 1000,
});

export const openExternal = (url: string) => {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, {detached: true, stdio: 'ignore', shell: false});
  child.on('error', () => undefined);
  child.unref();
};

export const loginWithDeviceFlow = async (options: DeviceLoginOptions): Promise<StoredSession> => {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const wait = options.sleep ?? sleep;
  const metadata = await discoverOidc(options.issuer, fetchImpl);
  if (!metadata.device_authorization_endpoint) throw new Error('The identity provider does not advertise a device authorization endpoint.');
  const device = await jsonResponse<DeviceAuthorization>(await postForm(fetchImpl, metadata.device_authorization_endpoint, {
    client_id: options.clientId,
    scope: 'openid profile email',
  }));
  options.onPrompt?.({
    verificationUri: device.verification_uri,
    userCode: device.user_code,
    completeUri: device.verification_uri_complete,
  });
  if (options.openBrowser !== false) openExternal(device.verification_uri_complete ?? device.verification_uri);

  const deadline = Date.now() + Number(device.expires_in) * 1000;
  let interval = Math.max(1, Number(device.interval ?? 5));
  while (Date.now() < deadline) {
    await wait(interval * 1000);
    const response = await postForm(fetchImpl, metadata.token_endpoint, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: options.clientId,
    });
    const body = await response.json().catch(() => ({})) as Partial<TokenResponse> & OAuthError;
    if (response.ok && body.access_token) return storedSession(body as TokenResponse);
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      interval += 5;
      continue;
    }
    throw new Error(body.error_description || body.error || `OIDC token request failed with HTTP ${response.status}`);
  }
  throw new Error('The device login expired before it was completed. Run login again.');
};

export const refreshSession = async (
  issuer: string,
  clientId: string,
  session: StoredSession,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
) => {
  if (!session.refreshToken) throw new Error('The saved login has expired. Run `magicstick login` again.');
  const metadata = await discoverOidc(issuer, fetchImpl);
  const tokens = await jsonResponse<TokenResponse>(await postForm(fetchImpl, metadata.token_endpoint, {
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
    client_id: clientId,
  }));
  return storedSession({...tokens, refresh_token: tokens.refresh_token ?? session.refreshToken});
};

export const certificateHint = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = String((error as {cause?: {code?: string}})?.cause?.code ?? '');
  if (/certificate|self[- ]signed|unable to verify/i.test(message) || /CERT|SELF_SIGNED/i.test(code)) {
    return `${message}\nTrust the Magic Stick local CA for Node.js or set NODE_EXTRA_CA_CERTS to the exported CA certificate.`;
  }
  return message;
};
