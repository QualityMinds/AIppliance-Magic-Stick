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
  /** Aborting stops the polling loop; the pending device code is simply left to expire. */
  signal?: AbortSignal;
  onPrompt?: (details: {verificationUri: string; userCode: string; completeUri?: string}) => void;
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** The interactive device login was cancelled by the person at the terminal. */
export class LoginCancelledError extends Error {
  constructor() {
    super('The login was cancelled.');
    this.name = 'LoginCancelledError';
  }
}

/**
 * The automatic appliance-console sign-in cannot be used: it is not
 * provisioned, or the identity provider rejected the console credential.
 * Callers fall back to an interactive login instead of failing.
 */
export class ConsoleSignInUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConsoleSignInUnavailableError';
  }
}

const abortable = (wait: Promise<void>, signal?: AbortSignal) => {
  if (!signal) return wait;
  if (signal.aborted) return Promise.reject(new LoginCancelledError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new LoginCancelledError());
    signal.addEventListener('abort', onAbort, {once: true});
    wait.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, reject);
  });
};

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
    await abortable(wait(interval * 1000), options.signal);
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

export interface ConsoleLoginOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Signs in the physical appliance console with its provisioned service
 * account. No user, browser or second device is involved, so this also works
 * while the appliance has no network connection.
 */
export const loginWithConsoleCredential = async (options: ConsoleLoginOptions): Promise<StoredSession> => {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const metadata = await discoverOidc(options.issuer, fetchImpl);
  const response = await postForm(fetchImpl, metadata.token_endpoint, {
    grant_type: 'client_credentials',
    client_id: options.clientId,
    client_secret: options.clientSecret,
    scope: 'openid',
  });
  const body = await response.json().catch(() => ({})) as Partial<TokenResponse> & OAuthError;
  if (response.ok && body.access_token) return storedSession({...body, access_token: body.access_token, refresh_token: undefined});
  if (response.status === 400 || response.status === 401) {
    throw new ConsoleSignInUnavailableError(
      `Automatic console sign-in was rejected by the identity provider (${body.error ?? `HTTP ${response.status}`}).`,
    );
  }
  throw new Error(body.error_description || body.error || `OIDC token request failed with HTTP ${response.status}`);
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
  if (/--ca-file|MAGICSTICK_CA_FILE|NODE_EXTRA_CA_CERTS/.test(message)) return message;
  const causes: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    causes.push(current);
    current = (current as {cause?: unknown}).cause;
  }
  const details = causes.map((item) => {
    const value = item as {message?: string; code?: string};
    return `${value.message ?? ''} ${value.code ?? ''}`;
  }).join(' ');
  if (/certificate|self[- ]signed|unable to verify|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_/i.test(details)) {
    return `${message}\nThe appliance CA is not trusted by Node.js. Trust it in the operating system, use --ca-file /path/to/magicstick-oidc-ca.crt, set MAGICSTICK_CA_FILE, or set NODE_EXTRA_CA_CERTS.`;
  }
  return message;
};
