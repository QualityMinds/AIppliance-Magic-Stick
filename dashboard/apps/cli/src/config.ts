import {constants as fsConstants, promises as fs} from 'node:fs';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface CliConfig {
  apiUrl?: string;
  issuer?: string;
  clientId?: string;
  caFile?: string;
}

export interface StoredSession {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
}

export interface ConfigPaths {
  directory: string;
  config: string;
  session: string;
}

export const configPaths = (environment: NodeJS.ProcessEnv = process.env): ConfigPaths => {
  const directory = environment.MAGICSTICK_CONFIG_HOME
    ?? path.join(environment.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'magicstick');
  return {directory, config: path.join(directory, 'config.json'), session: path.join(directory, 'session.json')};
};

const readJson = async <T>(filename: string): Promise<T | undefined> => {
  try {
    await fs.access(filename, fsConstants.R_OK);
    return JSON.parse(await fs.readFile(filename, 'utf8')) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw error;
  }
};

const writePrivateJson = async (filename: string, value: unknown) => {
  const directory = path.dirname(filename);
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  await fs.chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
    await fs.rename(temporary, filename);
    await fs.chmod(filename, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(temporary, {force: true}).catch(() => undefined);
  }
};

export const readConfig = (paths = configPaths()) => readJson<CliConfig>(paths.config);
export const writeConfig = (config: CliConfig, paths = configPaths()) => writePrivateJson(paths.config, config);
export const readSession = (paths = configPaths()) => readJson<StoredSession>(paths.session);
export const writeSession = (session: StoredSession, paths = configPaths()) => writePrivateJson(paths.session, session);
export const clearSession = async (paths = configPaths()) => fs.rm(paths.session, {force: true});

export const deriveIssuer = (apiUrl: string) => {
  const parsed = new URL(apiUrl);
  const hostname = parsed.hostname.replace(/^api\./, '');
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//id.${hostname}${port}/realms/magicstick`;
};
