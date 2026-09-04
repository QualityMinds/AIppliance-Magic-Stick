import {MagicStickApi} from '@magicstick/dashboard-api-client';
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
  accessToken?: string;
}

export interface Runtime {
  api: MagicStickApi;
  settings: Required<CliConfig>;
  login: (openBrowser?: boolean, onPrompt?: (details: {verificationUri: string; userCode: string; completeUri?: string}) => void) => Promise<void>;
  logout: () => Promise<void>;
}

const defaults = (options: RuntimeOptions, saved?: CliConfig): Required<CliConfig> => {
  const apiUrl = (options.apiUrl ?? process.env.MAGICSTICK_API_URL ?? saved?.apiUrl ?? 'https://api.magicstick.local').replace(/\/$/, '');
  return {
    apiUrl,
    issuer: (options.issuer ?? process.env.MAGICSTICK_ISSUER ?? saved?.issuer ?? deriveIssuer(apiUrl)).replace(/\/$/, ''),
    clientId: options.clientId ?? process.env.MAGICSTICK_CLIENT_ID ?? saved?.clientId ?? 'magicstick-cli',
  };
};

export const createRuntime = async (options: RuntimeOptions = {}): Promise<Runtime> => {
  const settings = defaults(options, await readConfig());
  const environmentToken = options.accessToken ?? process.env.MAGICSTICK_ACCESS_TOKEN;
  let cached: StoredSession | undefined = await readSession();

  const accessToken = async () => {
    if (environmentToken) return environmentToken;
    if (!cached) throw new Error('Not signed in. Run `magicstick login` first.');
    if (cached.expiresAt > Date.now() + 30_000) return cached.accessToken;
    try {
      cached = await refreshSession(settings.issuer, settings.clientId, cached);
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
