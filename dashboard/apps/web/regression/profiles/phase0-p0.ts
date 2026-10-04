import type {LabConfig} from '../core/config.ts';
import {requireSafe} from '../core/errors.ts';

export const phase0Ids = Array.from({length: 11}, (_, index) => `HAR-${String(index + 1).padStart(2, '0')}`);
/** Finite acceptance matrix, not merely one green result per catalog ID. */
export const phase0Variants = {
  'verified-login': 'HAR-01', 'pinned-baseline': 'HAR-02', 'idle-baseline': 'HAR-03',
  'negative-preflight': 'HAR-02', 'offline-busy-abort': 'HAR-03',
  'lease-race': 'HAR-04', 'mutation-fencing': 'HAR-04',
  'uid-replacement': 'HAR-05', 'failure-cleanup': 'HAR-06', 'process-recovery': 'HAR-07',
  'revision-conflict': 'HAR-08', 'model-generation': 'HAR-09', 'flux-polling': 'HAR-09',
  'final-idle': 'HAR-03',
} as const;
export type Phase0Variant = keyof typeof phase0Variants;

export function requirePhase0Profile(config: LabConfig) {
  requireSafe(config.lock && config.modelCleanupKubeconfig && config.smokeModel && config.inferenceUrl &&
    config.expected.flux && /(?:sha1:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/.test(config.expected.flux.revision) &&
    config.expected.images.length >= 2 && config.expected.nodes.every(node => node.bootId), 'CONFIG');
  requireSafe(config.expected.images.some(image => image.container === 'web') &&
    config.expected.images.some(image => image.container === 'api'), 'CONFIG');
}

export function phase0Coverage(cases: Array<{id: string; layer: string; outcome: string; variant?: string; environment?: string}>) {
  const missingFixtures = phase0Ids.filter(id => !cases.some(item => item.id === id && item.environment === 'fixture' && item.outcome === 'Passed'));
  const missingVariants = Object.entries(phase0Variants).filter(([variant, id]) =>
    !cases.some(item => item.id === id && item.variant === variant && item.environment === 'live' && item.outcome === 'Passed')).map(([variant]) => variant);
  return {missingFixtures, missingVariants, complete: missingFixtures.length === 0 && missingVariants.length === 0 &&
    cases.length > 0 && cases.every(item => item.outcome === 'Passed')};
}
