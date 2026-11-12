import {describe, expect, it} from 'vitest';
import type {DashboardSnapshot} from './snapshot';
import {BANNER_HEIGHT, bannerFits} from './banner';
import {
  availablePages,
  availableSystemSections,
  buildLocalModelPayload,
  composeTui,
  initialViewState,
  MAX_CONTENT_COLUMNS,
  moveFocus,
  moveSelection,
  moveTab,
  osc52ClipboardSequence,
  parseMouse,
  renderTui,
  splitTerminalInput,
  type TuiViewState,
} from './tui';
import {hitTarget} from './tui-screen';

const snapshot = (roles = ['magicstick-admin']): DashboardSnapshot => ({
  session: {subject: '1', username: 'tova', roles, identityManagementAvailable: true, identityManagementMode: 'keycloak'},
  appliance: {metadata: {name: 'local'}, status: {phase: 'Ready'}},
  modules: {
    modules: {litellm: {enabled: true, displayName: 'LiteLLM', activationMode: 'moduleactivation', status: {phase: 'Ready'}}},
    catalogJson: {modules: {litellm: {displayName: 'LiteLLM', activationMode: 'moduleactivation', order: 10}}},
  },
  instances: {instances: {hermes: [{metadata: {name: 'default'}, status: {phase: 'Ready'}}]}},
  models: {
    models: [{name: 'qwen'}], activations: [{metadata: {name: 'qwen-local'}, spec: {type: 'local', local: {engine: 'VLLM', computeTarget: 'cpu', kvCacheType: 'auto'}}, status: {phase: 'Ready', requestedKvCacheType: 'auto', effectiveKvCacheType: 'auto'}}], presets: {},
    computeTargets: {default: 'cpu', targets: [{id: 'cpu', available: true, engines: ['VLLM'], kvCacheTypes: {VLLM: [{value: 'auto', label: 'Standard - model precision'}]}}]},
    computeMemory: {devices: [{id: 'cpu', name: 'CPU', totalMi: 65536, unreservedMi: 60000, freeMi: 50000}]},
  },
  settings: {publicDomain: 'magicstick.example.com', dashboardHost: 'magicstick.example.com', mdnsDomain: 'magicstick.local', mdnsName: 'magicstick'},
  status: {hardwareOperators: {gpu: {displayName: 'NVIDIA GPU Operator', operatorActive: false, phase: 'Disabled'}}},
  users: {users: [{id: '1', username: 'tova', enabled: true, effectiveAccessLevel: 'admin'}], total: 1, first: 0, max: 25},
  apiAccess: {items: [{id: '1', name: 'automation', keyHint: 'sk-…', status: 'active'}], total: 1, apiBases: [{scope: 'OpenAI', url: 'https://litellm.magicstick.local/v1'}]},
  kubernetesAccess: {users: [{id: '1', username: 'tova', enabled: true, accessLevel: 'admin'}], total: 1, first: 0, max: 100, configuration: {configured: true}},
  loadedAt: Date.now(),
});

const layoutOf = (state: Partial<TuiViewState>, data = snapshot(), width = 121, height = 40) => composeTui(data, initialViewState(state), width, height, false);
const withFocus = (layout: ReturnType<typeof composeTui>, state: Partial<TuiViewState>, moved: ReturnType<typeof moveFocus>) =>
  layoutOf({...state, focusId: moved.focusId, scrollTop: moved.scrollTop, page: moved.focusId?.startsWith('nav:') ? moved.focusId.slice(4) as TuiViewState['page'] : state.page ?? layout.page});

describe('terminal dashboard', () => {
  it('keeps branding on the spacecraft and session details below the banner', () => {
    const lines = renderTui(snapshot(), {}, 100, 30, false).split('\n');
    expect(lines[BANNER_HEIGHT]).toContain('Signed in: tova · admin');
    expect(lines[2]).toContain('AIppliance');
    expect(lines[3]).toContain('Magic Stick');
    expect(lines.slice(BANNER_HEIGHT).join('\n')).not.toMatch(/AIppliance|Magic Stick/);
    expect(lines.join('\n')).not.toMatch(/b:|pause|animate/);
    expect(lines.join('\n')).not.toContain('\x1b');
  });

  it('lays the screen out like the browser dashboard: header, page list, page and hotkey bar', () => {
    const lines = renderTui(snapshot(), {page: 'services'}, 121, 40, false).split('\n').slice(BANNER_HEIGHT);
    expect(lines[0]).toContain('AI Appliance Dashboard');
    expect(lines[0]).toContain('● Connected');
    expect(lines[1]).toMatch(/^┌─+┬─+┐$/);
    expect(lines[2]).toMatch(/^│.Overview +│ Services/);
    expect(lines.join('\n')).toContain('▌Services');
    expect(lines.join('\n')).toContain('[■ All ]  [ Applications ]  [ AI Runtime ]  [ Platform ]');
    expect(lines.at(-2)).toMatch(/^└─+┴─+┘$/);
    expect(lines.at(-1)).toContain('↑↓←→ Move  Tab Next  Enter Open page  f Filter  1-7 Page  r Reload  x Sign out  ? Help  q Quit');
    expect(lines.every((line) => line.length <= MAX_CONTENT_COLUMNS)).toBe(true);
  });

  it('offers the same pages and System sections as the browser, by role', () => {
    expect(availablePages(snapshot()).map((page) => page.label)).toEqual(['Overview', 'Models', 'Services', 'API Access', 'Mesh', 'Kubernetes Access', 'System']);
    expect(availableSystemSections(snapshot()).map((section) => section.label)).toEqual(['Settings', 'License', 'Users', 'Hardware', 'System Status', 'Computer power']);
    const viewer = snapshot(['magicstick-viewer']);
    expect(availablePages(viewer).map((page) => page.id)).toEqual(['overview', 'models', 'services', 'system']);
    expect(availableSystemSections(viewer).map((section) => section.id)).toEqual(['hardware', 'status']);
    // A page the role may not open falls back instead of rendering administrative content.
    expect(renderTui(viewer, {page: 'api-access'}, 121, 40, false)).toContain('Live state from the shared appliance control plane.');
    expect(renderTui(viewer, {page: 'system', systemSection: 'users'}, 121, 40, false)).toContain('[■ System Status ]');
  });

  it('labels the automatic monitor session and offers switching users instead of signing out', () => {
    const automatic = snapshot();
    automatic.session = {...automatic.session, username: 'service-account-magicstick-console', localConsole: true};
    const screen = renderTui(automatic, {localConsole: true}, 121, 30, false);
    expect(screen).toContain('Signed in: Local console · admin · automatic');
    expect(screen).not.toContain('service-account');
    expect(screen).toContain('[ Switch user ]');
    expect(screen).toContain('x Switch user');
    expect(screen).not.toContain('Sign out');

    const workstation = renderTui(snapshot(), {}, 121, 30, false);
    expect(workstation).toContain('[ Sign out ]');
    expect(workstation).toContain('x Sign out');
    expect(workstation).not.toContain('automatic');
  });

  it('shows the monitor sign-in level in Settings only when the appliance reports it', () => {
    const settings = (data: DashboardSnapshot) => renderTui(data, {page: 'system', systemSection: 'settings'}, 121, 40, false);
    const configured = settings({...snapshot(), consoleAccess: {available: true, accessLevel: 'admin' as const}});
    expect(configured).toContain('Automatic sign-in  Administrator');
    expect(configured).toContain('without a password');
    expect(configured).toContain('[ Change ]');
    expect(configured).toContain('e Monitor sign-in');

    const off = settings({...snapshot(), consoleAccess: {available: true, accessLevel: 'off' as const}});
    expect(off).toContain('Off — sign-in required');
    expect(off).not.toContain('without a password');
    const unprovisioned = settings({...snapshot(), consoleAccess: {available: false, accessLevel: 'off' as const}});
    expect(unprovisioned).toContain('Not provisioned');
    expect(unprovisioned).not.toContain('[ Change ]');
    expect(settings(snapshot())).not.toContain('Automatic sign-in');
  });

  it('caps the banner and the frame at the designed width on wide terminals', () => {
    const lines = renderTui(snapshot(), {}, 250, 40, false).split('\n');
    const bannerWidths = lines.slice(0, BANNER_HEIGHT).map((line) => line.length);
    expect(Math.max(...bannerWidths)).toBe(MAX_CONTENT_COLUMNS);
    expect(lines[BANNER_HEIGHT + 1]).toHaveLength(MAX_CONTENT_COLUMNS);
  });

  it.each([[121, 40], [120, 36], [100, 30], [80, 24], [50, 19], [40, 12]])('stays inside a %i by %i screen', (width, height) => {
    const plain = renderTui(snapshot(), {page: 'system'}, width, height, true).replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain.split('\n').length).toBeLessThanOrEqual(height);
    expect(plain.split('\n').every((line) => line.length < width)).toBe(true);
    if (width >= 100) {
      expect(plain).toContain('▌System');
      expect(plain).toContain('q Quit');
    }
    if (!bannerFits(height) && width >= 80) expect(plain.split('\n')[0]).toContain('Signed in: tova');
  });

  it('shows the cursor without colours and names its action beside Enter', () => {
    const screen = renderTui(snapshot(), {page: 'models', focusId: 'model:remove:qwen-local'}, 121, 40, false);
    expect(screen).toContain('►[ Remove ]◄');
    expect(screen).toContain('Enter Remove');
    expect(renderTui(snapshot(), {page: 'models', focusId: 'model:remove:qwen-local'}, 121, 40, true)).toContain('\x1b[1;36;7m[ Remove ]');
  });

  it('moves the cursor between the page list and the page like browser focus', () => {
    const state: Partial<TuiViewState> = {page: 'services'};
    let layout = layoutOf(state);
    expect(layout.focused?.key).toBe('nav:services');

    layout = withFocus(layout, state, moveFocus(layout, 'right'));
    expect(layout.focused?.key).toBe('instance:create');
    layout = layoutOf({...state, focusId: 'filter:all'});
    layout = withFocus(layout, state, moveFocus(layout, 'right'));
    expect(layout.focused?.key).toBe('filter:applications');
    layout = withFocus(layout, state, moveFocus(layout, 'down'));
    expect(layout.focused?.key).toBe('expand:platform');
    expect(moveFocus(layout, 'down')).toEqual({focusId: 'expand:platform', scrollTop: 0});
    layout = withFocus(layout, state, moveFocus(layout, 'left'));
    expect(layout.focused?.key).toBe('nav:services');

    // In the page list the cursor selects: Down opens the next page, Up from the top reaches the header.
    expect(moveFocus(layout, 'down').focusId).toBe('nav:api-access');
    expect(moveFocus(layoutOf({page: 'overview'}), 'up').focusId).toBe('session');
    expect(moveFocus(layoutOf({page: 'overview', focusId: 'session'}), 'down').focusId).toBe('nav:overview');
  });

  it('walks every element in reading order with Tab and back with Shift+Tab', () => {
    const state: Partial<TuiViewState> = {page: 'api-access'};
    let layout = layoutOf(state);
    const visited: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      layout = withFocus(layout, state, moveFocus(layout, 'next'));
      visited.push(layout.focused?.key ?? '');
    }
    expect(visited).toEqual(['apikey:create', 'link:https://litellm.magicstick.local/v1', 'apikey:revoke:1', 'session', 'nav:api-access', 'apikey:create']);
    expect(moveFocus(layout, 'previous').focusId).toBe('nav:api-access');
  });

  it('scrolls a long page to keep the cursor visible and shows a scroll bar', () => {
    const data = snapshot();
    data.users = {users: Array.from({length: 12}, (_, index) => ({id: String(index), username: `user-${index}`, enabled: true})), total: 12, first: 0, max: 25};
    const state: Partial<TuiViewState> = {page: 'system', systemSection: 'users'};
    let layout = layoutOf(state, data, 121, 30);
    expect(layout.maxScroll).toBeGreaterThan(0);
    expect(layout.lines.join('\n')).toContain('█');
    expect(layout.lines.join('\n')).not.toContain('user-11');
    layout = layoutOf({...state, focusId: 'user:profile:0'}, data, 121, 30);
    for (let step = 0; step < 11; step += 1) {
      const moved = moveFocus(layout, 'down');
      layout = layoutOf({...state, focusId: moved.focusId, scrollTop: moved.scrollTop}, data, 121, 30);
    }
    expect(layout.focused?.key).toBe('user:profile:11');
    expect(layout.scrollTop).toBeGreaterThan(0);
    expect(layout.lines.join('\n')).toContain('user-11');
    expect(layout.lines.join('\n')).toContain('►[ Edit ]◄');
    // The cursor stays close when its element disappears after a refresh.
    data.users.users.pop();
    const refreshed = composeTui(data, initialViewState({...state, focusId: 'user:profile:11', focusAt: {x: layout.focused!.x, y: layout.focused!.y}, scrollTop: layout.scrollTop}), 121, 30, false);
    expect(refreshed.focused?.key).toBe('user:profile:10');
  });

  it('keeps separate cursor stops for the same address shown twice', () => {
    const data = snapshot();
    data.status.ingresses = [{name: 'litellm', hosts: ['litellm.magicstick.local']}];
    data.instances = {instances: {litellm: [{metadata: {name: 'litellm'}, status: {phase: 'Ready', url: 'https://litellm.magicstick.local'}}]}};
    const keys = layoutOf({page: 'overview'}, data).content.map((target) => target.key);
    expect(keys.some((key) => key.endsWith('#1'))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys.map((key) => key.replace(/#\d+$/, ''))).size).toBeLessThan(keys.length);
  });

  it('maps mouse reports to the element under the pointer', () => {
    expect(parseMouse('\x1b[<0;5;12M')).toEqual({button: 0, x: 4, y: 11, pressed: true});
    expect(parseMouse('\x1b[<0;5;12m')?.pressed).toBe(false);
    expect(parseMouse('\x1b[<65;1;1M')?.button).toBe(65);
    expect(parseMouse('\x1b[B')).toBeUndefined();
    const layout = layoutOf({page: 'models'});
    const models = layout.nav.find((target) => target.key === 'nav:models')!;
    expect(hitTarget(layout.mouse, models.x + 3, models.y)?.action.id).toBe('nav:models');
    const quit = layout.mouse.find((target) => target.zone === 'bar' && target.action.id === 'quit')!;
    expect(hitTarget(layout.mouse, quit.x, quit.y)?.action.id).toBe('quit');
    expect(hitTarget(layout.mouse, 40, 12)).toBeUndefined();
    expect(layout.top).toBe(BANNER_HEIGHT);
  });

  it('keeps a selected form field and the submit keys visible in a long form', () => {
    const rendered = renderTui(snapshot(), {page: 'models', overlay: {
      kind: 'form', title: 'Long form', fields: Array.from({length: 20}, (_, index) => ({id: String(index), label: `Field ${index}`, value: 'example'})),
      active: 19, submitLabel: 'save', onSubmit: async () => undefined,
    }}, 121, 24, false);
    expect(rendered).toContain('►Field 19: example_');
    expect(rendered).toContain('field 20 of 20');
    expect(rendered).toContain('[ Cancel ] [ Save ]');
    expect(rendered).toContain('Ctrl+S Save');
    expect(rendered.split('\n')).toHaveLength(24);
  });

  it('draws confirmations as a dialog over the page with the keys in the footer', () => {
    const rendered = renderTui(snapshot(), {page: 'services', overlay: {kind: 'confirm', title: 'Disable LiteLLM', description: 'Dependent workloads may become unavailable.', confirmLabel: 'disable', onConfirm: async () => undefined}}, 121, 36, false);
    expect(rendered).toContain('┌─ Disable LiteLLM ─');
    expect(rendered).toContain('[ Cancel ]►[ Disable ]◄');
    expect(rendered.split('\n').at(-1)).toContain('Enter Disable  Esc Cancel');
    expect(rendered).toContain('▌Services');
  });

  it('shows models and compute memory with the shared contract wording', () => {
    const models = (data: DashboardSnapshot) => renderTui(data, {page: 'models'}, 121, 60, false);
    expect(models(snapshot())).toContain('CPU: 49 GiB free');
    expect(models(snapshot())).toContain('KV auto');
    expect(models(snapshot())).toContain('[ Add Model ]');
    expect(models(snapshot(['magicstick-viewer']))).not.toMatch(/\[ Add Model \]|\[ Remove \]/);
    const state = snapshot();
    state.models.computeMemory = {sharedPools: [{id: 'example-node', node: 'example-node', installedMemoryMi: 131072, firmwareReservedMi: 65536, physicalMemoryMi: 65536, gpuAccessibleMi: 49152, gpuCapacityMi: 65536, gpuAllocationMode: 'firmware-reserved', gpuCapacitySource: 'kfd-topology'}], devices: [{id: 'example-gpu', totalMi: 65536, gpuAllocationMode: 'firmware-reserved', memoryArchitecture: 'unified', accountingVerified: false}]};
    expect(models(state)).not.toContain('shared RAM available');
    expect(models(state)).toContain('64 GiB budgetable');
    expect(models(state)).toContain('One GPU: driver capacity 64 GiB / allocation firmware-reserved');
    expect(models(state)).toContain('Dynamic memory is not a protected reservation');
    expect(models(state)).toContain('installed RAM 128 GiB / fixed GPU reservation 64 GiB');
    expect(models(state)).toContain('dynamic GPU ceiling 48 GiB (within Linux RAM, not extra)');
  });

  it('shows hardware validation separately and restricts its buttons to administrators', () => {
    const hardware = (data: DashboardSnapshot) => renderTui(data, {page: 'system', systemSection: 'hardware'}, 151, 70, false);
    const state = snapshot();
    state.status.hardwareOperators = {'amd-gpu': {phase: 'Degraded', compatibility: {schemaVersion: 1, profiles: [], selectedProfile: 'strix-halo', allowExperimental: true, nodes: [{node: 'example-node', eligible: true, hostDriverReady: true, resourceRegistered: true, memoryArchitecture: 'unified', memoryAccountingVerified: false, physicalMemoryMi: 65536, gpuAccessibleMi: 49152, validation: {OLlama: {state: 'passed'}, VLLM: {state: 'failed'}}}]}}};
    expect(hardware(state)).toContain('Ollama: passed · runtime pending · vLLM: failed');
    expect(hardware(state)).toContain('Shared accounting: not verified');
    expect(hardware(state)).toContain('OS-visible shared RAM: 64 GiB');
    expect(hardware(state)).toContain('[ Change profile ] [ Run validation ] [ Use upstream rules ]');
    const viewer = {...state, session: {...state.session, roles: ['magicstick-viewer']}};
    expect(hardware(viewer)).toContain('Shared accounting: not verified');
    expect(hardware(viewer)).not.toMatch(/Change profile|Run validation/);
  });

  it('offers service switches only for modules an operator may toggle', () => {
    const services = (data: DashboardSnapshot) => renderTui(data, {page: 'services', serviceFilter: 'platform'}, 121, 40, false);
    expect(services(snapshot())).toContain('┌─ LiteLLM ── litellm ─');
    expect(services(snapshot())).toContain('[ Disable ]');
    expect(services(snapshot(['magicstick-viewer']))).not.toContain('[ Disable ]');
    const fixed = snapshot();
    fixed.modules.modules.litellm!.activationMode = 'static';
    fixed.modules.catalogJson!.modules!.litellm!.activationMode = 'static';
    expect(services(fixed)).not.toContain('[ Disable ]');
  });

  it('wraps choices and clamps list selection', () => {
    expect(moveTab(0, -1, 4)).toBe(3);
    expect(moveTab(3, 1, 4)).toBe(0);
    expect(moveSelection(0, -1, 4)).toBe(0);
    expect(moveSelection(3, 1, 4)).toBe(3);
  });

  it('builds CPU and GPU local-model reservations with the API contract', () => {
    const base = {
      name: 'qwen', modelType: 'chat', engine: 'VLLM', reference: 'hf://Qwen/Qwen3.5-9B',
      contextWindow: 32768, maxNumSeqs: 1, reservationMi: 12300,
    };
    expect(buildLocalModelPayload({...base, computeTarget: 'cpu'}, {id: 'cpu', kind: 'cpu'})).toMatchObject({
      name: 'qwen', local: {memoryRequiredMi: 12300, computeTarget: 'cpu', url: base.reference, kvCacheType: 'auto'},
    });
    expect(buildLocalModelPayload({...base, computeTarget: 'nvidia-gpu'}, {id: 'nvidia-gpu', kind: 'gpu'})).toMatchObject({
      name: 'qwen', local: {vram: '12300Mi', computeTarget: 'nvidia-gpu', url: base.reference},
    });
  });

  it('encodes clipboard content with OSC 52 instead of invoking a platform command', () => {
    expect(osc52ClipboardSequence('secret')).toBe('\x1b]52;c;c2VjcmV0\x07');
  });

  it('keeps GPU and host budgets separate and lets the server derive offload controls', () => {
    const input = {name: 'hybrid', modelType: 'chat', engine: 'OLlama', reference: 'ollama://example:latest',
      contextWindow: 4096, maxNumSeqs: 1, kvCacheType: 'q4_0', reservationMi: 12000, computeTarget: 'nvidia-gpu', cpuOffloading: true, hostMemoryMi: 16000};
    const payload = buildLocalModelPayload(input, {id: 'nvidia-gpu', kind: 'gpu'});
    expect(payload.local).toMatchObject({cpuOffloading: true, vram: '12000Mi', memoryRequiredMi: 16000, kvCacheType: 'q4_0'});
    expect(payload.local).not.toHaveProperty('ollamaGpuLayers');
    expect(payload.local).not.toHaveProperty('cpuOffloadMi');
    expect(() => buildLocalModelPayload({...input, computeTarget: 'cpu'}, {id: 'cpu', kind: 'cpu'})).toThrow('NVIDIA');
    expect(() => buildLocalModelPayload({...input, hostMemoryMi: undefined}, {id: 'nvidia-gpu', kind: 'gpu'})).toThrow('separate host RAM');
  });

  it('splits raw terminal chunks into keys, paging keys and mouse reports', () => {
    expect(splitTerminalInput('jja')).toEqual(['j', 'j', 'a']);
    expect(splitTerminalInput('\x1b[B\x1b[C')).toEqual(['\x1b[B', '\x1b[C']);
    expect(splitTerminalInput('ä')).toEqual(['ä']);
    expect(splitTerminalInput('\x1b[5~\x1b[Zq')).toEqual(['\x1b[5~', '\x1b[Z', 'q']);
    expect(splitTerminalInput('\x1b[<0;34;12M\x1b[<0;34;12mx')).toEqual(['\x1b[<0;34;12M', '\x1b[<0;34;12m', 'x']);
    expect(splitTerminalInput('\x1b')).toEqual(['\x1b']);
  });

  it('never renders form secrets as plaintext', () => {
    const rendered = renderTui(snapshot(), {page: 'system', systemSection: 'users', overlay: {
      kind: 'form', title: 'Create user', fields: [
        {id: 'password', label: 'Temporary password', value: 'not-for-display', kind: 'secret'},
      ], active: 0, submitLabel: 'create', onSubmit: async () => undefined,
    }}, 121, 30, false);
    expect(rendered).toContain('•••••••••••••••');
    expect(rendered).not.toContain('not-for-display');
  });
});
