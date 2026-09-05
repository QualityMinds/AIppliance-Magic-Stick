import {afterEach, describe, expect, it, vi} from 'vitest';
import {createDemoRuntime} from './demo';
import {loadSnapshot} from './snapshot';
import {availableTabs, renderTui} from './tui';

afterEach(() => vi.unstubAllGlobals());

describe('offline terminal preview', () => {
  it('loads and refreshes every tab without using the network', async () => {
    const fetch = vi.fn(() => { throw new Error('Network must not be used'); });
    vi.stubGlobal('fetch', fetch);
    const runtime = createDemoRuntime();
    const snapshot = await loadSnapshot(runtime.api);
    expect(availableTabs(snapshot)).toHaveLength(8);
    for (let index = 0; index < availableTabs(snapshot).length; index += 1) {
      const screen = renderTui(snapshot, index, 120, 30, false, {demo: true});
      expect(screen).toContain('OFFLINE DEMO · read-only · sample data');
      expect(screen).not.toContain('signed in:');
      expect(screen).not.toContain('x: sign out');
      expect(screen).not.toMatch(/a: (enable|add|create)|d: (disable|remove|revoke)|copy kubeconfig/);
    }
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