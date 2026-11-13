import {MagicStickApi} from '@magicstick/dashboard-api-client';
import {X509Certificate} from 'node:crypto';
import {promises as fs} from 'node:fs';
import tls from 'node:tls';
import {certificateHint, ConsoleSignInUnavailableError, LoginCancelledError, loginWithConsoleCredential, loginWithDeviceFlow, refreshSession} from './auth';
import {
  clearSession,
  deriveIssuer,
  readConfig,
  readSession,
  writeConfig,
  writeSession,
  type CliConfig,
  type StoredSession,
} from './config';

export interface RuntimeOptions {
  apiUrl?: string;
  issuer?: string;
  clientId?: string;
  caFile?: string;
  accessToken?: string;
  oidcNetworkUrl?: string;
  /** File holding the appliance-console client secret; enables automatic console sign-in. */
  consoleSecretFile?: string;
  consoleClientId?: string;
}

/**
 * Where the current API identity comes from:
 * `token` an externally supplied access token, `user` a saved device login,
 * `console` the automatic appliance-console session, `none` not signed in.
 */
export type SessionKind = 'token' | 'user' | 'console' | 'none';

export interface ResolvedCliConfig {
  apiUrl: string;
  issuer: string;
  clientId: string;
  caFile?: string;
}

export interface Runtime {
  api: MagicStickApi;
  settings: ResolvedCliConfig;
  login: (
    openBrowser?: boolean,
    onPrompt?: (details: {verificationUri: string; userCode: string; completeUri?: string}) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Removes the saved user login. An available automatic console session takes over again. */
  logout: () => Promise<void>;
  sessionKind: () => SessionKind;
  /** True when this terminal is the appliance console with automatic sign-in configured. */
  localConsole: boolean;
}

const readConsoleSecret = async (filename: string) => {
  let secret: string;
  try {
    secret = (await fs.readFile(filename, 'utf8')).trim();
  } catch (error) {
    // The Secret is optional: appliances provision it with a later GitOps revision.
    throw new ConsoleSignInUnavailableError('Automatic console sign-in is not provisioned on this appliance yet.', {cause: error});
  }
  if (!secret) throw new ConsoleSignInUnavailableError('Automatic console sign-in is not provisioned on this appliance yet.');
  return secret;
};

const defaults = (options: RuntimeOptions, saved?: CliConfig): ResolvedCliConfig => {
  const apiUrl = (options.apiUrl ?? process.env.MAGICSTICK_API_URL ?? saved?.apiUrl ?? 'https://api.magicstick.local').replace(/\/$/, '');
  return {
    apiUrl,
    issuer: (options.issuer ?? process.env.MAGICSTICK_ISSUER ?? saved?.issuer ?? deriveIssuer(apiUrl)).replace(/\/$/, ''),
    clientId: options.clientId ?? process.env.MAGICSTICK_CLIENT_ID ?? saved?.clientId ?? 'magicstick-cli',
    caFile: options.caFile ?? process.env.MAGICSTICK_CA_FILE ?? saved?.caFile,
  };
};

export const configureTlsTrust = async (caFile?: string) => {
  const authorities = [
    ...tls.getCACertificates('default'),
    ...tls.getCACertificates('system'),
  ];
  if (caFile) {
    let certificate: string;
    try {
      certificate = await fs.readFile(caFile, 'utf8');
    } catch (error) {
      throw new Error(`Cannot read the CA certificate at ${caFile}.`, {cause: error});
    }
    if (/PRIVATE KEY/.test(certificate)) throw new Error(`The CA file at ${caFile} must not contain a private key.`);
    try {
      if (!new X509Certificate(certificate).ca) throw new Error('certificate is not a CA');
    } catch (error) {
      throw new Error(`The CA file at ${caFile} does not contain a valid CA certificate.`, {cause: error});
    }
    authorities.push(certificate);
  }
  tls.setDefaultCACertificates([...new Set(authorities)]);
};

export const createOidcNetworkFetch = (
  issuer: string,
  networkUrl: string | undefined,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch => {
  const normalizedIssuer = issuer.replace(/\/$/, '');
  const normalizedNetworkUrl = networkUrl?.replace(/\/$/, '');
  if (!normalizedNetworkUrl) return fetchImpl.bind(globalThis);
  return (input, init) => {
    const requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rewrittenUrl = requestedUrl === normalizedIssuer || requestedUrl.startsWith(`${normalizedIssuer}/`)
      ? `${normalizedNetworkUrl}${requestedUrl.slice(normalizedIssuer.length)}`
      : requestedUrl;
    return fetchImpl(rewrittenUrl, init);
  };
};

export const createRuntime = async (options: RuntimeOptions = {}): Promise<Runtime> => {
  const settings = defaults(options, await readConfig());
  await configureTlsTrust(settings.caFile);
  const environmentToken = options.accessToken ?? process.env.MAGICSTICK_ACCESS_TOKEN;
  const oidcNetworkUrl = (options.oidcNetworkUrl ?? process.env.MAGICSTICK_OIDC_NETWORK_URL)?.replace(/\/$/, '');
  const oidcFetch = createOidcNetworkFetch(settings.issuer, oidcNetworkUrl);
  const consoleSecretFile = options.consoleSecretFile ?? process.env.MAGICSTICK_CONSOLE_CLIENT_SECRET_FILE;
  const consoleClientId = options.consoleClientId ?? process.env.MAGICSTICK_CONSOLE_CLIENT_ID ?? 'magicstick-console';
  let cached: StoredSession | undefined = await readSession();
  // Kept in memory only: the automatic session is re-issued on demand and
  // must never replace or outlive a user's saved login on disk.
  let consoleSession: StoredSession | undefined;

  const consoleAccessToken = async (secretFile: string) => {
    if (consoleSession && consoleSession.expiresAt > Date.now() + 30_000) return consoleSession.accessToken;
    consoleSession = undefined;
    const clientSecret = await readConsoleSecret(secretFile);
    try {
      consoleSession = await loginWithConsoleCredential({
        issuer: settings.issuer, clientId: consoleClientId, clientSecret, fetch: oidcFetch,
      });
    } catch (error) {
      if (error instanceof ConsoleSignInUnavailableError) throw error;
      throw new Error(certificateHint(error), {cause: error});
    }
    return consoleSession.accessToken;
  };

  const accessToken = async () => {
    if (environmentToken) return environmentToken;
    if (!cached && consoleSecretFile) return consoleAccessToken(consoleSecretFile);
    if (!cached) throw new Error('Not signed in. Run `magicstick login` first.');
    if (cached.expiresAt > Date.now() + 30_000) return cached.accessToken;
    try {
      cached = await refreshSession(settings.issuer, settings.clientId, cached, oidcFetch);
      await writeSession(cached);
      return cached.accessToken;
    } catch (error) {
      throw new Error(certificateHint(error), {cause: error});
    }
  };

  return {
    settings,
    api: new MagicStickApi({baseUrl: settings.apiUrl, getAccessToken: accessToken}),
    login: async (openBrowser = true, onPrompt, signal) => {
      await writeConfig(settings);
      try {
        // The previous session stays active until the new login succeeded.
        const session = await loginWithDeviceFlow({
          issuer: settings.issuer,
          clientId: settings.clientId,
          openBrowser,
          onPrompt,
          signal,
          fetch: oidcFetch,
        });
        await writeSession(session);
        cached = session;
      } catch (error) {
        if (error instanceof LoginCancelledError) throw error;
        throw new Error(certificateHint(error), {cause: error});
      }
    },
    logout: async () => {
      cached = undefined;
      consoleSession = undefined;
      await clearSession();
    },
    sessionKind: () => environmentToken ? 'token' : cached ? 'user' : consoleSecretFile ? 'console' : 'none',
    localConsole: Boolean(consoleSecretFile),
  };
};
