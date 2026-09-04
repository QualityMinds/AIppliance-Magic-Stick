import {describe, expect, it} from 'vitest';
import type {DashboardSnapshot} from './snapshot';
import {availableTabs, moveTab, renderTui, tabLines} from './tui';

const snapshot = (roles = ['magicstick-admin']): DashboardSnapshot => ({
  session: {subject: '1', username: 'tova', roles, identityManagementAvailable: true, identityManagementMode: 'keycloak'},
  appliance: {metadata: {name: 'local'}, status: {phase: 'Ready'}},
  modules: {modules: {litellm: {enabled: true, displayName: 'LiteLLM', status: {phase: 'Ready'}}}},
  instances: {instances: {hermes: [{metadata: {name: 'default'}, status: {phase: 'Ready'}}]}},
  models: {
    models: [{name: 'qwen'}], activations: [], presets: {},
    computeTargets: {default: 'cpu', targets: [{id: 'cpu', available: true, engines: ['VLLM']}]},
    computeMemory: {devices: [{id: 'cpu', name: 'CPU', totalMi: 65536, unreservedMi: 60000, freeMi: 50000}]},
  },
  settings: {publicDomain: 'magicstick.example.com', dashboardHost: 'magicstick.example.com', mdnsDomain: 'magicstick.local', mdnsName: 'magicstick'},
  status: {hardwareOperators: {gpu: {displayName: 'NVIDIA GPU Operator', operatorActive: false, phase: 'Disabled'}}},
  users: {users: [{id: '1', username: 'tova', enabled: true, effectiveAccessLevel: 'admin'}], total: 1, first: 0, max: 25},
  apiAccess: {items: [{id: '1', name: 'automation', keyHint: 'sk-…', status: 'active'}], total: 1, apiBases: [{scope: 'OpenAI', url: 'https://litellm.magicstick.local/v1'}]},
  kubernetesAccess: {users: [{id: '1', username: 'tova', enabled: true, accessLevel: 'admin'}], total: 1, first: 0, max: 100, configuration: {configured: true}},
  loadedAt: Date.now(),
});

describe('terminal dashboard', () => {
  it('exposes the same administrative areas to administrators', () => {
    expect(availableTabs(snapshot())).toEqual(['Overview', 'Services', 'Models', 'Settings', 'Users', 'API Access', 'Kubernetes', 'System']);
    expect(tabLines('Models', snapshot()).join('\n')).toContain('CPU: 49 GiB free');
    expect(renderTui(snapshot(), 0, 100, 30, false)).toContain('signed in: tova · admin');
  });

  it('hides administrative areas from viewers', () => {
    expect(availableTabs(snapshot(['magicstick-viewer']))).toEqual(['Overview', 'Services', 'Models', 'System']);
  });

  it('wraps page navigation in both directions', () => {
    expect(moveTab(0, -1, 4)).toBe(3);
    expect(moveTab(3, 1, 4)).toBe(0);
  });
});
