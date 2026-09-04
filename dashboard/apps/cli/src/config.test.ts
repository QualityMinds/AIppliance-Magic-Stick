import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {clearSession, configPaths, deriveIssuer, readConfig, readSession, writeConfig, writeSession} from './config';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {recursive: true, force: true})));
});

describe('CLI configuration', () => {
  it('derives the Keycloak issuer from the API hostname', () => {
    expect(deriveIssuer('https://api.magicstick.local')).toBe('https://id.magicstick.local/realms/magicstick');
    expect(deriveIssuer('https://api.example.test:9443')).toBe('https://id.example.test:9443/realms/magicstick');
  });

  it('stores configuration and tokens in private files', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magicstick-cli-'));
    temporaryDirectories.push(directory);
    const paths = configPaths({MAGICSTICK_CONFIG_HOME: directory});
    const config = {apiUrl: 'https://api.magicstick.local', issuer: 'https://id.magicstick.local/realms/magicstick', clientId: 'magicstick-cli'};
    const session = {accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 60_000};

    await writeConfig(config, paths);
    await writeSession(session, paths);

    expect(await readConfig(paths)).toEqual(config);
    expect(await readSession(paths)).toEqual(session);
    expect((await fs.stat(paths.directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(paths.config)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(paths.session)).mode & 0o777).toBe(0o600);

    await clearSession(paths);
    expect(await readSession(paths)).toBeUndefined();
  });
});
