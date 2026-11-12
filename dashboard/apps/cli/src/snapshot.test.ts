import {describe, expect, it, vi} from 'vitest';
import type {MagicStickApi} from '@magicstick/dashboard-api-client';
import {loadSnapshot} from './snapshot';

const api = (roles: string[]) => {
  const methods = {
    session: vi.fn(async () => ({subject: '1', username: 'test', roles, identityManagementAvailable: true, identityManagementMode: 'keycloak'})),
    appliance: vi.fn(async () => ({metadata: {name: 'local'}})),
    modules: vi.fn(async () => ({modules: {}})),
    instances: vi.fn(async () => ({instances: {}})),
    models: vi.fn(async () => ({activations: [], presets: {}, computeTargets: {targets: []}})),
    status: vi.fn(async () => ({})),
    settings: vi.fn(async () => ({publicDomain: 'example.com', dashboardHost: 'example.com', mdnsDomain: 'magicstick.local', mdnsName: 'magicstick'})),
    users: vi.fn(async () => ({users: [], total: 0, first: 0, max: 25})),
    apiAccess: vi.fn(async () => ({items: [], total: 0})),
    licenseStatus: vi.fn(async () => ({state: 'missing', features: []})),
    kubernetesAccess: vi.fn(async () => ({users: [], total: 0, first: 0, max: 100})),
    consoleAccess: vi.fn(async () => ({available: true, accessLevel: 'admin'})),
  };
  return {methods, client: methods as unknown as MagicStickApi};
};

describe('loadSnapshot', () => {
  it('loads every dashboard area for an administrator', async () => {
    const {methods, client} = api(['magicstick-admin']);
    const result = await loadSnapshot(client);

    expect(result.settings?.mdnsDomain).toBe('magicstick.local');
    expect(result.users?.total).toBe(0);
    expect(methods.apiAccess).toHaveBeenCalledOnce();
    expect(methods.licenseStatus).toHaveBeenCalledOnce();
    expect(methods.kubernetesAccess).toHaveBeenCalledOnce();
    expect(result.consoleAccess).toEqual({available: true, accessLevel: 'admin'});
  });

  it('still loads when the appliance API predates automatic console sign-in', async () => {
    const {methods, client} = api(['magicstick-admin']);
    methods.consoleAccess.mockRejectedValue(new Error('not found'));

    const result = await loadSnapshot(client);

    expect(result.consoleAccess).toBeUndefined();
    expect(result.users?.total).toBe(0);
  });

  it('does not request administrator endpoints for a viewer', async () => {
    const {methods, client} = api(['magicstick-viewer']);
    const result = await loadSnapshot(client);

    expect(result.settings).toBeUndefined();
    expect(result.users).toBeUndefined();
    expect(methods.settings).not.toHaveBeenCalled();
    expect(methods.apiAccess).not.toHaveBeenCalled();
    expect(methods.licenseStatus).not.toHaveBeenCalled();
    expect(methods.kubernetesAccess).not.toHaveBeenCalled();
    expect(methods.consoleAccess).not.toHaveBeenCalled();
  });
});
