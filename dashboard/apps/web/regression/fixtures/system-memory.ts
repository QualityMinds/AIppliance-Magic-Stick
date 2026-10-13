import type {SystemMemoryEstimate} from '@magicstick/dashboard-contracts';

/** Synthetic display/interaction data, not a hardware or model-fit measurement. */
export const systemMemoryFixture = (overrides: Partial<SystemMemoryEstimate> = {}): SystemMemoryEstimate => ({
  scope: 'per-pod', replicaCount: 1, workerCount: 2,
  minimumMi: 6000, recommendedMi: 18000, runningMinimumMi: 5000, runningRecommendedMi: 6000,
  startupMinimumMi: 6000, startupUpperMi: 16000, maximumMi: 32000, totalRecommendedMi: 18000,
  weightsOnCpuMi: 0, cacheOnCpuMi: 0, hostRuntimeMi: 4900, multimodalCacheMi: 0, promptBuffersMi: 100,
  loadingBuffersMi: 1000, fileCacheUpperMi: 11000, confidence: 'estimated',
  calculations: {recommendedMi: {formula: 'synthetic startup envelope + headroom', substitution: '18,000 MiB'}},
  warnings: ['Synthetic startup envelope; not measured RSS or a model-fit guarantee.'],
  ...overrides,
});
