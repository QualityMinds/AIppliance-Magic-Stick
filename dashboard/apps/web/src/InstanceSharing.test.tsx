import {useState} from 'react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {InstanceAccessState, InstanceSharing} from '@magicstick/dashboard-contracts';
import {InstanceSharingDialog, SharingFields} from './pages/InstanceSharing';
import {MyInstancesPage} from './pages/MyInstancesPage';
import {App} from './App';
import {api} from './api';

const state: InstanceAccessState = {name: 'hermes-example', revision: '4', guardReady: true, authentication: 'sso', sharing: {mode: 'all', users: [], groups: []},
  feature: {id: 'resource-sharing', available: true, implemented: true, licensed: true, reason: 'available'}};
const mount = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}>{node}</QueryClientProvider>);

describe('targeted instance sharing', () => {
  beforeEach(() => {
    vi.spyOn(api, 'instanceAccess').mockResolvedValue(state);
    vi.spyOn(api, 'updateInstanceAccess').mockResolvedValue({...state, revision: '5'});
    vi.spyOn(api, 'instancePrincipals').mockImplementation(async (kind) => ({kind, items: [{id: kind === 'users' ? 'user-id' : 'group-id', name: kind === 'users' ? 'Example User' : '/Team'}], next: null}));
  });
  it('selects immutable user and group IDs and requires confirmation', async () => {
    const user = userEvent.setup(); const close = vi.fn(); const saved = vi.fn(async () => {});
    mount(<InstanceSharingDialog name={state.name} onClose={close} onSaved={saved} />);
    await user.selectOptions(await screen.findByLabelText('Visible and accessible to'), 'selected');
    await user.click(await screen.findByRole('button', {name: '+ Example User'}));
    await user.selectOptions(screen.getByLabelText('Search directory'), 'groups');
    await user.click(await screen.findByRole('button', {name: '+ /Team'}));
    expect(screen.getByRole('button', {name: 'Save sharing'})).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', {name: 'Save sharing'}));
    expect(api.updateInstanceAccess).toHaveBeenCalledWith('hermes-example', {mode: 'selected', users: ['user-id'], groups: ['group-id']}, '4');
    expect(saved).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
  it('shows absent entitlement and blocks updates without loading the directory', async () => {
    vi.mocked(api.instanceAccess).mockResolvedValue({...state, sharing: {mode: 'selected', users: ['user-id'], groups: []}, feature: {...state.feature, available: false}});
    mount(<InstanceSharingDialog name={state.name} onClose={() => {}} onSaved={async () => {}} />);
    expect(await screen.findByRole('button', {name: 'Save sharing'})).toBeDisabled();
    expect(api.instancePrincipals).not.toHaveBeenCalled();
    expect(api.updateInstanceAccess).not.toHaveBeenCalled();
  });
  it('keeps a conflict visible and does not silently retry a changed policy', async () => {
    vi.mocked(api.updateInstanceAccess).mockRejectedValue(new Error('Instance changed. Reload and review the sharing policy.'));
    const user = userEvent.setup(); const close = vi.fn();
    mount(<InstanceSharingDialog name={state.name} onClose={close} onSaved={async () => {}} />);
    await screen.findByLabelText('Visible and accessible to');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', {name: 'Save sharing'}));
    await screen.findByText('Instance changed. Reload and review the sharing policy.');
    expect(close).not.toHaveBeenCalled();
    expect(api.updateInstanceAccess).toHaveBeenCalledOnce();
  });
  it('clears selected IDs when explicitly returning to all users', async () => {
    const Form = () => {const [value, change] = useState<InstanceSharing>({mode: 'selected', users: ['user-id'], groups: ['group-id']});
      return <><SharingFields value={value} onChange={change} /><output>{JSON.stringify(value)}</output></>;};
    const user = userEvent.setup(); mount(<Form />);
    await user.selectOptions(screen.getByLabelText('Visible and accessible to'), 'all');
    expect(screen.getByRole('status')).toHaveTextContent('{"mode":"all","users":[],"groups":[]}');
  });
  it('renders the minimal launchpad without requesting control-plane data', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({subject: 'user-id', username: 'Example', roles: ['magicstick-user'], identityManagementAvailable: true, identityManagementMode: 'keycloak'});
    vi.spyOn(api, 'myInstances').mockResolvedValue({items: [{name: 'hermes-visible', application: 'hermes', phase: 'Ready', urls: ['https://visible.hermes.example.local/']}]});
    const modules = vi.spyOn(api, 'modules'); mount(<App />);
    await screen.findByText('hermes-visible');
    expect(screen.queryByRole('button', {name: 'Services'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Users'})).not.toBeInTheDocument();
    expect(modules).not.toHaveBeenCalled();
  });
  it('shows a safe empty state after a grant was revoked', async () => {
    vi.spyOn(api, 'myInstances').mockResolvedValue({items: []}); mount(<MyInstancesPage />);
    await screen.findByText('No instances are currently available to your account.');
  });
});
