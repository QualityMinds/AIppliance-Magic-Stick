import {test, expect} from '@playwright/test';
import {formatMi, phaseTone, phaseNeedsAttention, progressForPhase} from '@magicstick/dashboard-core';

test('NAV-06 [p1:failed-status-unit] failed phases retain attention and error semantics rather than Ready', () => {
  for (const phase of ['Failed', 'Degraded']) {
    expect(phaseNeedsAttention(phase)).toBe(true); expect(phaseTone(phase)).toBe('bad');
    const progress = progressForPhase(phase, true, 'Controlled root cause');
    expect(progress.label).toBe('Controlled root cause'); expect(progress.tone).toBe('bad');
  }
});

test('NAV-06 [p1:unknown-memory-unit] missing memory is unknown while an actual zero remains a measured zero', () => {
  expect(formatMi(null)).toBe('unknown'); expect(formatMi(undefined)).toBe('unknown');
  expect(formatMi(Number.NaN)).toBe('unknown'); expect(formatMi(0)).not.toBe('unknown');
});
