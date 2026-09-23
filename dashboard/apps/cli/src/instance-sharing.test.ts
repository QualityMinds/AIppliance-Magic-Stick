import {describe, expect, it, vi} from 'vitest';
import {runCli} from './commands';
import type {Runtime} from './runtime';

describe('instance sharing commands', () => {
  it('requires explicit confirmation and preserves the current revision', async () => {
    const instanceAccess = vi.fn(async () => ({revision: '7'}));
    const updateInstanceAccess = vi.fn(async () => ({}));
    const runtime = {api: {instanceAccess, updateInstanceAccess}} as unknown as Runtime;
    const io = {stdout: vi.fn(), stderr: vi.fn(), readStdin: async () => JSON.stringify({mode: 'selected', users: ['stable-id'], groups: []})};
    const dependencies = {createRuntime: async () => runtime};
    await expect(runCli(['instance', 'share', 'hermes-example', '--file', '-'], io, dependencies)).rejects.toThrow('--yes');
    expect(updateInstanceAccess).not.toHaveBeenCalled();
    await runCli(['instance', 'share', 'hermes-example', '--file', '-', '--yes'], io, dependencies);
    expect(updateInstanceAccess).toHaveBeenCalledWith('hermes-example', {mode: 'selected', users: ['stable-id'], groups: []}, '7');
  });
});
