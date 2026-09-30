import {describe, expect, it} from 'vitest';
import {moduleResourceLinks, safeModelName} from '@magicstick/dashboard-core';
import type {SystemStatusPayload} from '@magicstick/dashboard-contracts';

describe('dashboard core input handling', () => {
  it('normalizes long model references without retaining leading or trailing separators', () => {
    expect(safeModelName(`hf://Qwen/${'-'.repeat(10_000)}Qwen3${'-'.repeat(10_000)}`)).toBe('qwen3');
    expect(safeModelName('hf://Qwen/---')).toBe('model');
    expect(safeModelName('hf://Qwen/Qwen3.8-9B')).toBe('qwen3-8-9b');
  });

  it('extracts an authority from a malformed route without a backtracking regex', () => {
    const status = {ingresses: [{name: 'fixture', hosts: ['https://%invalid/a/b']}]} as SystemStatusPayload;
    expect(moduleResourceLinks('fixture', undefined, status)[0]?.label).toBe('%invalid');
  });
});
