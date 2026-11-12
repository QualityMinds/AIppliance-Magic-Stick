import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ConsoleAccessSettings} from './ConsoleAccessSettings';
import {allowedSettingsSections} from './SettingsPage';
import {api} from '../api';

vi.mock('../api', () => ({api: {consoleAccess: vi.fn(), updateConsoleAccess: vi.fn()}}));

const mount = () => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
  render(<QueryClientProvider client={client}><ConsoleAccessSettings /></QueryClientProvider>);
  return client;
};
const session = (roles: string[], identityManagementAvailable = true) => ({
  subject: 'fixture', username: 'fixture', roles, identityManagementAvailable, identityManagementMode: 'keycloak',
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.consoleAccess).mockResolvedValue({available: true, accessLevel: 'admin'});
});

describe('Local console sign-in settings', () => {
  it('is offered only to administrators with local identity management', () => {
    const ids = (value: ReturnType<typeof session>) => allowedSettingsSections(value).map((section) => section.id);
    expect(ids(session(['magicstick-admin']))).toContain('console');
    expect(ids(session(['magicstick-admin'], false))).not.toContain('console');
    expect(ids(session(['magicstick-operator']))).toEqual([]);
  });

  it('saves only a changed level and warns while access is granted without a password', async () => {
    vi.mocked(api.updateConsoleAccess).mockResolvedValue({available: true, accessLevel: 'off'});
    mount();
    const select = await screen.findByLabelText('Automatic sign-in'), save = screen.getByRole('button', {name: 'Save Local Console'});
    await waitFor(() => expect(select).toHaveValue('admin'));
    expect(save).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent('Administrator access without a password');

    await userEvent.selectOptions(select, 'viewer');
    expect(save).toBeEnabled();
    await userEvent.selectOptions(select, 'admin'); // Reverted draft.
    expect(save).toBeDisabled();
    expect(api.updateConsoleAccess).not.toHaveBeenCalled();

    await userEvent.selectOptions(select, 'off');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    vi.mocked(api.consoleAccess).mockResolvedValue({available: true, accessLevel: 'off'});
    await userEvent.click(save);
    await waitFor(() => expect(api.updateConsoleAccess).toHaveBeenCalledWith('off'));
    expect(await screen.findByText(/Local console sign-in saved: Off/)).toBeInTheDocument();
    await waitFor(() => expect(save).toBeDisabled());
  });

  it('keeps an unsaved choice across a background refresh', async () => {
    const client = mount();
    const select = await screen.findByLabelText('Automatic sign-in');
    await waitFor(() => expect(select).toHaveValue('admin'));
    await userEvent.selectOptions(select, 'operator');
    vi.mocked(api.consoleAccess).mockResolvedValue({available: true, accessLevel: 'viewer'});
    await act(async () => { await client.refetchQueries({queryKey: ['console-access']}); });
    expect(select).toHaveValue('operator');
    expect(screen.getByRole('button', {name: 'Save Local Console'})).toBeEnabled();
  });

  it('explains an appliance without the console identity and blocks saving', async () => {
    vi.mocked(api.consoleAccess).mockResolvedValue({available: false, accessLevel: 'off'});
    mount();
    expect(await screen.findByRole('status')).toHaveTextContent('has not set up automatic console sign-in yet');
    expect(screen.getByLabelText('Automatic sign-in')).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Save Local Console'})).toBeDisabled();
  });

  it('shows a rejected change instead of pretending it was saved', async () => {
    vi.mocked(api.updateConsoleAccess).mockRejectedValue(new Error('administrator access has been revoked'));
    mount();
    const select = await screen.findByLabelText('Automatic sign-in');
    await waitFor(() => expect(select).toHaveValue('admin'));
    await userEvent.selectOptions(select, 'viewer');
    await userEvent.click(screen.getByRole('button', {name: 'Save Local Console'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('administrator access has been revoked');
    expect(screen.queryByText(/sign-in saved/)).not.toBeInTheDocument();
  });
});
