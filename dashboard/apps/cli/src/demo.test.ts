import {afterEach, describe, expect, it, vi} from 'vitest';
import {createDemoRuntime} from './demo';
import {loadSnapshot} from './snapshot';
import {availablePages, availableSystemSections, renderTui} from './tui';

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
