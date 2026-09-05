import {MagicStickApi} from '@magicstick/dashboard-api-client';
import type {Runtime} from './runtime';
import type {DashboardSnapshot} from './snapshot';

// Synthetic preview data only: never used as a live catalog or runtime CR seed.
const demoSnapshot = (): DashboardSnapshot => ({
  session: {subject: 'demo', username: 'demo', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'demo'},
  appliance: {metadata: {name: 'demo'}, status: {phase: 'Ready'}},
  modules: {
    modules: {
      litellm: {displayName: 'LiteLLM', enabled: true, status: {phase: 'Ready'}},
      kubeai: {displayName: 'KubeAI', enabled: true, status: {phase: 'Ready'}},
      hermes: {displayName: 'Hermes', enabled: true, status: {phase: 'Ready'}},
      paperclip: {displayName: 'Paperclip', enabled: false, status: {phase: 'Disabled'}},
    },
  },
  instances: {instances: {hermes: [{metadata: {name: 'demo'}, status: {phase: 'Ready'}}]}},
  models: {
    models: [{name: 'demo-chat'}], presets: {},
    activations: [{metadata: {name: 'demo-chat'}, spec: {type: 'local', local: {engine: 'VLLM', computeTarget: 'cpu'}}, status: {phase: 'Ready'}}],
    computeTargets: {default: 'cpu', targets: [{id: 'cpu', kind: 'cpu', available: true, engines: ['VLLM']}]},
    computeMemory: {devices: [{id: 'cpu', name: 'Demo CPU', totalMi: 32768, freeMi: 24576, unreservedMi: 24576}]},
  },
  settings: {publicDomain: 'example.com', dashboardHost: 'dashboard.example.com', mdnsDomain: 'example.local', mdnsName: 'example'},
  users: {users: [{id: 'demo', username: 'demo', enabled: true, effectiveAccessLevel: 'admin', provider: 'demo'}], total: 1, first: 0, max: 25},
  apiAccess: {items: [], total: 0, apiBases: [{scope: 'OpenAI', url: 'https://api.example.com/v1'}]},
  kubernetesAccess: {users: [{id: 'demo', username: 'demo', enabled: true, accessLevel: 'admin', provider: 'demo'}], total: 1, first: 0, max: 100, configuration: {configured: true}},
  status: {hardwareOperators: {
    cpu: {displayName: 'Demo hardware discovery', operatorActive: true, phase: 'Ready'},
    gpu: {displayName: 'Demo GPU operator', operatorActive: false, phase: 'Disabled'},
  }},
  loadedAt: 0,
});

export const createDemoRuntime = (): Runtime => {
  const snapshot = demoSnapshot();
  const responses = new Map<string, unknown>([
    ['/api/session', snapshot.session], ['/api/appliance', snapshot.appliance],
    ['/api/modules', snapshot.modules], ['/api/instances', snapshot.instances],
    ['/api/models', snapshot.models], ['/api/settings', snapshot.settings],
    ['/api/users', snapshot.users], ['/api/api-access', snapshot.apiAccess],
    ['/api/kubernetes-access', snapshot.kubernetesAccess], ['/api/status', snapshot.status],
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
  };
};