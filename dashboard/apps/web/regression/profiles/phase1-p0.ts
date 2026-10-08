import type {LabConfig} from '../core/config.ts';
import {requirePhase0Profile} from './phase0-p0.ts';
import {environmentFor, type TestLayer} from '../core/evidence.ts';

/** Phase 1 is a finite CPU/Ollama smoke slice, not the whole catalog family. */
export const phase1LiveVariants = {
  'login-session': 'AUTH-01', 'anonymous-api': 'AUTH-02', 'anonymous-browser': 'AUTH-02',
  'logout-session': 'AUTH-06', 'read-only-navigation': 'NAV-03',
  'api-cpu-create': 'LIFE-01', 'cpu-chat': 'ROUTE-01',
  'ready-runtime-logs': 'LOG-01', 'text-log-transport': 'LOG-05',
  'ui-stop': 'LIFE-03', 'stopped-route': 'ROUTE-06',
  'api-start': 'LIFE-04', 'ui-start': 'LIFE-04',
  'ui-key-create': 'KEY-01', 'one-time-key': 'KEY-01', 'ui-key-revoke': 'KEY-03',
  'missing-key': 'ROUTE-06', 'invalid-key': 'ROUTE-06', 'revoked-key': 'ROUTE-06',
  'unknown-route': 'ROUTE-06', 'owned-remove': 'LIFE-06',
  'model-form-defaults': 'UX-02', 'final-idle': 'HAR-03',
} as const;
export const phase1FixtureVariants = {
  'failed-status': 'NAV-06', 'unknown-memory': 'NAV-06', 'inert-log-output': 'LOG-06',
  'navigation-browser': 'NAV-03', 'logout-browser': 'AUTH-06',
  'keys-browser-create': 'KEY-01', 'keys-browser-revoke': 'KEY-03', 'forms-browser': 'UX-02',
} as const;
export const phase1FastVariants = {
  'anonymous-contract': 'AUTH-02', 'navigation-component': 'NAV-03',
  'failed-status-unit': 'NAV-06', 'unknown-memory-unit': 'NAV-06', 'status-contract': 'NAV-06',
  'lifecycle-stop-component': 'LIFE-03', 'lifecycle-start-component': 'LIFE-04',
  'create-contract': 'LIFE-01', 'stop-contract': 'LIFE-03', 'start-contract': 'LIFE-04',
  'remove-contract': 'LIFE-06', 'key-create-component': 'KEY-01', 'key-revoke-component': 'KEY-03',
  'key-create-contract': 'KEY-01', 'key-revoke-contract': 'KEY-03',
  'logs-component': 'LOG-01', 'logs-inert-component': 'LOG-06',
  'logs-contract': 'LOG-01', 'log-transport-contract': 'LOG-05', 'log-sanitization-contract': 'LOG-06',
  'forms-component': 'UX-02',
} as const;
export const phase1Variants = {...phase1LiveVariants, ...phase1FixtureVariants, ...phase1FastVariants} as const;
export type Phase1Variant = keyof typeof phase1Variants;
export const phase1Ids = [...new Set(Object.values(phase1Variants))];

export function requirePhase1Profile(config: LabConfig) { requirePhase0Profile(config); }

/** Finite, reviewable Test-ID × parameter variant × layer acceptance matrix. */
const apiOnly = new Set(['anonymous-api', 'text-log-transport', 'stopped-route', 'missing-key', 'invalid-key',
  'revoked-key', 'unknown-route', 'final-idle']);
const contractVariants = new Set(Object.keys(phase1FastVariants).filter(variant => variant.endsWith('contract')));
export const phase1Requirements = Object.entries(phase1Variants).flatMap(([variant, id]) => {
  const layers: TestLayer[] = Object.hasOwn(phase1FixtureVariants, variant) ? ['B'] :
    Object.hasOwn(phase1FastVariants, variant) ? [contractVariants.has(variant) ? 'C' : 'U'] :
    apiOnly.has(variant) ? ['A'] : variant === 'anonymous-browser' ? ['E'] : ['A', 'E'];
  return layers.map(layer => ({id, variant: variant as Phase1Variant, layer, environment: environmentFor(layer),
    priority: 'P0' as const, phase: 1, parameterSet: 'installed-cpu-ollama-smoke' as const}));
});

export function phase1Coverage(cases: Array<{id: string; layer: string; outcome: string; variant?: string; environment?: string}>) {
  const missingLayers = phase1Requirements.filter(required => !cases.some(item => item.id === required.id &&
    item.variant === required.variant && item.layer === required.layer && item.environment === required.environment && item.outcome === 'Passed'));
  const missingFixtures = [...new Set(missingLayers.filter(item => item.environment === 'fixture').map(item => item.variant))];
  const missingVariants = [...new Set(missingLayers.filter(item => item.environment === 'live').map(item => item.variant))];
  return {missingFixtures, missingVariants, complete: cases.length > 0 && cases.every(item => item.outcome === 'Passed') &&
    missingLayers.length === 0, missingLayers};
}
