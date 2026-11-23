// Synthetic Models data for the terminal tests (example.com only, no real deployment values).
import type {DashboardSnapshot} from './snapshot';

export const modelFixture = (roles = ['magicstick-admin']): DashboardSnapshot => ({
  session: {subject: '1', username: 'tova', roles, identityManagementAvailable: true, identityManagementMode: 'keycloak'},
  appliance: {metadata: {name: 'local'}, status: {phase: 'Ready'}},
  modules: {modules: {}, catalogJson: {modules: {}}},
  instances: {instances: {}},
  status: {},
  models: {
    models: [{id: 'chat-local', type: 'chat'}, {id: 'provider-model', type: 'chat', modelRef: 'openai/gpt-4o-mini', provider: 'openai'}],
    presets: {
      'qwen-small': {displayName: 'Qwen small', type: 'chat', variants: [{engine: 'VLLM', computeTarget: 'cpu', url: 'hf://example/qwen-small', contextWindow: 8192, maxNumSeqs: 2,
        artifacts: [{id: 'bf16', title: 'BF16', url: 'hf://example/qwen-small'}, {id: 'awq', title: 'AWQ 4-bit', url: 'hf://example/qwen-small-awq'}]}]},
    },
    activations: [
      {metadata: {name: 'chat-local', uid: 'uid-1', generation: 3}, spec: {type: 'local', enabled: true, targetNamespace: 'ai',
        local: {engine: 'VLLM', computeTarget: 'cpu', modelType: 'chat', url: 'hf://example/chat', kvCacheType: 'auto', memoryRequiredMi: 8000, contextWindow: 4096, maxNumSeqs: 1}},
      status: {phase: 'Ready', requestedKvCacheType: 'auto', effectiveKvCacheType: 'auto', memoryRequiredMi: 8000, artifact: 'bf16', format: 'safetensors', modelRef: 'hosted_vllm/chat-local'}},
      {metadata: {name: 'split-gpu', uid: 'uid-2', generation: 1}, spec: {type: 'local', enabled: true,
        local: {engine: 'VLLM', computeTarget: 'nvidia-gpu', modelType: 'chat', url: 'hf://example/big', vram: '20000Mi', memoryRequiredMi: 16000, cpuOffloading: true, gpuDeployment: 'split',
          gpuDevices: [{nodeName: 'node-a', nodeUid: 'n1', uuid: 'GPU-1'}, {nodeName: 'node-a', nodeUid: 'n1', uuid: 'GPU-2'}], vllm: {parallelism: 'tensor'}}},
      status: {phase: 'Pending', message: 'Waiting for GPU slots.', gpuSharing: {mode: 'time-slicing', node: 'node-a', device: 'GPU-1'}}},
      {metadata: {name: 'remote', uid: 'uid-3', generation: 1}, spec: {type: 'external', enabled: false, external: {model: 'openai/gpt-4o-mini', modelType: 'chat', contextWindow: 128000}}, status: {phase: 'Disabled'}},
    ],
    computeTargets: {default: 'cpu', defaultEngine: 'VLLM',
      engineCatalog: {VLLM: {displayName: 'vLLM', cpuDefaults: {cpu: {requestMillicores: 2000, limitMillicores: 0}, gpu: {requestMillicores: 4000, limitMillicores: 0}},
        multiGpu: {computeTargets: ['nvidia-gpu'], maxDevices: 4, strategies: ['tensor', 'pipeline'], memoryBudgetScope: 'per-device', deploymentModes: ['single', 'split', 'replicated']}},
      OLlama: {displayName: 'Ollama', urlScheme: 'ollama://'}},
      targets: [
        {id: 'cpu', kind: 'cpu', displayName: 'CPU', available: true, engines: ['VLLM', 'OLlama'], kvCacheTypes: {VLLM: [{value: 'auto', label: 'Standard - model precision', description: 'Model precision.'}, {value: 'fp8', label: 'FP8', description: 'Half the cache.'}]}},
        {id: 'nvidia-gpu', kind: 'gpu', displayName: 'NVIDIA GPU', available: true, engines: ['VLLM', 'OLlama'], slots: {total: 4, used: 1, free: 3}},
      ]},
    computeMemory: {devices: [
      {id: 'cpu', name: 'CPU', kind: 'cpu', computeTarget: 'cpu', totalMi: 65536, unreservedMi: 50000, freeMi: 40000},
      {id: 'gpu-1', name: 'Example GPU 1', kind: 'gpu', computeTarget: 'nvidia-gpu', totalMi: 24576, unreservedMi: 20000, freeMi: null, metricsAvailable: false,
        gpuDevice: {nodeName: 'node-a', nodeUid: 'n1', uuid: 'GPU-1'}, slots: {total: 2, used: 1, free: 1, scope: 'device'}},
      {id: 'gpu-2', name: 'Example GPU 2', kind: 'gpu', computeTarget: 'nvidia-gpu', totalMi: 24576, unreservedMi: 24576, freeMi: 24000,
        gpuDevice: {nodeName: 'node-a', nodeUid: 'n1', uuid: 'GPU-2'}, slots: {total: 2, used: 0, free: 2, scope: 'device'}},
    ]},
    modules: {gpu: {enabled: true, autoEnabled: true}},
  },
  loadedAt: Date.now(),
});
