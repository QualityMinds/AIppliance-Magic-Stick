import {MagicStickApi} from '@magicstick/dashboard-api-client';
import type {Runtime} from './runtime';
import type {DashboardSnapshot} from './snapshot';

// Synthetic preview data only: never used as a live catalog or runtime CR seed.
const demoSnapshot = (): DashboardSnapshot => ({
  session: {subject: 'demo', username: 'demo', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'demo'},
  appliance: {metadata: {name: 'demo'}, status: {phase: 'Ready'}},
  modules: {
    modules: {
      litellm: {displayName: 'LiteLLM', enabled: true, activationMode: 'moduleactivation', status: {phase: 'Ready'}},
      kubeai: {displayName: 'KubeAI', enabled: true, activationMode: 'moduleactivation', status: {phase: 'Ready'}},
      hermes: {displayName: 'Hermes', enabled: true, activationMode: 'moduleactivation', status: {phase: 'Ready'}},
      paperclip: {displayName: 'Paperclip', enabled: false, activationMode: 'moduleactivation', status: {phase: 'Disabled'}},
      gateway: {displayName: 'Gateway', enabled: true, activationMode: 'static', status: {phase: 'Ready'}},
    },
    catalogJson: {
      modules: {
        litellm: {displayName: 'LiteLLM', group: 'runtime', order: 10, activationMode: 'moduleactivation', description: 'OpenAI-compatible API for all models.'},
        kubeai: {displayName: 'KubeAI', group: 'runtime', order: 20, activationMode: 'moduleactivation', description: 'Local model serving.'},
        hermes: {displayName: 'Hermes', group: 'apps', order: 30, activationMode: 'moduleactivation'},
        paperclip: {displayName: 'Paperclip', group: 'apps', order: 40, activationMode: 'moduleactivation'},
        gateway: {displayName: 'Gateway', group: 'platform', order: 50, activationMode: 'static', description: 'Routes for dashboards and applications.'},
      },
      applications: {
        hermes: {displayName: 'Hermes', requiredModules: ['hermes', 'litellm']},
        paperclip: {displayName: 'Paperclip', requiredModules: ['paperclip', 'litellm']},
      },
    },
  },
  instances: {instances: {hermes: [{metadata: {name: 'demo'}, status: {phase: 'Ready', url: 'https://demo.hermes.example.com'}}]}},
  models: {
    models: [{id: 'demo-chat', name: 'demo-chat', type: 'chat'}], presets: {},
    activations: [{metadata: {name: 'demo-chat'}, spec: {type: 'local', local: {engine: 'VLLM', computeTarget: 'cpu'}}, status: {phase: 'Ready'}}],
    computeTargets: {default: 'cpu', targets: [{id: 'cpu', kind: 'cpu', available: true, engines: ['VLLM']}]},
    computeMemory: {devices: [{id: 'cpu', name: 'Demo CPU', kind: 'cpu', computeTarget: 'cpu', totalMi: 32768, freeMi: 24576, unreservedMi: 24576}]},
  },
  settings: {publicDomain: 'example.com', dashboardHost: 'dashboard.example.com', mdnsDomain: 'example.local', mdnsName: 'example'},
  users: {users: [{id: 'demo', username: 'demo', enabled: true, effectiveAccessLevel: 'admin', provider: 'demo'}], total: 1, first: 0, max: 25},
  apiAccess: {items: [], total: 0, apiBases: [{scope: 'OpenAI', url: 'https://api.example.com/v1'}]},
  license: {edition: 'free', state: 'missing', valid: false, message: 'Free mode. Offline preview only.', installationId: 'demo', revision: '0', checkedAt: 0, hasDocument: false, trustedKeyIds: [], features: []},
  consoleAccess: {available: true, accessLevel: 'off'},
  kubernetesAccess: {users: [{id: 'demo', username: 'demo', enabled: true, accessLevel: 'admin', provider: 'demo'}], total: 1, first: 0, max: 100, configuration: {configured: true}},
  status: {hardwareOperators: {
    cpu: {displayName: 'Demo hardware discovery', operatorActive: true, phase: 'Ready'},
    gpu: {displayName: 'Demo GPU operator', operatorActive: false, phase: 'Disabled'},
  }},
  // Pages that load their own data (System → Settings → Network/Updates, Hardware, Power,
  // Model cache, Regression tests, Mesh, Federated SSO) show these synthetic states.
  hosts: {nodes: [{
    name: 'demo-node', nodeUid: 'demo-node-uid', bootId: 'demo-boot', kernel: '6.8.0-demo', available: true, message: 'Synthetic host for the offline preview.',
    plan: {id: 'demo-plan', state: 'not-required', message: 'No hardware preparation is needed.', profileId: '', profileVersion: '', gpuProfile: '', experimental: false, packages: {}, targetKernel: '6.8.0-demo', rebootRequired: false},
    gpuMemory: {id: 'demo-memory', supported: false, message: 'No shared-memory GPU in the preview.'},
    network: {id: 'demo-network', supported: true, message: '', interfaces: [
      {name: 'eno1', kind: 'ethernet', mac: '02:00:00:00:00:01', state: 'UP', addresses: ['192.0.2.10/24'], gateway: '192.0.2.1', editable: true, scanSupported: false, clusterAddresses: [], configuredMode: 'dhcp', metric: 100},
      {name: 'wlan0', kind: 'wifi', mac: '02:00:00:00:00:02', state: 'DOWN', addresses: [], editable: true, scanSupported: true, clusterAddresses: [], configuredMode: 'dhcp', metric: 600},
    ]},
    updates: {supported: true, id: 'demo-updates', policy: {mode: 'security', windowStart: '02:00', windowMinutes: 120, automaticReboot: false}, busy: false, rebootRequired: false, phase: 'Ready', pendingCount: 0, securityCount: 0, blockedCount: 0, packages: []},
    modelCache: {supported: true, blocked: true, id: 'demo-cache', message: 'Stop local models before clearing the cache.', totalBytes: 512 * 1024 ** 3, freeBytes: 384 * 1024 ** 3, reclaimableBytes: 8 * 1024 ** 3,
      caches: [{id: 'huggingface', name: 'Hugging Face', usedBytes: 8 * 1024 ** 3, clearable: true}, {id: 'ollama', name: 'Ollama', usedBytes: 0, clearable: true}]},
    software: {supported: true, releaseCatalogVersion: 1, id: 'demo-software', channel: {kind: 'tag', value: 'v1.0.0'}, hostCommit: '0000000000000000000000000000000000000000', busy: false, blocked: false},
  }]},
  gpuSharing: {providers: []},
  mesh: {installed: true, configured: false, phase: 'disconnected', models: ['demo-chat']},
  federatedSso: {
    feature: {id: 'federated-sso', name: 'Federated SSO', licensed: false, implemented: true, available: false, reason: 'not_licensed'},
    issuer: 'https://id.example.com/realms/magicstick', callbackUrl: 'https://id.example.com/realms/magicstick/broker/{alias}/endpoint', providers: [],
  },
  regression: {registered: false, applianceUid: 'demo', runtimeAvailable: false, sourceRevision: '0000000000000000000000000000000000000000',
    message: 'The regression runner is not enabled in the offline preview.', runs: [], executionLocation: 'appliance-kubernetes', externalRunnerRequired: []},
  softwareReleases: {releases: [{version: 'v1.0.0', releaseId: 1, url: 'https://example.com/releases/v1.0.0', publishedAt: '2026-01-01T00:00:00Z', prerelease: false, selectable: true}], fetchedAt: '2026-01-01T00:00:00Z', stale: false},
  loadedAt: 0,
});

export const createDemoRuntime = (): Runtime => {
  const snapshot = demoSnapshot();
  const responses = new Map<string, unknown>([
    ['/api/session', snapshot.session], ['/api/appliance', snapshot.appliance],
    ['/api/modules', snapshot.modules], ['/api/instances', snapshot.instances],
    ['/api/models', snapshot.models], ['/api/settings', snapshot.settings],
    ['/api/users', snapshot.users], ['/api/api-access', snapshot.apiAccess],
    ['/api/kubernetes-access', snapshot.kubernetesAccess], ['/api/status', snapshot.status], ['/api/license', snapshot.license],
    ['/api/console-access', snapshot.consoleAccess], ['/api/host-management', snapshot.hosts], ['/api/hardware/gpu-sharing', snapshot.gpuSharing], ['/api/mesh', snapshot.mesh],
    ['/api/federated-sso', snapshot.federatedSso], ['/api/regression', snapshot.regression], ['/api/software/releases', snapshot.softwareReleases],
  ]);
  const unavailable = async () => { throw new Error('Offline demo is read-only; no login, logout, or live actions are available.'); };
  return {
    // This transport never delegates to fetch or reads saved credentials/config.
    api: new MagicStickApi({fetch: async (input, init) => {
      const path = String(input).split('?')[0] ?? '';
      if (init?.method !== 'GET' || !responses.has(path)) {
        return Response.json({message: 'Offline demo is read-only; this action is unavailable.'}, {status: 403});
      }
      return Response.json(responses.get(path));
    }}),
    settings: {apiUrl: '', issuer: '', clientId: ''},
    login: unavailable,
    logout: unavailable,
    sessionKind: () => 'none',
    localConsole: false,
  };
};
