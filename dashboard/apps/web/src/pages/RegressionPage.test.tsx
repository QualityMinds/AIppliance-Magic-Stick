import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within, act} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {RegressionRun, RegressionStatus, Session} from '@magicstick/dashboard-contracts';
import {RegressionPage} from './RegressionPage';
import {allowedSystemSections, isSystemSection} from './SystemAreaPage';
import {api} from '../api';

vi.mock('../api', () => ({api: {regression: vi.fn(), enableModule: vi.fn(), registerRegression: vi.fn(),
  startRegression: vi.fn(), cancelRegression: vi.fn(), downloadRegression: vi.fn()}}));
const run = (): RegressionRun => ({id: 'regression-' + 'a'.repeat(32), uid: 'fixture-uid', createdAt: '2026-10-13T12:00:00Z', phases: [0,1,2,3,4,5,6,7,8],
  sourceRevision: 'b'.repeat(40), phase: 'Running', message: 'Running the existing regression suite.', reportAvailable: false, credentialsCleaned: false,
  progress: {percent: 34, completedPhases: 3, totalPhases: 9, currentPhase: 3, step: 'phase3-gpu', currentTest: 'MGPU-01: verify every selected physical GPU', testIndex: 2, testTotal: 8,
    executionCounts: {Passed: 20, Failed: 1, Blocked: 2}}});
let data: RegressionStatus;
function mount() {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
  render(<QueryClientProvider client={client}><RegressionPage /></QueryClientProvider>);
  return client;
}
beforeEach(() => {
  vi.resetAllMocks();
  data = {registered: true, applianceUid: 'fixture-appliance', runtimeAvailable: true, sourceRevision: 'b'.repeat(40), message: '', runs: [],
    executionLocation: 'appliance-kubernetes', externalRunnerRequired: ['reboot', 'power-off', 'network-loss']};
  vi.mocked(api.regression).mockImplementation(async () => data);
  vi.mocked(api.startRegression).mockResolvedValue(run());
});

describe('In-Appliance regression tests', () => {
  it('opens and refreshes without starting tests or changing the server', async () => {
    mount(); expect(await screen.findByRole('button', {name: 'Start regression tests'})).toBeEnabled();
    await userEvent.click(screen.getByRole('button', {name: 'Refresh tests'}));
    expect(api.startRegression).not.toHaveBeenCalled(); expect(api.enableModule).not.toHaveBeenCalled(); expect(api.registerRegression).not.toHaveBeenCalled();
  });
  it('keeps refresh enabled during background polling and updates progress when the request finishes', async () => {
    data.runs = [run()]; const client = mount();
    expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '34');
    let finish!: (value: RegressionStatus) => void;
    vi.mocked(api.regression).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    let pending!: Promise<void>;
    await act(async () => {pending = client.refetchQueries({queryKey: ['regression']});});
    await waitFor(() => expect(client.isFetching({queryKey: ['regression']})).toBe(1));
    expect(screen.getByRole('button', {name: 'Refresh tests'})).toBeEnabled();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '34');
    await act(async () => {
      finish({...data, runs: [{...run(), progress: {...run().progress, percent: 61}}]}); await pending;
    });
    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '61'));
    expect(screen.getByRole('button', {name: 'Refresh tests'})).toBeEnabled();
    expect(api.startRegression).not.toHaveBeenCalled();
  });
  it('disables only a manual refresh and shares an already pending background request', async () => {
    const client = mount(); await screen.findByText('No regression runs yet.');
    let finish!: (value: RegressionStatus) => void;
    vi.mocked(api.regression).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    let pending!: Promise<void>;
    await act(async () => {pending = client.refetchQueries({queryKey: ['regression']});});
    await waitFor(() => expect(client.isFetching({queryKey: ['regression']})).toBe(1));
    expect(screen.getByRole('button', {name: 'Refresh tests'})).toBeEnabled();
    await userEvent.click(screen.getByRole('button', {name: 'Refresh tests'}));
    expect(screen.getByRole('button', {name: 'Refresh tests'})).toBeDisabled();
    expect(api.regression).toHaveBeenCalledTimes(2);
    await act(async () => {finish(data); await pending;});
    await waitFor(() => expect(screen.getByRole('button', {name: 'Refresh tests'})).toBeEnabled());
    expect(api.regression).toHaveBeenCalledTimes(2);
  });
  it('reenables refresh after a failed manual request and displays the error', async () => {
    mount(); await screen.findByText('No regression runs yet.');
    let fail!: (reason: Error) => void;
    vi.mocked(api.regression).mockImplementationOnce(() => new Promise((_resolve, reject) => {fail = reject;}));
    await userEvent.click(screen.getByRole('button', {name: 'Refresh tests'}));
    expect(screen.getByRole('button', {name: 'Refresh tests'})).toBeDisabled();
    await act(async () => {fail(new Error('Synthetic status request failure'));});
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic status request failure');
    await waitFor(() => expect(screen.getByRole('button', {name: 'Refresh tests'})).toBeEnabled());
    expect(api.startRegression).not.toHaveBeenCalled();
  });
  it('registers the system tab and direct route only for administrators', () => {
    expect(isSystemSection('regression')).toBe(true);
    for (const role of ['magicstick-user', 'magicstick-viewer', 'magicstick-operator', 'magicstick-admin'])
      expect(allowedSystemSections({roles: [role]} as Session).some(s => s.id === 'regression')).toBe(role === 'magicstick-admin');
  });
  it('requires one-time exact disposable-server confirmation without requesting passwords', async () => {
    data.registered = false; mount();
    await userEvent.click(await screen.findByRole('button', {name: 'Register test Appliance'}));
    const dialog = screen.getByRole('dialog', {name: 'Register disposable test Appliance'});
    expect(within(dialog).getByRole('button', {name: 'Register test Appliance'})).toBeDisabled();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Type DISPOSABLE TEST SERVER to confirm'), 'DISPOSABLE TEST SERVER');
    await userEvent.click(within(dialog).getByRole('button', {name: 'Register test Appliance'}));
    expect(api.registerRegression).toHaveBeenCalledOnce(); expect(api.startRegression).not.toHaveBeenCalled();
  });
  it('starts only after disruption confirmation with an idempotency key, not a command or image', async () => {
    mount(); await userEvent.click(await screen.findByRole('button', {name: 'Start regression tests'}));
    expect(api.startRegression).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', {name: 'Start regression tests'});
    expect(within(dialog).getByText(/Existing models may be stopped/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', {name: 'Start tests'}));
    await waitFor(() => expect(api.startRegression).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{32}$/)));
  });
  it('recovers progress from the API and blocks parallel starts while cancellation remains possible', async () => {
    data.runs = [run()]; const client = mount();
    expect(await screen.findByRole('progressbar', {name: 'Regression progress'})).toHaveAttribute('aria-valuenow', '34');
    expect(screen.getByRole('button', {name: 'Start regression tests'})).toBeDisabled();
    expect(screen.getByText(/MGPU-01: verify/)).toBeVisible();
    expect(screen.getByRole('button', {name: 'Download report'})).toBeDisabled();
    data = {...data, runs: [{...run(), progress: {...run().progress, percent: 61}}]};
    await act(async () => {await client.refetchQueries({queryKey: ['regression']});});
    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '61'));
    await userEvent.click(screen.getByRole('button', {name: 'Cancel tests'}));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', {name: 'Cancel tests'}));
    expect(api.cancelRegression).toHaveBeenCalledWith(run().id);
  });
  it('displays blocked reasons, exact phase/layer/variant, next action and archive trace', async () => {
    data.runs = [{...run(), phase: 'Blocked', reportAvailable: true, credentialsCleaned: true, result: {
      counts: {Passed: 100, Failed: 0, Blocked: 3}, executionCounts: {Passed: 20, Failed: 0, Blocked: 1}, recoveryRequired: false, omittedCases: 0,
      phases: [{phase: 6, outcome: 'Blocked', counts: {Passed: 100, Failed: 0, Blocked: 3}, executionCounts: {Passed: 20, Failed: 0, Blocked: 1}}],
      cases: [{id: 'BOOT-02', outcome: 'Blocked', layer: 'O', variant: 'p6-reboot', phase: 6, stage: 'host-boot', reason: 'EXTERNAL_RUNNER',
        message: 'An external runner must independently observe the host reboot.', action: 'Use the external Docker runner.', durationMs: 0,
        tracePath: 'report-artifacts/reg-fixture/traces/fixture.json'}]}}];
    mount(); await screen.findByRole('button', {name: 'Download report'});
    await userEvent.click(screen.getByText('Failures and blocked checks (1)'));
    expect(screen.getByText('EXTERNAL_RUNNER')).toBeVisible(); expect(screen.getByText(/Phase 6 · Check layer O · Stage: host-boot/)).toBeVisible();
    expect(screen.getByText(/Next action: Use the external Docker runner/)).toBeVisible();
    await userEvent.click(screen.getByText('Trace in report archive')); expect(screen.getByText(/report-artifacts\/reg-fixture/)).toBeVisible();
    expect(screen.getByRole('button', {name: 'Download report'})).toBeEnabled();
    expect(api.startRegression).not.toHaveBeenCalled();
  });
  it('keeps API outage and account cleanup distinct from a passed suite', async () => {
    data.runs = [{...run(), phase: 'Passed', credentialsCleaned: false}]; mount();
    expect(await screen.findByRole('button', {name: 'Start regression tests'})).toBeDisabled();
    expect(screen.getByText(/Removing the completed run/)).toBeVisible();
  });
  it('can start verified recovery without asking for the original credentials or clearing a lock', async () => {
    data.runs = [{...run(), phase: 'Cancelled', credentialsCleaned: false}]; data.recoveryAvailable = true;
    mount(); expect(await screen.findByRole('button', {name: 'Start regression tests'})).toBeEnabled();
    expect(screen.getByText(/recover the interrupted setup with its retained test identity/)).toBeVisible();
    expect(api.startRegression).not.toHaveBeenCalled();
  });
});
