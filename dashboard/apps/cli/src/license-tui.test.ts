import {PassThrough} from 'node:stream';
import {describe, expect, it, vi} from 'vitest';
import {createDemoRuntime} from './demo';
import {runTui} from './tui';
import * as licenseFiles from './license';
import type {LicenseStatus} from '@magicstick/dashboard-contracts';

describe('license TUI controls', () => {
  it('previews a local file and imports only after a separate confirmation', async () => {
    vi.useFakeTimers();
    const stdin = Object.assign(new PassThrough(), {isTTY: true, setRawMode: vi.fn()});
    const stdout = Object.assign(new PassThrough(), {isTTY: true, columns: 120, rows: 35});
    const writes: string[] = [];
    stdout.on('data', (value: Buffer) => writes.push(value.toString()));
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout as unknown as typeof process.stdout);
    const runtime = createDemoRuntime();
    vi.spyOn(licenseFiles, 'readLicenseFile').mockResolvedValue('test-document');
    const current = await runtime.api.licenseStatus();
    const inspect = vi.spyOn(runtime.api, 'inspectLicense').mockResolvedValue({current: {...current, revision: '7'}, candidate: {valid: true, state: 'valid', message: 'Verified offline.'}});
    const activate = vi.spyOn(runtime.api, 'importLicense').mockResolvedValue(current as LicenseStatus);
    const running = runTui(runtime, {color: false});
    const key = (value: string) => stdin.emit('data', Buffer.from(value));
    try {
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 6; i++) key('l');
      expect(writes.at(-1)).toContain('[ License ]');
      key('a'); key('/tmp/test-license.json'); key('\r');
      await vi.advanceTimersByTimeAsync(0);
      expect(inspect).toHaveBeenCalledWith('test-document');
      expect(writes.at(-1)).toContain('Activate license');
      expect(activate).not.toHaveBeenCalled();
      key('y');
      await vi.advanceTimersByTimeAsync(0);
      expect(activate).toHaveBeenCalledWith('test-document', '7');
      expect(writes.at(-1)).toContain('License saved persistently.');
      key('\x03'); await running;
    } finally {
      key('\x03');
      vi.restoreAllMocks(); vi.useRealTimers(); stdin.destroy(); stdout.destroy();
    }
  });
});
