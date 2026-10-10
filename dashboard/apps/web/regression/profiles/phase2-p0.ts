import type {LabConfig} from '../core/config.ts';
import {environmentFor, type TestLayer} from '../core/evidence.ts';
import {requireSafe} from '../core/errors.ts';
import {requirePhase1Profile} from './phase1-p0.ts';

type VariantDefinition = {id: string; layers: readonly TestLayer[]};

/**
 * Phase 2 is the finite CPU model-control profile. GPU binding and
 * provider sharing remain Phase 3/4 even when their fast contracts are covered
 * by the repository's ordinary test suites.
 */
export const phase2FastVariants = {
  'model-task-component': {id: 'DISC-01', layers: ['U']},
  'model-task-contract': {id: 'DISC-01', layers: ['C']},
  'create-choice-component': {id: 'DISC-01', layers: ['U']},
  'create-choice-contract': {id: 'DISC-01', layers: ['C']},
  'hf-search-component': {id: 'DISC-03', layers: ['U']},
  'hf-search-contract': {id: 'DISC-03', layers: ['C']},
  'hf-policy-contract': {id: 'DISC-04', layers: ['C']},
  'local-create-contract': {id: 'LIFE-02', layers: ['C']},
  'edit-component': {id: 'LIFE-07', layers: ['U']},
  'edit-contract': {id: 'LIFE-07', layers: ['C']},
  'dirty-component': {id: 'LIFE-08', layers: ['U']},
  'conflict-contract': {id: 'LIFE-09', layers: ['C']},
  'pod-stall-contract': {id: 'LIFE-11', layers: ['C']},
  'failure-stage-contract': {id: 'LIFE-12', layers: ['C']},
  'persistence-contract': {id: 'LIFE-13', layers: ['C']},
  'engine-create-contract': {id: 'ENG-01', layers: ['C']},
  'ollama-alias-contract': {id: 'ENG-02', layers: ['C']},
  'kv-component': {id: 'ENG-03', layers: ['U']},
  'kv-contract': {id: 'ENG-03', layers: ['C']},
  'engine-switch-component': {id: 'ENG-07', layers: ['U']},
  'legacy-default-contract': {id: 'ENG-09', layers: ['C']},
  'injection-contract': {id: 'ENG-10', layers: ['C']},
  'memory-component': {id: 'MEM-01', layers: ['U']},
  'memory-contract': {id: 'MEM-01', layers: ['C']},
  'risk-component': {id: 'MEM-05', layers: ['U']},
  'risk-contract': {id: 'MEM-05', layers: ['C']},
  'slider-component': {id: 'MEM-06', layers: ['U']},
  'shared-free-contract': {id: 'MEM-07', layers: ['C']},
  'accounting-contract': {id: 'MEM-10', layers: ['C']},
  'catalog-contract': {id: 'ROUTE-02', layers: ['C']},
  'external-contract': {id: 'ROUTE-05', layers: ['C']},
  'log-stage-contract': {id: 'LOG-01', layers: ['C']},
  'pod-log-selection-contract': {id: 'LOG-04', layers: ['C']},
} as const satisfies Record<string, VariantDefinition>;

export const phase2FixtureVariants = {
  'task-chat-desktop-browser': {id: 'DISC-01', layers: ['B']},
  'task-chat-mobile-browser': {id: 'DISC-01', layers: ['B']},
  'task-embedding-desktop-browser': {id: 'DISC-01', layers: ['B']},
  'task-embedding-mobile-browser': {id: 'DISC-01', layers: ['B']},
  'task-unknown-desktop-browser': {id: 'DISC-01', layers: ['B']},
  'task-unknown-mobile-browser': {id: 'DISC-01', layers: ['B']},
  'create-choice-browser': {id: 'DISC-01', layers: ['B']},
  'hf-search-browser': {id: 'DISC-03', layers: ['B']},
  'hf-policy-browser': {id: 'DISC-04', layers: ['B']},
  'create-ollama-browser': {id: 'LIFE-02', layers: ['B']},
  'create-vllm-browser': {id: 'LIFE-02', layers: ['B']},
  'dirty-browser': {id: 'LIFE-08', layers: ['B']},
  'failure-browser': {id: 'LIFE-12', layers: ['B']},
  'engine-switch-browser': {id: 'ENG-07', layers: ['B']},
  'memory-breakdown-browser': {id: 'MEM-01', layers: ['B']},
  'risk-browser': {id: 'MEM-05', layers: ['B']},
  'slider-browser': {id: 'MEM-06', layers: ['B']},
} as const satisfies Record<string, VariantDefinition>;

export const phase2LiveVariants = {
  'create-choice-live': {id: 'DISC-01', layers: ['E']},
  'hf-search-live': {id: 'DISC-03', layers: ['A', 'E']},
  'local-create-ollama': {id: 'LIFE-02', layers: ['A', 'E']},
  'local-create-vllm': {id: 'LIFE-02', layers: ['A', 'E']},
  'edit-ollama': {id: 'LIFE-07', layers: ['A', 'E']},
  'edit-vllm': {id: 'LIFE-07', layers: ['A', 'E']},
  'dirty-ollama': {id: 'LIFE-08', layers: ['E']},
  'dirty-vllm': {id: 'LIFE-08', layers: ['E']},
  'conflict-ollama': {id: 'LIFE-09', layers: ['A', 'E']},
  'conflict-vllm': {id: 'LIFE-09', layers: ['A', 'E']},
  'failure-model': {id: 'LIFE-12', layers: ['A', 'E']},
  'persistence-ollama': {id: 'LIFE-13', layers: ['A', 'E']},
  'persistence-vllm': {id: 'LIFE-13', layers: ['A', 'E']},
  'engine-ollama': {id: 'ENG-01', layers: ['A']},
  'engine-vllm': {id: 'ENG-01', layers: ['A']},
  'alias-ollama': {id: 'ENG-02', layers: ['A']},
  'kv-ollama': {id: 'ENG-03', layers: ['A', 'E']},
  'kv-vllm': {id: 'ENG-03', layers: ['A', 'E']},
  'unsupported-request': {id: 'ENG-10', layers: ['A']},
  'memory-risk': {id: 'MEM-05', layers: ['A']},
  'slider-ollama': {id: 'MEM-06', layers: ['E']},
  'slider-vllm': {id: 'MEM-06', layers: ['E']},
  'catalog-transitions': {id: 'ROUTE-02', layers: ['A']},
  'external-route': {id: 'ROUTE-05', layers: ['A', 'E']},
  'logs-ollama': {id: 'LOG-01', layers: ['A', 'E']},
  'logs-vllm': {id: 'LOG-01', layers: ['A', 'E']},
  'live-failure-status': {id: 'NAV-06', layers: ['A']},
  'final-idle': {id: 'HAR-03', layers: ['A']},
} as const satisfies Record<string, VariantDefinition>;

/** A subset cannot require discovery/fault/final-preflight evidence it never runs. */
export const phase2ModelIds = [...new Set(Object.entries(phase2LiveVariants)
  .filter(([variant]) => !['create-choice-live', 'hf-search-live', 'failure-model', 'live-failure-status', 'final-idle'].includes(variant))
  .map(([, definition]) => definition.id))];

/** Explicit diagnostic subsets; never a replacement for the canonical gate. */
export const phase2ModelCases = {
  ollama: {grep: 'CPU Ollama$', ids: ['LIFE-02', 'LIFE-07', 'LIFE-08', 'LIFE-09', 'LIFE-13', 'ENG-01', 'ENG-02', 'ENG-03', 'MEM-06', 'ROUTE-02', 'LOG-01']},
  vllm: {grep: 'CPU vLLM$', ids: ['LIFE-02', 'LIFE-07', 'LIFE-08', 'LIFE-09', 'LIFE-13', 'ENG-01', 'ENG-03', 'MEM-06', 'LOG-01']},
  admission: {grep: 'ENG-10 unsupported target', ids: ['ENG-10']},
  'memory-risk': {grep: 'MEM-05 API requires', ids: ['MEM-05']},
  external: {grep: 'ROUTE-05 external provider', ids: ['ROUTE-05']},
} as const;

export const phase2Variants = {...phase2FastVariants, ...phase2FixtureVariants, ...phase2LiveVariants} as const;
export type Phase2Variant = keyof typeof phase2Variants;
export const phase2Ids = [...new Set(Object.values(phase2Variants).map(item => item.id))];

export function requirePhase2Profile(config: LabConfig) {
  requirePhase1Profile(config);
  const profile = config.phase2;
  requireSafe(Boolean(profile?.ollamaModel && profile.vllmModel && profile.failureModel && profile.externalModel &&
    profile.discovery && profile.ollamaModel.kvCacheType && profile.vllmModel.kvCacheType &&
    profile.ollamaModel.contextWindow <= 4096 && profile.vllmModel.contextWindow <= 4096 &&
    profile.failureModel.contextWindow <= 4096 && profile.failureModel.memoryRequiredMi <= 8192 &&
    profile.ollamaModel.memoryRequiredMi % 100 === 0 && profile.vllmModel.memoryRequiredMi % 100 === 0 &&
    (profile.discovery.artifactUrl === `hf://${profile.discovery.repo}` ||
      profile.discovery.artifactUrl.startsWith(`hf://${profile.discovery.repo}/`))), 'CONFIG');
}

export const phase2Requirements = Object.entries(phase2Variants).flatMap(([variant, definition]) =>
  definition.layers.map(layer => ({id: definition.id, variant: variant as Phase2Variant, layer,
    environment: environmentFor(layer), priority: 'P0' as const, phase: 2,
    parameterSet: 'installed-cpu-model-control' as const})));

export function phase2Coverage(cases: Array<{id: string; layer: string; outcome: string; variant?: string; environment?: string}>) {
  const missingLayers = phase2Requirements.filter(required => !cases.some(item => item.id === required.id &&
    item.variant === required.variant && item.layer === required.layer && item.environment === required.environment && item.outcome === 'Passed'));
  const missingFixtures = [...new Set(missingLayers.filter(item => item.environment === 'fixture').map(item => item.variant))];
  const missingVariants = [...new Set(missingLayers.filter(item => item.environment === 'live').map(item => item.variant))];
  return {missingFixtures, missingVariants, complete: cases.length > 0 && cases.every(item => item.outcome === 'Passed') &&
    missingLayers.length === 0, missingLayers};
}
