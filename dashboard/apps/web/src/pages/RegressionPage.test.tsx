import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within, act} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {RegressionCounts, RegressionRun, RegressionStatus, Session} from '@magicstick/dashboard-contracts';
import {reportCountsFixture} from '../../regression/fixtures/regression-results';
import {RegressionPage} from './RegressionPage';
import {allowedStatusSections, isStatusSection} from './SystemPage';
import {api} from '../api';

vi.mock('../api', () => ({api: {regression: vi.fn(), enableModule: vi.fn(), registerRegression: vi.fn(),
  startRegression: vi.fn(), recoverRegressionLock: vi.fn(), cancelRegression: vi.fn(), downloadRegression: vi.fn()}}));
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
  it('puts all checks first, including runner and cleanup failures without scenario IDs',async()=>{
    const result=reportCountsFixture();
    data.runs=[{...run(),phase:'Failed',phases:[0],result,reportAvailable:true,
      progress:{percent:100,completedPhases:1,totalPhases:1}}];
    const original=structuredClone(data.runs[0]),client=mount();
    const checks=await screen.findByLabelText('All checks');
    for(const value of ['441','3','18'])expect(within(checks).getByText(value,{selector:'strong'})).toBeVisible();
    expect(checks).toHaveTextContent('1 by prerequisite · 17 by failure');
    expect(screen.getByText('Case / variant / layer evidence · isolated + live')).toBeVisible();
    const toggle=screen.getByText('Executable scenarios',{selector:'summary'});
    expect(toggle.closest('details')).not.toHaveAttribute('open');
    const scenarios=screen.getByLabelText('Executable scenario results');expect(scenarios).not.toBeVisible();
    await userEvent.click(toggle);expect(scenarios).toBeVisible();
    for(const value of ['345','0','1'])expect(within(scenarios).getByText(value,{selector:'strong'})).toBeVisible();
    expect(scenarios).toHaveTextContent('1 by prerequisite · 0 by failure');
    expect(screen.getByLabelText('Live evidence results')).toHaveTextContent('8 passed · 3 failed · 18 blocked');
    expect(screen.getByText('100% means execution finished, not passed.')).toBeVisible();
    await act(async()=>{await client.refetchQueries({queryKey:['regression']});});
    expect(data.runs[0]).toEqual(original);
    expect(api.startRegression).not.toHaveBeenCalled();expect(api.cancelRegression).not.toHaveBeenCalled();
    expect(api.recoverRegressionLock).not.toHaveBeenCalled();
  });
  it('uses complete report totals, not summed phases or the limited non-passing case list',async()=>{
    const result=reportCountsFixture();
    result.phases.push({...structuredClone(result.phases[0]!),phase:4});
    result.cases=result.cases.slice(0,1);result.omittedCases=20;
    data.runs=[{...run(),phase:'Failed',phases:[0,4],result}];mount();
    const checks=await screen.findByLabelText('All checks');
    expect(within(checks).getByText('441',{selector:'strong'})).toBeVisible();
    expect(within(checks).getByText('3',{selector:'strong'})).toBeVisible();
    expect(within(checks).queryByText('882')).toBeNull();
    expect(screen.getByText('Failures and blocked checks (1 shown; 20 more in the report)')).toBeVisible();
  });
  for(const phase of ['Running','Failed'] as const)it(`labels ${phase} scenario counts as preliminary when final totals are unavailable`,async()=>{
    data.runs=[{...run(),phase,result:undefined}];mount();
    expect(await screen.findByLabelText('All checks availability')).toHaveTextContent('All-check totals are not available');
    expect(screen.queryByLabelText('All checks')).toBeNull();
    await userEvent.click(screen.getByText('Executable scenarios',{selector:'summary'}));
    expect(screen.getByText('Preliminary executable scenario counts; these are not all-check totals.')).toBeVisible();
    const scenarios=screen.getByLabelText('Executable scenario results');
    for(const value of ['20','1','2'])expect(within(scenarios).getByText(value,{selector:'strong'})).toBeVisible();
    expect(api.startRegression).not.toHaveBeenCalled();expect(api.recoverRegressionLock).not.toHaveBeenCalled();
  });
  for(const counts of [undefined,{Passed:441,Blocked:18},{Passed:441,Failed:-1,Blocked:18},
    {Passed:441,Failed:'3',Blocked:18}] as unknown[])it(`does not manufacture final zeros from missing or invalid legacy totals ${JSON.stringify(counts)}`,async()=>{
    data.runs=[{...run(),phase:'Failed',result:{...reportCountsFixture(),counts:counts as RegressionCounts}}];mount();
    expect(await screen.findByLabelText('All checks availability')).toHaveTextContent('All-check totals are not available');
    expect(screen.queryByLabelText('All checks')).toBeNull();
    await userEvent.click(screen.getByText('Executable scenarios',{selector:'summary'}));
    expect(screen.getByText('Preliminary executable scenario counts; these are not all-check totals.')).toBeVisible();
  });
  it('does not substitute stale progress for absent final scenario totals in an older report',async()=>{
    const result=reportCountsFixture();result.executionCounts=undefined as unknown as RegressionCounts;
    data.runs=[{...run(),phase:'Failed',result}];mount();
    expect(await screen.findByLabelText('All checks')).toHaveTextContent('441');
    expect(screen.queryByLabelText('Executable scenario results')).toBeNull();
    expect(screen.queryByText('Executable scenarios',{selector:'summary'})).toBeNull();
  });
  it('keeps a genuinely recorded all-zero report distinct from missing final totals',async()=>{
    data.runs=[{...run(),phase:'Failed',result:{...reportCountsFixture(),counts:{Passed:0,Failed:0,Blocked:0},
      cases:[],phases:[],evidenceCounts:undefined,blockedCounts:undefined}}];mount();
    expect(await screen.findByLabelText('All checks')).toHaveTextContent('check evidence');
    expect(within(screen.getByLabelText('All checks')).getAllByText('0',{selector:'strong'})).toHaveLength(3);
    expect(screen.queryByLabelText('All checks availability')).toBeNull();
  });
  it('selects only the server-advertised diagnostic phase, locks phase edits and sends only its ID',async()=>{
    data.diagnosticSelections=[{id:'slot-race',title:'Last GPU slot race',caseIds:['SLOT-09'],phase:4},
      {id:'external-route',title:'External provider',caseIds:['ROUTE-05'],phase:2},
      {id:'gpu-validation-single',title:'GPU verification',caseIds:['HW-06'],phase:3}];
    mount();await userEvent.click(await screen.findByRole('button',{name:'Start regression tests'}));
    const dialog=screen.getByRole('dialog');
    for(const profile of data.diagnosticSelections) {
      await userEvent.selectOptions(within(dialog).getByRole('combobox',{name:'Test selection'}),profile.id);
      expect(within(dialog).getByRole('radio',{name:'Include destructive tests'})).toBeChecked();
      for(const checkbox of within(dialog).getAllByRole('checkbox'))expect(checkbox).toBeDisabled();
      for(let phase=0;phase<=8;phase++)expect(within(dialog).getByRole('checkbox',{name:new RegExp('^Phase '+phase)}))
        .toHaveProperty('checked',phase===profile.phase);
      expect(within(dialog).getByText(new RegExp('Only this Phase '+profile.phase+' diagnostic subset'))).toBeVisible();
    }
    expect(api.startRegression).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button',{name:'Start tests'}));
    await waitFor(()=>expect(api.startRegression).toHaveBeenCalledWith(expect.any(String),[3],'full','gpu-validation-single'));
  });
  it('returning to safe mode clears the diagnostic and old installations do not offer unsupported selections',async()=>{
    data.diagnosticSelections=[{id:'reload',title:'Reload',caseIds:['SHR-12'],phase:4}];
    const client=mount();await userEvent.click(await screen.findByRole('button',{name:'Start regression tests'}));
    const dialog=screen.getByRole('dialog'),selection=within(dialog).getByRole('combobox',{name:'Test selection'});
    await userEvent.selectOptions(selection,'reload');
    await userEvent.click(within(dialog).getByRole('radio',{name:'Non-destructive only'}));
    expect(selection).toHaveValue('');expect(within(dialog).getByRole('checkbox',{name:/^Phase 4/})).toBeEnabled();
    data={...data,diagnosticSelections:undefined};
    await act(async()=>{await client.refetchQueries({queryKey:['regression']});});
    await waitFor(()=>expect(within(dialog).queryByRole('combobox',{name:'Test selection'})).toBeNull());
    await userEvent.click(within(dialog).getByRole('button',{name:'Start tests'}));
    await waitFor(()=>expect(api.startRegression).toHaveBeenCalledWith(expect.any(String),[4],'non-destructive'));
  });
  it('retains the saved diagnostic scope after reload without claiming a complete phase',async()=>{
    data.runs=[{...run(),phases:[4],diagnosticSelection:'restoration',testMode:'full'}];
    mount();expect(await screen.findByLabelText('Diagnostic selection')).toHaveTextContent('restoration');
    expect(screen.getByLabelText('Diagnostic selection')).toHaveTextContent('Full-phase acceptance is not assessed');
    expect(api.startRegression).not.toHaveBeenCalled();
  });
  it('defaults to non-destructive checks and never sends a test before confirmation',async()=>{
    mount();await userEvent.click(await screen.findByRole('button',{name:'Start regression tests'}));
    const dialog=screen.getByRole('dialog');
    expect(within(dialog).getByRole('radio',{name:'Non-destructive only'})).toBeChecked();
    expect(within(dialog).getByText(/temporary viewer account/)).toBeVisible();
    expect(within(dialog).queryByText(/Existing models may be stopped/)).toBeNull();
    expect(api.startRegression).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button',{name:'Start tests'}));
    await waitFor(()=>expect(api.startRegression).toHaveBeenCalledWith(expect.any(String),[0,1,2,3,4,5,6,7,8],'non-destructive'));
  });
  it('requires separate previous-run cleanup in non-destructive mode and allows an explicit full selection',async()=>{
    data.lock={state:'stale',canRecover:true,revision:'fixture:42',message:'Cleanup is required.'};data.recoveryAvailable=true;
    data.runs=[{...run(),phase:'Failed',credentialsCleaned:false}];
    mount();await userEvent.click(await screen.findByRole('button',{name:'Start regression tests'}));
    const dialog=screen.getByRole('dialog');
    expect(within(dialog).getByRole('button',{name:'Start tests'})).toBeDisabled();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Clean up the previous run separately');
    await userEvent.click(within(dialog).getByRole('radio',{name:'Include destructive tests'}));
    expect(within(dialog).getByRole('button',{name:'Start tests'})).toBeEnabled();
    expect(within(dialog).getByText(/Existing models may be stopped/)).toBeVisible();
    expect(api.startRegression).not.toHaveBeenCalled();expect(api.recoverRegressionLock).not.toHaveBeenCalled();
  });
  it('shows the saved mode and intentional exclusions separately from failed or blocked checks',async()=>{
    data.runs=[{...run(),testMode:'non-destructive',phase:'Passed',credentialsCleaned:true,result:{
      testMode:'non-destructive',excludedSteps:['phase3/phase3-gpu'],counts:{Passed:1,Failed:0,Blocked:0},
      executionCounts:{Passed:1,Failed:0,Blocked:0},recoveryRequired:false,omittedCases:0,phases:[],cases:[]}}];
    mount();expect(await screen.findByLabelText('Test mode')).toHaveTextContent('Non-destructive only');
    await userEvent.click(screen.getByText('Not selected in this mode (1 steps)'));
    expect(screen.getByText('phase3/phase3-gpu')).toBeVisible();
    expect(screen.getByText(/Full-phase acceptance was not assessed/)).toBeVisible();
    expect(screen.queryByText(/Failures and blocked checks/)).toBeNull();
  });
  it('shows activation request and readiness separately and prevents duplicate enables', async () => {
    data = {...data, registered: false, runtimeAvailable: false, sourceRevision: '', message: 'Enable the regression runner.'};
    let finish!: () => void;
    vi.mocked(api.enableModule).mockImplementationOnce(() => new Promise(resolve => {finish = () => resolve({});}));
    const client = mount();
    await userEvent.click(await screen.findByRole('button', {name: 'Enable regression runner'}));
    const progress = screen.getByRole('progressbar', {name: 'Regression runner activation'});
    expect(progress).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByRole('button', {name: 'Enabling regression runner…'})).toBeDisabled();
    expect(screen.getByText('Sending runner activation request…')).toBeVisible();
    expect(screen.getByRole('button', {name: 'Refresh tests'})).toBeEnabled();
    expect(screen.getByRole('button', {name: 'Start regression tests'})).toBeDisabled();
    await act(async () => {finish();});
    await waitFor(() => expect(screen.getByRole('button', {name: 'Waiting for runner readiness…'})).toBeDisabled());
    expect(screen.getByText('Activation requested. Waiting for the regression runner to become ready…')).toBeVisible();
    await userEvent.click(screen.getByRole('button', {name: 'Waiting for runner readiness…'}));
    expect(api.enableModule).toHaveBeenCalledExactlyOnceWith('regression');
    data = {...data, runtimeAvailable: true, sourceRevision: 'b'.repeat(40), message: ''};
    await act(async () => {await client.refetchQueries({queryKey: ['regression']});});
    expect(await screen.findByText('Regression runner is ready. Register this disposable test Appliance to continue.')).toBeVisible();
    expect(screen.queryByRole('progressbar', {name: 'Regression runner activation'})).toBeNull();
    expect(screen.getByRole('button', {name: 'Register test Appliance'})).toBeEnabled();
    expect(api.startRegression).not.toHaveBeenCalled();
    expect(api.registerRegression).not.toHaveBeenCalled();
  });
  it('clears the pending activation indicator on request failure and permits an explicit retry', async () => {
    data = {...data, registered: false, runtimeAvailable: false, sourceRevision: '', message: 'Enable the regression runner.'};
    let fail!: (error: Error) => void;
    vi.mocked(api.enableModule).mockImplementationOnce(() => new Promise((_resolve, reject) => {fail = reject;}));
    mount();await userEvent.click(await screen.findByRole('button', {name: 'Enable regression runner'}));
    expect(screen.getByRole('progressbar', {name: 'Regression runner activation'})).toBeVisible();
    await act(async () => {fail(new Error('Synthetic activation request failure'));});
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic activation request failure');
    expect(screen.queryByRole('progressbar', {name: 'Regression runner activation'})).toBeNull();
    expect(screen.getByRole('button', {name: 'Enable regression runner'})).toBeEnabled();
    expect(api.enableModule).toHaveBeenCalledTimes(1);
    vi.mocked(api.enableModule).mockResolvedValueOnce({});
    await userEvent.click(screen.getByRole('button', {name: 'Enable regression runner'}));
    await waitFor(() => expect(screen.getByRole('button', {name: 'Waiting for runner readiness…'})).toBeDisabled());
    expect(api.enableModule).toHaveBeenCalledTimes(2);
    expect(api.startRegression).not.toHaveBeenCalled();
  });
  it('offers retained-access cleanup with a free lock and never starts a test suite', async () => {
    data.lock={state:'free',canRecover:false,message:'No regression lock is held.'};
    data.recoveryAvailable=true;
    data.cleanup={available:true,revision:'fixture:42',released:true,message:'Retained setup access needs cleanup.'};
    data.runs=[{...run(),phase:'Cancelled'}];
    vi.mocked(api.recoverRegressionLock).mockResolvedValue({...run(),operation:'recover-lock',phases:[]});
    mount();await userEvent.click(await screen.findByRole('button',{name:'Clean up previous test run'}));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Clean up previous run'}));
    await waitFor(()=>expect(api.recoverRegressionLock).toHaveBeenCalledWith(expect.any(String),'fixture:42'));
    expect(api.startRegression).not.toHaveBeenCalled();
  });
  it('explains why cleanup is disabled instead of claiming an unverified clean baseline', async () => {
    data.cleanup={available:false,message:'The exact previous journal could not be verified.'};
    data.runs=[{...run(),phase:'Cancelled'}];
    mount();const button=await screen.findByRole('button',{name:'Clean up previous test run'});
    expect(button).toBeDisabled();expect(button).toHaveAccessibleDescription('The exact previous journal could not be verified.');
    expect(screen.queryByText(/No previous test run needs cleanup/)).toBeNull();
  });
  it('opens and refreshes without starting tests or changing the server', async () => {
    mount(); expect(await screen.findByRole('button', {name: 'Start regression tests'})).toBeEnabled();
    expect(screen.getByRole('button',{name:'Clean up previous test run'})).toBeDisabled();
    expect(screen.getByText(/No previous test run needs cleanup/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', {name: 'Refresh tests'}));
    expect(api.startRegression).not.toHaveBeenCalled(); expect(api.enableModule).not.toHaveBeenCalled(); expect(api.registerRegression).not.toHaveBeenCalled();
    expect(api.recoverRegressionLock).not.toHaveBeenCalled();
  });
  it('recovers only the reviewed stale lock after confirmation and leaves starting tests separate', async () => {
    data.lock = {state: 'stale', canRecover: true, revision: '11111111-2222-3333-4444-555555555555:42',
      message: 'The old run has terminated; cleanup will be verified.'};
    vi.mocked(api.recoverRegressionLock).mockResolvedValue({...run(), operation: 'recover-lock', phases: []});
    mount(); await userEvent.click(await screen.findByRole('button', {name: 'Clean up previous test run'}));
    expect(api.recoverRegressionLock).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', {name: 'Clean up previous test run'});
    expect(within(dialog).getByText(/No new regression tests will start/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', {name: 'Clean up previous run'}));
    await waitFor(() => expect(api.recoverRegressionLock).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{32}$/), data.lock!.revision));
    expect(api.startRegression).not.toHaveBeenCalled();
  });
  it('normal Start requests a fresh suite after automatic cleanup and preserves the failed historical report', async () => {
    data.lock={state:'stale',canRecover:true,revision:'fixture:42',message:'Owned previous run can be cleaned up.'};
    data.recoveryAvailable=true;
    data.runs=[{...run(),phase:'Failed',reportAvailable:true,credentialsCleaned:false,message:'Original failed result'}];
    mount();await userEvent.click(await screen.findByRole('button',{name:'Start regression tests'}));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('radio',{name:'Include destructive tests'}));
    expect(screen.getByText(/automatically clean up the previous run first/)).toBeVisible();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:/^Start tests$/}));
    await waitFor(()=>expect(api.startRegression).toHaveBeenCalledTimes(1));
    const requestId=vi.mocked(api.startRegression).mock.calls[0]![0];
    expect(requestId).toMatch(/^[a-f0-9]{32}$/);expect('regression-'+requestId).not.toBe(data.runs[0]!.id);
    expect(api.recoverRegressionLock).not.toHaveBeenCalled();
    expect(screen.getByText('Original failed result')).toBeVisible();
    expect(screen.getByRole('button',{name:'Download report'})).toBeEnabled();
  });
  it('explains external, active and ambiguous locks without allowing unsafe release', async () => {
    data.lock = {state: 'stale', canRecover: false, revision: 'fixture:42', message: 'The exact private journal is on the external runner.'};
    const client = mount();
    expect(await screen.findByRole('button', {name: 'Clean up previous test run'})).toBeDisabled();
    expect(screen.getByText(/exact private journal is on the external runner/)).toBeVisible();
    expect(screen.getByRole('button', {name: 'Start regression tests'})).toBeDisabled();
    for (const state of ['active', 'blocked'] as const) {
      data = {...data, lock: {...data.lock!, state, message: 'This lock cannot be recovered yet.'}};
      await act(async () => {await client.refetchQueries({queryKey: ['regression']});});
      expect(screen.getByRole('button', {name: 'Clean up previous test run'})).toBeDisabled();
    }
    expect(api.recoverRegressionLock).not.toHaveBeenCalled();
  });
  it('refuses a lock that changes after opening its recovery dialog', async () => {
    data.lock = {state: 'stale', canRecover: true, revision: 'fixture:42', message: 'Ready for recovery.'};
    const client = mount();
    await userEvent.click(await screen.findByRole('button', {name: 'Clean up previous test run'}));
    data = {...data, lock: {...data.lock, revision: 'fixture:43'}};
    await act(async () => {await client.refetchQueries({queryKey: ['regression']});});
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', {name: 'Clean up previous run'}));
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
    expect(api.recoverRegressionLock).not.toHaveBeenCalled();
  });
  it('shows recovery as zero-phase work and keeps failure reports accessible', async () => {
    data.runs = [{...run(), operation: 'recover-lock', phases: [], phase: 'Failed',
      message: 'Cleanup could not be verified; the lock was retained.', progress: {percent: 100, totalPhases: 0}, reportAvailable: true}];
    mount(); expect(await screen.findByText('Previous run cleanup')).toBeVisible();
    expect(screen.getByText(/No test phases are selected/)).toBeVisible();
    expect(screen.getByRole('button', {name: 'Download report'})).toBeEnabled();
    expect(api.startRegression).not.toHaveBeenCalled();
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
  it('registers the nested System Status tab and direct route only for administrators', () => {
    expect(isStatusSection('regression')).toBe(true);
    for (const role of ['magicstick-user', 'magicstick-viewer', 'magicstick-operator', 'magicstick-admin'])
      expect(allowedStatusSections({roles: [role]} as Session).some(s => s.id === 'regression')).toBe(role === 'magicstick-admin');
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
    await userEvent.click(within(dialog).getByRole('radio',{name:'Include destructive tests'}));
    expect(within(dialog).getByText(/Existing models may be stopped/)).toBeVisible();
    expect(within(dialog).getAllByRole('checkbox',{checked:true})).toHaveLength(9);
    await userEvent.click(within(dialog).getByRole('button', {name: 'Start tests'}));
    await waitFor(() => expect(api.startRegression).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{32}$/),[0,1,2,3,4,5,6,7,8],'full'));
    await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button',{name:'Start regression tests'}));
    expect(within(screen.getByRole('dialog')).getByRole('radio',{name:'Non-destructive only'})).toBeChecked();
  });
  it('requires a nonempty selection, preserves it during polling and starts only Phase 3',async()=>{
    const client=mount();await userEvent.click(await screen.findByRole('button',{name:'Start regression tests'}));
    const dialog=screen.getByRole('dialog'),start=within(dialog).getByRole('button',{name:'Start tests'});
    await userEvent.click(within(dialog).getByRole('button',{name:'Clear selection'}));
    expect(start).toBeDisabled();expect(within(dialog).getByRole('alert')).toHaveTextContent('Select at least one test phase.');
    await userEvent.click(start);expect(api.startRegression).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('checkbox',{name:/^Phase 3 ·/}));
    await act(async()=>{await client.refetchQueries({queryKey:['regression']});});
    expect(within(dialog).getAllByRole('checkbox',{checked:true})).toHaveLength(1);
    expect(within(dialog).getByRole('status')).toHaveTextContent('Selected phases: 3.');
    await userEvent.click(start);
    await waitFor(()=>expect(api.startRegression).toHaveBeenCalledWith(expect.any(String),[3],'non-destructive'));
    expect(api.recoverRegressionLock).not.toHaveBeenCalled();
  });
  it('keeps a cancelled draft without starting tests and offers all phases again',async()=>{
    mount();await userEvent.click(await screen.findByRole('button',{name:'Start regression tests'}));
    let dialog=screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button',{name:'Clear selection'}));
    await userEvent.click(within(dialog).getByRole('checkbox',{name:/^Phase 5 ·/}));
    await userEvent.click(within(dialog).getByRole('checkbox',{name:/^Phase 3 ·/}));
    await userEvent.click(within(dialog).getByRole('button',{name:'Cancel'}));
    expect(api.startRegression).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button',{name:'Start regression tests'}));dialog=screen.getByRole('dialog');
    expect(within(dialog).getByRole('status')).toHaveTextContent('Selected phases: 3, 5.');
    await userEvent.click(within(dialog).getByRole('button',{name:'Select all'}));
    expect(within(dialog).getAllByRole('checkbox',{checked:true})).toHaveLength(9);
  });
  it('freezes a submitted selection and retains it when starting fails',async()=>{
    let reject!:(error:Error)=>void;
    vi.mocked(api.startRegression).mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
    mount();await userEvent.click(await screen.findByRole('button',{name:'Start regression tests'}));
    const dialog=screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button',{name:'Clear selection'}));
    await userEvent.click(within(dialog).getByRole('checkbox',{name:/^Phase 5 ·/}));
    await userEvent.click(within(dialog).getByRole('checkbox',{name:/^Phase 3 ·/}));
    const start=within(dialog).getByRole('button',{name:'Start tests'});await userEvent.click(start);
    expect(start).toBeDisabled();expect(within(dialog).getByRole('checkbox',{name:/^Phase 3 ·/})).toBeDisabled();
    expect(within(dialog).getByRole('radio',{name:'Non-destructive only'})).toBeDisabled();
    expect(api.startRegression).toHaveBeenCalledWith(expect.any(String),[3,5],'non-destructive');
    await act(async()=>{reject(new Error('Synthetic start failure'));});
    await waitFor(()=>expect(start).toBeEnabled());
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Synthetic start failure');
    expect(within(dialog).getByRole('status')).toHaveTextContent('Selected phases: 3, 5.');
    expect(api.startRegression).toHaveBeenCalledTimes(1);
  });
  it('shows the saved subset after reload and uses its phase count before runner progress arrives',async()=>{
    data.runs=[{...run(),phases:[3],phase:'Queued',progress:{}}];mount();
    expect(await screen.findByLabelText('Selected test phases')).toHaveTextContent('Selected phases: 3.');
    expect(screen.getByText(/0 \/ 1 phase finished/)).toBeVisible();
    expect(screen.queryByText(/0 \/ 9 phases finished/)).toBeNull();
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
  it('distinguishes finished tests, open resource cleanup and a removed account',async()=>{
    data.runs=[{...run(),phase:'Failed',credentialsCleaned:true,cleanup:{state:'required',reason:'CLEANUP',stage:'recovery-journal'}}];
    mount();const lifecycle=await screen.findByLabelText('Run lifecycle');
    expect(lifecycle).toHaveTextContent('Tests: finished');expect(lifecycle).toHaveTextContent('Resource cleanup: required');
    expect(lifecycle).toHaveTextContent('Test account: removed');
    expect(screen.getByText(/Previous-run resource cleanup is not verified/)).toBeVisible();
    expect(screen.getByText(/Cleanup reason: CLEANUP/)).toHaveTextContent('recovery-journal');
    expect(screen.getByRole('button',{name:'Start regression tests'})).toBeDisabled();
    expect(screen.queryByText(/Removing the completed run/)).toBeNull();
  });
  it('labels missing legacy cleanup evidence as unknown without changing old outcomes',async()=>{
    data.runs=[{...run(),phase:'Failed',credentialsCleaned:true}];mount();
    expect(await screen.findByLabelText('Run lifecycle')).toHaveTextContent('Resource cleanup: unknown (legacy or not verified)');
    expect(api.recoverRegressionLock).not.toHaveBeenCalled();
  });
  it('shows verified cleanup independently of a historical failure and pending account removal',async()=>{
    data.runs=[{...run(),phase:'Failed',credentialsCleaned:false,cleanup:{state:'verified',checkedAt:'2026-10-22T12:00:00Z'}}];mount();
    expect(await screen.findByLabelText('Run lifecycle')).toHaveTextContent('Resource cleanup: verified');
    expect(screen.getByLabelText('Run lifecycle')).toHaveTextContent('Test account: not yet removed');
    expect(screen.queryByText(/Resource cleanup could not be verified/)).toBeNull();
  });
  it('retains completed test totals and an actionable export failure without suggesting recovery',async()=>{
    data.lock={state:'free',canRecover:false,message:'Lab lock is free.'};
    data.runs=[{...run(),phase:'Failed',credentialsCleaned:true,reportAvailable:false,
      message:'Execution finished, but report export failed. Recorded test results were retained; inspect HAR-10 at report-export.',
      progress:{percent:100,completedPhases:9,totalPhases:9},result:{
        counts:{Passed:4532,Failed:17,Blocked:145},executionCounts:{Passed:3402,Failed:6,Blocked:56},
        recoveryRequired:false,omittedCases:0,phases:[],cases:[{id:'HAR-10',layer:'A',variant:'',outcome:'Failed',reason:'REPORT_EXPORT',
          stage:'report-export',message:'Sanitized report export failed; recorded test results were retained.',
          action:'Inspect report size and storage; do not force recovery.',durationMs:0}]}}];
    mount();expect(await screen.findByText(/Execution finished, but report export failed/)).toBeVisible();
    const checks=screen.getByLabelText('All checks');
    for(const value of ['4532','17','145'])expect(within(checks).getByText(value,{selector:'strong'})).toBeVisible();
    await userEvent.click(screen.getByText('Executable scenarios',{selector:'summary'}));
    expect(screen.getByLabelText('Executable scenario results')).toHaveTextContent('3402');
    expect(screen.getByRole('button',{name:'Download report'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'Start regression tests'})).toBeEnabled();
    await userEvent.click(screen.getByText('Failures and blocked checks (1)'));
    expect(screen.getByText('REPORT_EXPORT')).toBeVisible();
    expect(screen.getByText(/Stage: report-export/)).toBeVisible();
    expect(api.recoverRegressionLock).not.toHaveBeenCalled();expect(api.startRegression).not.toHaveBeenCalled();
  });
  it('shows the failed preparation stage and zero passed live evidence despite successful isolated scenarios',async()=>{
    data.runs=[{...run(),phase:'Failed',reportAvailable:true,credentialsCleaned:true,progress:{percent:100,completedPhases:9,totalPhases:9},
      result:{counts:{Passed:100,Failed:1,Blocked:30},executionCounts:{Passed:80,Failed:0,Blocked:0},recoveryRequired:false,omittedCases:0,
        phases:[],cases:[],evidenceCounts:{fixture:{Passed:100,Failed:0,Blocked:0},live:{Passed:0,Failed:1,Blocked:30}},
        preparation:{version:1,outcome:'Failed',reason:'REVISION',setupStage:'input-validation',
          message:'Automatic preparation: Failed (REVISION); setup stage: input-validation.',action:'Check the installed image and source revisions.'}}}];
    mount();const preparation=await screen.findByRole('alert',{name:'Automatic preparation result'});
    expect(preparation).toHaveTextContent('input-validation');expect(preparation).toHaveTextContent('REVISION');
    expect(preparation).toHaveTextContent('Check the installed image and source revisions');
    expect(preparation).toHaveTextContent('Passed isolated checks are not live acceptance');
    expect(within(screen.getByLabelText('All checks')).getByText('1',{selector:'strong'})).toBeVisible();
    expect(screen.getByLabelText('Live evidence results')).toHaveTextContent('0 passed · 1 failed · 30 blocked');
    expect(screen.getByRole('button',{name:'Download report'})).toBeEnabled();
    expect(api.startRegression).not.toHaveBeenCalled();expect(api.recoverRegressionLock).not.toHaveBeenCalled();
  });
  it('shows live blocked counts by prerequisite and failure without changing the total', async () => {
    data.runs=[{...run(),progress:{...run().progress,
      executionBlockedCounts:{prerequisite:1,failure:1,cancelled:0,unknown:0}}}];
    mount();await userEvent.click(await screen.findByText('Executable scenarios',{selector:'summary'}));
    const metrics=screen.getByLabelText('Executable scenario results');
    expect(within(metrics).getByText('1 by prerequisite · 1 by failure')).toBeVisible();
    expect(within(metrics).getByText('2',{selector:'strong'})).toBeVisible();
  });
  it('distinguishes prerequisite and failure blocks, retaining the failed original check and its trace',async()=>{
    data.runs=[{...run(),phase:'Failed',reportAvailable:true,credentialsCleaned:true,result:{
      counts:{Passed:20,Failed:1,Blocked:2},executionCounts:{Passed:10,Failed:1,Blocked:1},
      blockedCounts:{prerequisite:1,failure:1,cancelled:0,unknown:0},executionBlockedCounts:{prerequisite:1,failure:0,cancelled:0,unknown:0},
      recoveryRequired:false,omittedCases:0,phases:[{phase:3,outcome:'Failed',counts:{Passed:20,Failed:1,Blocked:2},
        executionCounts:{Passed:10,Failed:1,Blocked:1},blockedCounts:{prerequisite:1,failure:1,cancelled:0,unknown:0}}],
      cases:[{id:'HW-01',outcome:'Blocked',layer:'A',variant:'p3-inventory',reason:'CAPABILITY',message:'Missing GPU.',action:'Provide real GPU hardware.',durationMs:0,blockedBy:{kind:'prerequisite',reason:'CAPABILITY'}},
        {id:'LIFE-04',outcome:'Blocked',layer:'E',variant:'p3-runtime-start',reason:'DEPENDENCY',message:'An earlier model stop failed.',action:'Fix the earlier failed step.',durationMs:0,
          blockedBy:{kind:'failure',caseId:'LIFE-03',reason:'DEADLINE',stage:'model-stopped',executionId:'a'.repeat(24),traceRunId:'reg-11111111-2222-3333-4444-555555555555'}}]
    }}];
    mount();await screen.findByText('Failures and blocked checks (2)');
    await userEvent.click(screen.getByText('Failures and blocked checks (2)'));
    expect(screen.getByText('Blocked by prerequisite')).toBeVisible();expect(screen.getByText('Blocked by failure')).toBeVisible();
    expect(screen.getByText('LIFE-03',{exact:true}).closest('p')).toHaveTextContent('LIFE-03 · DEADLINE · Stage: model-stopped');
    await userEvent.click(screen.getByText('Blocking scenario trace'));
    expect(screen.getByText(/report-artifacts\/reg-11111111/)).toHaveTextContent('a'.repeat(24)+'.json');
    expect(screen.getByText(/Blocked evidence \(case \/ variant \/ layer\): 1 by prerequisite · 1 by failure/)).toBeVisible();
    expect(api.startRegression).not.toHaveBeenCalled();
  });
  it('keeps unclassified legacy dependencies and cancellation distinct from missing prerequisites',async()=>{
    data.runs=[{...run(),phase:'Blocked',reportAvailable:true,credentialsCleaned:true,result:{
      counts:{Passed:0,Failed:0,Blocked:3},executionCounts:{Passed:0,Failed:0,Blocked:3},recoveryRequired:false,omittedCases:0,phases:[],
      cases:[{id:'LIFE-04',outcome:'Blocked',layer:'E',variant:'',reason:'DEPENDENCY',message:'Earlier step was not recorded.',action:'Inspect the earlier trace.',durationMs:0},
        {id:'HW-01',outcome:'Blocked',layer:'A',variant:'',reason:'PREREQUISITE',message:'Older missing evidence has no recorded cause.',action:'Inspect missing evidence.',durationMs:0},
        {id:'HAR-10',outcome:'Blocked',layer:'U',variant:'',reason:'CANCELLED',message:'Run cancelled.',action:'Repeat when ready.',durationMs:0}]
    }}];
    mount();await screen.findByText('Failures and blocked checks (3)');await userEvent.click(screen.getByText('Failures and blocked checks (3)'));
    expect(screen.getAllByText('Blocked — cause unknown')).toHaveLength(2);expect(screen.getByText('Blocked by cancellation')).toBeVisible();
    expect(within(screen.getByLabelText('All checks')).getByText('Cause breakdown unavailable for this older run.')).toBeVisible();
  });
  it('can start verified recovery without asking for the original credentials or clearing a lock', async () => {
    data.runs = [{...run(), phase: 'Cancelled', credentialsCleaned: false}]; data.recoveryAvailable = true;
    mount(); expect(await screen.findByRole('button', {name: 'Start regression tests'})).toBeEnabled();
    expect(screen.getByText(/automatically clean up the previous run first/)).toBeVisible();
    expect(api.startRegression).not.toHaveBeenCalled();
  });
});
