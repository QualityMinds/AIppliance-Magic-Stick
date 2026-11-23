import {afterEach, describe, expect, it, vi} from 'vitest';
import {createDemoRuntime} from './demo';
import {loadSnapshot} from './snapshot';
import {availablePages, availableSystemSections, renderTui} from './tui';
import {AREA_MODULES, SETTINGS_SECTIONS, STATUS_SECTIONS} from './tui-pages';

afterEach(() => vi.unstubAllGlobals());

describe('offline terminal preview', () => {
  it('loads and refreshes every page without using the network', async () => {
    const fetch = vi.fn(() => { throw new Error('Network must not be used'); });
    vi.stubGlobal('fetch', fetch);
    const runtime = createDemoRuntime();
    const snapshot = await loadSnapshot(runtime.api);
    expect(availablePages(snapshot)).toHaveLength(7);
    for (const page of availablePages(snapshot)) {
      for (const section of page.id === 'system' ? availableSystemSections(snapshot) : [{id: 'status' as const}]) {
        const screen = renderTui(snapshot, {page: page.id, systemSection: section.id, demo: true}, 121, 30, false);
        expect(screen).toContain('OFFLINE DEMO · read-only · sample data');
        expect(screen).not.toContain('Signed in:');
        expect(screen).not.toMatch(/Sign out|Switch user/);
      }
    }
    expect(renderTui(snapshot, {page: 'services', demo: true}, 121, 40, false)).toContain('APPLICATIONS · 2 services · 1 instance');
    snapshot.modules.modules.litellm!.enabled = false;
    expect((await loadSnapshot(runtime.api)).modules.modules.litellm?.enabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the sections with their own data from synthetic samples, and lets read-only buttons work', async () => {
    const fetch = vi.fn(() => { throw new Error('Network must not be used'); });
    vi.stubGlobal('fetch', fetch);
    const snapshot = await loadSnapshot(createDemoRuntime().api, {extras: ['hosts', 'gpuSharing', 'mesh', 'federatedSso', 'regression', 'softwareReleases']});
    expect(snapshot.errors).toBeUndefined();
    const screens = [
      renderTui(snapshot, {page: 'mesh', demo: true}, 121, 40, false),
      ...SETTINGS_SECTIONS.map((section) => renderTui(snapshot, {page: 'system', systemSection: 'settings', settingsSection: section.id, demo: true}, 121, 60, false)),
      ...STATUS_SECTIONS.map((section) => renderTui(snapshot, {page: 'system', systemSection: 'status', statusSection: section.id, demo: true}, 121, 60, false)),
      ...(['hardware', 'power'] as const).map((section) => renderTui(snapshot, {page: 'system', systemSection: section, demo: true}, 121, 60, false)),
    ];
    for (const screen of screens) expect(screen).not.toMatch(/could not be loaded|Loading /);
    expect(screens.join('\n')).toContain('demo-node');
    // Explanations, refreshes and paging read only; every change stays unavailable offline.
    const readOnly = (id: string) => {
      const [scope = '', verb = '', ...rest] = id.split(':');
      return AREA_MODULES.some((module) => scope in module.scopes && module.readOnly?.({id, scope, verb, target: rest.join(':')}));
    };
    expect(['network:info', 'updates:refresh-versions', 'user:page:next', 'license:document:0', 'k8s:oidc', 'hardware:refresh'].every(readOnly)).toBe(true);
    expect(['network:configure:demo-node', 'updates:apply-channel:demo-node', 'host:reboot:demo-node', 'mesh:create', 'model:stop:demo-chat', 'cache:clear:demo-node'].some(readOnly)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects mutations, credential access, login, and logout with no network fallback', async () => {
    const fetch = vi.fn(() => { throw new Error('Network must not be used'); });
    vi.stubGlobal('fetch', fetch);
    const runtime = createDemoRuntime();
    await expect(runtime.api.enableModule('litellm')).rejects.toThrow('read-only');
    await expect(runtime.api.request('/api/settings', {method: 'PATCH'})).rejects.toThrow('read-only');
    await expect(runtime.api.request('/api/models/demo-chat', {method: 'DELETE'})).rejects.toThrow('read-only');
    await expect(runtime.api.moduleCredentials('litellm')).rejects.toThrow('read-only');
    await expect(runtime.api.kubeconfig('demo')).rejects.toThrow('read-only');
    await expect(runtime.login()).rejects.toThrow('read-only');
    await expect(runtime.logout()).rejects.toThrow('read-only');
    expect(fetch).not.toHaveBeenCalled();
  });
});
