import {describe, expect, it} from 'vitest';
import type {DashboardSnapshot} from './snapshot';
import {
  availableTabs,
  buildLocalModelPayload,
  moveSelection,
  moveTab,
  osc52ClipboardSequence,
  renderTui,
  selectableCount,
  splitTerminalInput,
  tabLines,
} from './tui';

const snapshot = (roles = ['magicstick-admin']): DashboardSnapshot => ({
  session: {subject: '1', username: 'tova', roles, identityManagementAvailable: true, identityManagementMode: 'keycloak'},
  appliance: {metadata: {name: 'local'}, status: {phase: 'Ready'}},
  modules: {
    modules: {litellm: {enabled: true, displayName: 'LiteLLM', activationMode: 'moduleactivation', status: {phase: 'Ready'}}},
    catalogJson: {modules: {litellm: {displayName: 'LiteLLM', activationMode: 'moduleactivation', order: 10}}},
  },
  instances: {instances: {hermes: [{metadata: {name: 'default'}, status: {phase: 'Ready'}}]}},
  models: {
    models: [{name: 'qwen'}], activations: [{metadata: {name: 'qwen-local'}, spec: {type: 'local', local: {engine: 'VLLM', computeTarget: 'cpu'}}, status: {phase: 'Ready'}}], presets: {},
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

  it('selects mutable rows without wrapping past either end', () => {
    expect(selectableCount('Services', snapshot())).toBe(1);
    expect(selectableCount('Models', snapshot())).toBe(1);
    expect(moveSelection(0, -1, 4)).toBe(0);
    expect(moveSelection(3, 1, 4)).toBe(3);
    expect(renderTui(snapshot(), 1, 120, 30, false, {selectionIndex: 0})).toContain('› ● LiteLLM');
    expect(renderTui(snapshot(), 1, 120, 30, false, {selectionIndex: 0})).toContain('a: enable · d: disable');
  });

  it('builds CPU and GPU local-model reservations with the API contract', () => {
    const base = {
      name: 'qwen', modelType: 'chat', engine: 'VLLM', reference: 'hf://Qwen/Qwen3.5-9B',
      contextWindow: 32768, maxNumSeqs: 1, reservationMi: 12300,
    };
    expect(buildLocalModelPayload({...base, computeTarget: 'cpu'}, {id: 'cpu', kind: 'cpu'})).toMatchObject({
      name: 'qwen', local: {memoryRequiredMi: 12300, computeTarget: 'cpu', url: base.reference},
    });
    expect(buildLocalModelPayload({...base, computeTarget: 'nvidia-gpu'}, {id: 'nvidia-gpu', kind: 'gpu'})).toMatchObject({
      name: 'qwen', local: {vram: '12300Mi', computeTarget: 'nvidia-gpu', url: base.reference},
    });
  });

  it('encodes clipboard content with OSC 52 instead of invoking a platform command', () => {
    expect(osc52ClipboardSequence('secret')).toBe('\x1b]52;c;c2VjcmV0\x07');
  });

  it('handles multiple navigation keys delivered in one raw terminal chunk', () => {
    expect(splitTerminalInput('jja')).toEqual(['j', 'j', 'a']);
    expect(splitTerminalInput('\x1b[B\x1b[C')).toEqual(['\x1b[B', '\x1b[C']);
    expect(splitTerminalInput('ä')).toEqual(['ä']);
  });

  it('never renders form secrets as plaintext', () => {
    const rendered = renderTui(snapshot(), 4, 120, 30, false, {overlay: {
      kind: 'form', title: 'Create user', fields: [
        {id: 'password', label: 'Temporary password', value: 'not-for-display', kind: 'secret'},
      ], active: 0, submitLabel: 'create', onSubmit: async () => undefined,
    }});
    expect(rendered).toContain('•••••••••••••••');
    expect(rendered).not.toContain('not-for-display');
  });
});
