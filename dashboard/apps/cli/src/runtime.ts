import {MagicStickApi} from '@magicstick/dashboard-api-client';
import {X509Certificate} from 'node:crypto';
import {promises as fs} from 'node:fs';
import tls from 'node:tls';
import {certificateHint, loginWithDeviceFlow, refreshSession} from './auth';
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
  insecure?: boolean;
  accessToken?: string;
  oidcNetworkUrl?: string;
}

export interface ResolvedCliConfig {
  apiUrl: string;
  issuer: string;
  clientId: string;
  caFile?: string;
}

export interface Runtime {
  api: MagicStickApi;
  settings: ResolvedCliConfig;
  login: (openBrowser?: boolean, onPrompt?: (details: {verificationUri: string; userCode: string; completeUri?: string}) => void) => Promise<void>;
  logout: () => Promise<void>;
}

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
  if (options.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  await configureTlsTrust(options.insecure ? undefined : settings.caFile);
  const environmentToken = options.accessToken ?? process.env.MAGICSTICK_ACCESS_TOKEN;
  const oidcNetworkUrl = (options.oidcNetworkUrl ?? process.env.MAGICSTICK_OIDC_NETWORK_URL)?.replace(/\/$/, '');
  const oidcFetch = createOidcNetworkFetch(settings.issuer, oidcNetworkUrl);
  let cached: StoredSession | undefined = await readSession();

  const accessToken = async () => {
    if (environmentToken) return environmentToken;
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
    login: async (openBrowser = true, onPrompt) => {
      await writeConfig(settings);
      try {
        cached = await loginWithDeviceFlow({
          issuer: settings.issuer,
          clientId: settings.clientId,
          openBrowser,
          onPrompt,
          fetch: oidcFetch,
        });
        await writeSession(cached);
      } catch (error) {
        throw new Error(certificateHint(error), {cause: error});
      }
    },
    logout: async () => {
      cached = undefined;
      await clearSession();
    },
  };
};
