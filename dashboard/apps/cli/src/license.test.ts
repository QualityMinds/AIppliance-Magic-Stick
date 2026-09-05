import {afterEach, describe, expect, it, vi} from 'vitest';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readLicenseFile, saveLicenseFile} from './license';
import {runCli} from './commands';
import type {Runtime} from './runtime';

const directories: string[] = [];
const temp = async () => {const path = await fs.mkdtemp(join(tmpdir(), 'magicstick-license-')); directories.push(path); return path;};
afterEach(async () => {for (const path of directories.splice(0)) await fs.rm(path, {recursive: true, force: true});});

describe('license files and CLI', () => {
  it('exports privately without overwriting an existing file', async () => {
    const path = join(await temp(), 'license.json');
    await saveLicenseFile(path, 'signed-document');
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect(await readLicenseFile(path)).toBe('signed-document');
    await expect(saveLicenseFile(path, 'replacement')).rejects.toThrow();
    expect(await readLicenseFile(path)).toBe('signed-document');
  });

  it('rejects oversized, non-UTF8 and non-file inputs', async () => {
    const directory = await temp(); const path = join(directory, 'file');
    await fs.writeFile(path, Buffer.alloc(65537));
    await expect(readLicenseFile(path)).rejects.toThrow('64 KiB');
    await fs.writeFile(path, Buffer.from([255]));
    await expect(readLicenseFile(path)).rejects.toThrow();
    await expect(readLicenseFile(directory)).rejects.toThrow('regular license file');
  });

  it('requires --yes and sends the preview revision when importing', async () => {
    const path = join(await temp(), 'license.json'); await saveLicenseFile(path, 'signed-document');
    const status = {state: 'valid', message: 'Verified.', installationId: 'test', trustedKeyIds: [], features: [], revision: '4'};
    const inspectLicense = vi.fn(async () => ({current: status, candidate: {valid: true, message: 'Verified.'}}));
    const importLicense = vi.fn(async () => status);
    const runtime = {api: {inspectLicense, importLicense}} as unknown as Runtime;
    const io = {stdout: vi.fn(), stderr: vi.fn(), readStdin: async () => ''};
    const options = {createRuntime: async () => runtime};
    await expect(runCli(['license', 'import', path], io, options)).rejects.toThrow('--yes');
    expect(importLicense).not.toHaveBeenCalled();
    await runCli(['license', 'import', path, '--yes'], io, options);
    expect(importLicense).toHaveBeenCalledWith('signed-document', '4');
    inspectLicense.mockResolvedValue({current: status, candidate: {valid: false, message: 'Invalid signature.'}});
    await expect(runCli(['license', 'import', path, '--yes'], io, options)).rejects.toThrow('Invalid signature.');
    expect(importLicense).toHaveBeenCalledOnce();
  });
});
