import {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {RegressionBlockedCounts,RegressionCounts,RegressionPhase,RegressionResult,RegressionRun,RegressionTestMode} from '@magicstick/dashboard-contracts';
import {regressionBlockedKind,regressionBlockedLabel,regressionBlockedSummary} from '@magicstick/dashboard-core';
import {api} from '../api';
import {Button, ConfirmDialog, Empty, ErrorNotice, Field, Loading, Panel, StatusBadge} from '../components';

const terminal = new Set(['Passed', 'Failed', 'Blocked', 'Cancelled']);
const phaseOptions = [
  {phase: 0, name: 'Runner and safety'},
  {phase: 1, name: 'Core dashboard workflows'},
  {phase: 2, name: 'Model configuration and lifecycle'},
  {phase: 3, name: 'GPUs and multi-GPU models'},
  {phase: 4, name: 'GPU sharing and slots'},
  {phase: 5, name: 'Services and administration'},
  {phase: 6, name: 'Host maintenance'},
  {phase: 7, name: 'Mesh and Realtime'},
  {phase: 8, name: 'Security, usability and performance'},
] as const;
const allPhases = phaseOptions.map(option => option.phase);
const timestamp = (value?: string) => value ? new Date(value).toLocaleString() : '—';
const BlockedBreakdown = ({counts,total}: {counts?: RegressionBlockedCounts;total: number}) =>
  total===0 ? null : counts ? <small>{regressionBlockedSummary(counts)}</small> : <small>Cause breakdown unavailable for this older run.</small>;
const recordedCounts = (value:unknown):value is RegressionCounts => Boolean(value && typeof value==='object' &&
  (['Passed','Failed','Blocked'] as const).every(outcome=>{
    const count=(value as Record<string,unknown>)[outcome];
    return typeof count==='number' && Number.isSafeInteger(count) && count>=0;
  }));
const OutcomeMetrics = ({counts,blockedCounts,label,unit}: {
  counts:RegressionCounts;blockedCounts?:RegressionBlockedCounts;label:string;unit:string;
}) => <div className="metric-grid three" aria-label={label}>
  {(['Passed','Failed','Blocked'] as const).map(outcome=><article className="metric" key={outcome}>
    <span>{outcome}</span><strong>{counts[outcome]}</strong><small>{unit}</small>
    {outcome==='Blocked'&&<BlockedBreakdown counts={blockedCounts} total={counts.Blocked}/>}
  </article>)}
</div>;
const CaseBadge = ({row}: {row:RegressionResult['cases'][number]}) => {
  if(row.outcome!=='Blocked')return <StatusBadge phase={row.outcome}/>;
  const kind=row.blockedBy?.kind ?? (row.reason==='PREREQUISITE'&&!row.executionId?'unknown':regressionBlockedKind(row.reason));
  return <span className={`status status-${kind==='failure'?'bad':'warn'}`}>{regressionBlockedLabel(kind)}</span>;
};
const Result = ({run}: {run: RegressionRun}) => {
  const [downloadError, setDownloadError] = useState<unknown>();
  const [downloading, setDownloading] = useState(false);
  const percent = Math.max(0, Math.min(100, run.progress.percent ?? 0));
  const totalPhases = run.progress.totalPhases ?? run.phases.length;
  // Report totals include evidence outside executable scenarios (for example,
  // setup/runner/cleanup failures). Never infer them from progress or a limited
  // non-passing case list, nor sum overlapping phase results.
  const counts = recordedCounts(run.result?.counts) ? run.result.counts : undefined;
  const executionCounts = recordedCounts(run.result?.executionCounts) ? run.result.executionCounts :
    !run.result && recordedCounts(run.progress.executionCounts) ? run.progress.executionCounts : undefined;
  const executionBlockedCounts=run.result ? run.result.executionBlockedCounts : run.progress.executionBlockedCounts;
  const preparation=run.result?.preparation;
  const download = async (kind: 'archive' | 'html' | 'junit') => {
    setDownloading(true); setDownloadError(undefined);
    try {
      const blob = await api.downloadRegression(run.id, kind), url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `magicstick-${run.id}.${kind === 'archive' ? 'tar.gz' : kind === 'html' ? 'html' : 'xml'}`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {setDownloadError(error);} finally {setDownloading(false);}
  };
  return <Panel title={run.operation === 'recover-lock' ? 'Previous run cleanup' : timestamp(run.createdAt)} meta={`${run.operation === 'recover-lock' ? timestamp(run.createdAt) + ' · ' : ''}Runner revision ${run.sourceRevision.slice(0, 12)}`} actions={<StatusBadge phase={run.phase} />}>
    <p role="status">{run.message}</p>
    {run.operation !== 'recover-lock' && <p aria-label="Selected test phases">Selected phases: {run.phases.join(', ')}.</p>}
    {run.diagnosticSelection&&<p aria-label="Diagnostic selection">Diagnostic subset: {run.result?.diagnosticSelection?.title??run.diagnosticSelection}
      {run.result?.diagnosticSelection?.caseIds.length?` (${run.result.diagnosticSelection.caseIds.join(', ')})`:''}. Full-phase acceptance is not assessed.</p>}
    {run.operation !== 'recover-lock' && <p aria-label="Test mode">Test mode: {run.testMode === 'non-destructive' ? 'Non-destructive only' : 'Full, including destructive tests'}.</p>}
    {!!run.result?.excludedSteps?.length && <details><summary>Not selected in this mode ({run.result.excludedSteps.length} steps)</summary>
      <p>Destructive and preparation-dependent live steps were not run or counted as passed. Full-phase acceptance was not assessed.</p>
      <ul>{run.result.excludedSteps.map(step => <li key={step}><code>{step}</code></li>)}</ul>
    </details>}
    {preparation&&preparation.outcome!=='Passed'&&<div className="notice notice-error" role={preparation.outcome==='Failed'?'alert':'status'} aria-label="Automatic preparation result">
      <strong>Automatic preparation {preparation.outcome.toLowerCase()}</strong>
      <p>{preparation.message}</p>
      {preparation.action&&<p>Next action: {preparation.action}</p>}
      <p>Dependent live checks could not start. Passed isolated checks are not live acceptance.</p>
    </div>}
    <div className="progress" role="progressbar" aria-label="Regression progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div className="progress-label"><span>{run.progress.currentPhase !== undefined ? `Phase ${run.progress.currentPhase} P0` : run.phase}</span><span>{percent}%</span></div>
      <div className="progress-track"><span style={{width: `${percent}%`}} /></div>
    </div>
    <p className="muted">{run.operation === 'recover-lock' ? 'Cleanup only: verify the old journal, restore owned resources and release its exact lock. No test phases are selected.' : `${run.progress.completedPhases ?? 0} / ${totalPhases} ${totalPhases === 1 ? 'phase' : 'phases'} finished. Progress reflects completed test steps, not an estimated time.`}</p>
    <p className="muted">100% means execution finished, not passed.</p>
    {run.progress.step && <p>Current step: <code>{run.progress.step}</code> · {run.progress.testIndex ?? 0} / {run.progress.testTotal ?? 0} scenarios</p>}
    {!terminal.has(run.phase) && run.progress.currentTest && <p aria-live="polite">{run.progress.currentTest}</p>}
    {counts ? <>
      <h3>All checks</h3>
      <p className="muted">Case / variant / layer evidence · isolated + live</p>
      <OutcomeMetrics counts={counts} blockedCounts={run.result?.blockedCounts} label="All checks" unit="check evidence"/>
    </> : <p className="muted" aria-label="All checks availability">All-check totals are not available{terminal.has(run.phase)?' for this run':' yet'}.
      {executionCounts?' Only preliminary executable scenario counts are available.':' No final totals were reported.'}</p>}
    {executionCounts && <details><summary>Executable scenarios</summary>
      {!counts&&<p className="muted">Preliminary executable scenario counts; these are not all-check totals.</p>}
      <p className="muted">One executable scenario can produce several check results. Runner and cleanup errors without a scenario ID are included in All checks, not added as executed scenarios.</p>
      <OutcomeMetrics counts={executionCounts} blockedCounts={executionBlockedCounts} label="Executable scenario results" unit="executable scenarios"/>
    </details>}
    <p aria-label="Run lifecycle">Tests: {terminal.has(run.phase)?'finished':'in progress'} · Resource cleanup: {run.cleanup?.state??run.result?.cleanup?.state??'unknown (legacy or not verified)'} · Test account: {run.credentialsCleaned?'removed':'not yet removed'}</p>
    {(run.cleanup?.reason||run.cleanup?.stage)&&<p className="muted">Cleanup reason: {run.cleanup.reason??'not recorded'}{run.cleanup.stage?` · ${run.cleanup.stage}`:''}</p>}
    {(run.result?.recoveryRequired||run.cleanup&&run.cleanup.state!=='verified'&&terminal.has(run.phase)) && <div role="alert" className="notice notice-error">Resource cleanup could not be verified. Removing the test account or finishing the tests does not prove a clean baseline. Use Clean up previous test run or start a full run for exact journal recovery; old test results are never reused.</div>}
    {run.result?.evidenceCounts&&<p className="muted" aria-label="Live evidence results">Live evidence: {run.result.evidenceCounts.live.Passed} passed · {run.result.evidenceCounts.live.Failed} failed · {run.result.evidenceCounts.live.Blocked} blocked. Case / variant / layer evidence, separate from isolated checks and scenario counts.</p>}
    {!!run.result?.phases.length && <div className="table-wrap"><table><caption>Phase results · case / variant / layer evidence</caption><thead><tr><th>Phase</th><th>Outcome</th><th>Passed</th><th>Failed</th><th>Blocked</th></tr></thead><tbody>
      {run.result.phases.map(row => <tr key={row.phase}><td>{row.phase}</td><td><StatusBadge phase={row.outcome} /></td><td>{row.counts.Passed}</td><td>{row.counts.Failed}</td><td>{row.counts.Blocked}<div><BlockedBreakdown counts={row.blockedCounts} total={row.counts.Blocked}/></div></td></tr>)}
    </tbody></table></div>}
    {!!counts?.Blocked&&<p className="muted">Blocked evidence (case / variant / layer): {run.result?.blockedCounts ? regressionBlockedSummary(run.result.blockedCounts) : 'Cause breakdown unavailable for this older report.'}</p>}
    {!!run.result?.cases.length && <details><summary>Failures and blocked checks ({run.result.cases.length}{run.result.omittedCases ? ` shown; ${run.result.omittedCases} more in the report` : ''})</summary><div className="list">
      {run.result.cases.map((row, index) => <article className="list-row" key={`${row.id}-${index}`}><div><strong>{row.id} · {row.layer} · {row.variant}</strong>
        {row.description && <p>{row.description}</p>}
        <p>Reason: <code>{row.reason}</code> — {row.message}</p>
        {row.blockedBy?.caseId&&<p>Blocking check: <strong>{row.blockedBy.caseId}</strong>{row.blockedBy.reason ? ` · ${row.blockedBy.reason}` : ''}{row.blockedBy.stage ? ` · Stage: ${row.blockedBy.stage}` : ''}</p>}
        <p className="muted">{row.phase !== undefined ? `Phase ${row.phase} · ` : ''}Check layer {row.layer}{row.stage ? ` · Stage: ${row.stage}` : ''}</p>
        <p className="muted">Next action: {row.action}</p>
        {row.tracePath && <details><summary>Trace in report archive</summary><code className="break-anywhere">{row.tracePath}</code></details>}
        {row.blockedBy?.traceRunId&&row.blockedBy.executionId&&<details><summary>Blocking scenario trace</summary><code className="break-anywhere">report-artifacts/{row.blockedBy.traceRunId}/traces/{row.blockedBy.executionId}.json</code></details>}
      </div><CaseBadge row={row}/></article>)}
    </div></details>}
    <div className="form-actions">
      <Button disabled={!run.reportAvailable || downloading} onClick={() => void download('archive')}>Download report</Button>
      <Button variant="ghost" disabled={!run.reportAvailable || downloading} onClick={() => void download('html')}>HTML summary</Button>
      <Button variant="ghost" disabled={!run.reportAvailable || downloading} onClick={() => void download('junit')}>JUnit XML</Button>
    </div>
    <p className="muted">The report archive contains summaries, JUnit, test steps and filtered traces. Credentials, kubeconfigs, raw logs and recovery journals stay private.</p>
    <ErrorNotice error={downloadError} />
  </Panel>;
};

export const RegressionPage = () => {
  const client = useQueryClient(), [confirm, setConfirm] = useState<'register' | 'start' | 'cancel' | 'recover' | null>(null);
  const [reviewedLock, setReviewedLock] = useState<string>();
  const [selectedPhases, setSelectedPhases] = useState<RegressionPhase[]>(allPhases);
  const [testMode, setTestMode] = useState<RegressionTestMode>('non-destructive');
  const [diagnostic, setDiagnostic] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [enableRequested, setEnableRequested] = useState(false);
  const query = useQuery({queryKey: ['regression'], queryFn: () => api.regression(), refetchInterval: 2000});
  const refresh = async () => {
    setRefreshing(true);
    try {await query.refetch({cancelRefetch: false});} finally {setRefreshing(false);}
  };
  const data = query.data, active = data?.runs.find(run => !terminal.has(run.phase));
  const cleanupPending = data?.runs.some(run => terminal.has(run.phase) && (!run.credentialsCleaned||run.cleanup&&run.cleanup.state!=='verified'));
  const resourcesPending=data?.runs.some(run=>terminal.has(run.phase)&&run.cleanup&&run.cleanup.state!=='verified');
  const cleanup = data?.cleanup ?? {available: Boolean(data?.lock?.canRecover), revision: data?.lock?.revision,
    message: data?.lock && data.lock.state !== 'free' ? data.lock.message : cleanupPending ?
      'Previous run cleanup is pending; refresh to check its recovery status.' : 'No previous test run needs cleanup. New tests will verify the starting state.'};
  const mutation = useMutation({mutationFn: async (action: 'enable' | 'register' | 'start' | 'cancel' | 'recover') => {
    if (action === 'enable') return api.enableModule('regression');
    if (action === 'register') return api.registerRegression();
    if (action === 'start') {
      if (!selectedPhases.length) throw new Error('Select at least one test phase.');
      if (testMode === 'non-destructive' && (cleanupPending || (data?.lock && data.lock.state !== 'free'))) throw new Error('Clean up the previous run separately before non-destructive tests.');
      const profile=data?.diagnosticSelections?.find(p=>p.id===diagnostic);
      if(diagnostic&&!profile)throw new Error('This diagnostic selection is no longer available. Refresh before starting.');
      return diagnostic?api.startRegression(crypto.randomUUID().replaceAll('-', ''),[profile!.phase],'full',diagnostic):
        api.startRegression(crypto.randomUUID().replaceAll('-', ''), selectedPhases, testMode);
    }
    if (action === 'recover') {
      if (!reviewedLock || cleanup.revision !== reviewedLock || !cleanup.available) throw new Error('The lock changed after review. Refresh and review it again.');
      return api.recoverRegressionLock(crypto.randomUUID().replaceAll('-', ''), reviewedLock);
    }
    if (!active) throw new Error('No active run to cancel.');
    return api.cancelRegression(active.id);
  }, retry: false, onSuccess: async (_result, action) => {
    setEnableRequested(action === 'enable');
    if (action === 'start') {setTestMode('non-destructive');setDiagnostic('');}
    setConfirm(null); await client.invalidateQueries({queryKey: ['regression']});
  }});
  const disabled = query.isPending || Boolean(query.error) || mutation.isPending;
  const enabling = !data?.runtimeAvailable && (enableRequested || (mutation.isPending && mutation.variables === 'enable'));
  const activationMessage = enableRequested ? 'Activation requested. Waiting for the regression runner to become ready…' : 'Sending runner activation request…';
  const nonDestructiveBlocked = testMode === 'non-destructive' && (cleanupPending || Boolean(data?.lock && data.lock.state !== 'free'));
  const open = (value: 'register' | 'start' | 'cancel' | 'recover') => {
    mutation.reset(); setReviewedLock(value === 'recover' ? cleanup.revision : undefined); setConfirm(value);
  };
  return <div className="stack">
    <div className="section-title"><div><h2>Regression tests</h2><p>Run all or selected Phase 0–8 P0 tests inside this Magic Stick's Kubernetes cluster.</p></div><Button variant="ghost" onClick={() => void refresh()} disabled={query.isPending || refreshing}>Refresh tests</Button></div>
    <ErrorNotice error={query.error ?? mutation.error} />{query.isPending && <Loading />}
    {data && <Panel title="Run the suite">
      <p>No license is required to run regression tests or download reports. Sign in as an administrator and register this disposable test server once; this is not license registration.</p>
      <p>For dedicated test servers only. Choose non-destructive checks, or full tests that may stop models, alter settings, deploy models and services, replace test licenses and clear model caches.</p>
      <p className="muted">Host restart, power-loss, network-disconnection and software-replacement drills require the external Docker runner and are reported as Blocked here. Missing GPUs, Mesh peers or test identity providers block only their dependent cases.</p>
      {!data.runtimeAvailable && <>
        {enabling ? <>
          <p id="regression-activation-status" role="status">{activationMessage}</p>
          <div className="progress progress-warn progress-indeterminate" role="progressbar" aria-label="Regression runner activation" aria-valuetext={activationMessage}>
            <div className="progress-track"><span style={{width: '35%'}} /></div>
          </div>
          <p className="muted">Downloading images and starting the runner services can take several minutes. Status updates automatically; no tests have been started. If readiness stalls, check Services and System Status → Flux.</p>
        </> : <p role="status">{data.message}</p>}
        <Button disabled={disabled || enabling} aria-busy={enabling} aria-describedby={enabling ? 'regression-activation-status' : undefined}
          onClick={() => mutation.mutate('enable')}>{enabling ? enableRequested ? 'Waiting for runner readiness…' : 'Enabling regression runner…' : 'Enable regression runner'}</Button>
      </>}
      {data.runtimeAvailable && enableRequested && <p role="status">Regression runner is ready.{!data.registered && ' Register this disposable test Appliance to continue.'}</p>}
      {data.runtimeAvailable && !data.registered && <Button variant="danger" disabled={disabled} onClick={() => open('register')}>Register test Appliance</Button>}
      <div className="form-actions"><Button variant="primary" disabled={disabled || !data.registered || !data.runtimeAvailable || Boolean(active) || (cleanupPending && !data.recoveryAvailable) || (Boolean(data.lock) && data.lock?.state !== 'free' && !data.lock?.canRecover)} onClick={() => open('start')}>Start regression tests</Button>
        {active && <Button variant="danger" disabled={disabled || active.phase === 'Cancelling'} onClick={() => open('cancel')}>Cancel tests</Button>}
        <Button variant="danger" aria-describedby="regression-cleanup-status" disabled={disabled || !data.registered || !data.runtimeAvailable || Boolean(active) || !cleanup.available} onClick={() => open('recover')}>Clean up previous test run</Button>
      </div>
      <p id="regression-cleanup-status" role="status">{!data.registered ? 'Register this disposable test Appliance before cleanup.' : !data.runtimeAvailable ?
        'Enable the regression runner and wait for readiness before cleanup.' : active ? 'A test or cleanup run is active. Wait for it to finish.' : cleanup.message}</p>
      {data.lock && data.lock.state !== 'free' && data.lock.message !== cleanup.message && <p role="status">{data.lock.message}</p>}
      {cleanupPending && <p role="status">{data.recoveryAvailable ? 'Full tests can automatically clean up the previous run first. For non-destructive tests, clean up separately before starting. Cleanup must succeed before a fresh test ID and new tests are started.' : resourcesPending ? 'Previous-run resource cleanup is not verified. The exact recovery journal must be checked before new live tests can start.' : "Removing the completed run's generated test account before another run can start."}</p>}
      <p className="muted">No recurring setup or manually prepared test files. Reloading or leaving this page does not stop the job.</p>
    </Panel>}
    {data?.runs.map(run => <Result key={run.uid} run={run} />)}
    {data && !data.runs.length && <Empty>No regression runs yet.</Empty>}
    <ConfirmDialog open={Boolean(confirm)} title={confirm === 'register' ? 'Register disposable test Appliance' : confirm === 'cancel' ? 'Cancel regression tests' : confirm === 'recover' ? 'Clean up previous test run' : 'Start regression tests'}
      expectedValue={confirm === 'register' ? 'DISPOSABLE TEST SERVER' : undefined}
      description={confirm === 'register' ? 'This permanently binds the test policy to this Appliance and its Node identities. Do not register a production server.' : confirm === 'cancel' ? 'Stop further tests and allow bounded cleanup. Interrupted operations retain their recovery journal; cancellation does not mean restoration succeeded.' : confirm === 'recover' ? 'Restore retained setup access and verify the old run’s exact resources and unchanged borrowed settings, even if its lock is already free. Active owners and missing or changed journals are not bypassed. No new regression tests will start; historical results remain unchanged.' : testMode === 'non-destructive' ? 'Read existing appliance state and run isolated tests without stopping models or changing services, settings, licenses or caches. Creates a temporary viewer account, a Kubernetes runner Job and reports. Previous-run cleanup is not performed automatically. Excluded steps are named in the report; this is not full-phase acceptance.' : 'Run the selected P0 phases from the beginning after automatic cleanup and baseline checks. Existing models may be stopped; settings, services, licenses and caches may be changed on this dedicated test Appliance. Failures and unavailable prerequisites remain visible.'}
      confirmLabel={confirm === 'register' ? 'Register test Appliance' : confirm === 'cancel' ? 'Cancel tests' : confirm === 'recover' ? 'Clean up previous run' : 'Start tests'}
      busy={mutation.isPending} error={mutation.error} onClose={() => {if (!mutation.isPending) setConfirm(null);}}
      confirmDisabled={confirm === 'start' && (selectedPhases.length === 0 || Boolean(nonDestructiveBlocked))}
      onConfirm={() => {if (confirm) mutation.mutate(confirm);}}>
      {confirm === 'start' && <>
        <fieldset className="regression-phase-selection stack compact" disabled={mutation.isPending}>
          <legend>Test mode</legend>
          <label className="check-field"><input type="radio" name="regression-test-mode" value="non-destructive" checked={testMode === 'non-destructive'} onChange={() => {setTestMode('non-destructive');setDiagnostic('');}} />Non-destructive only</label>
          <label className="check-field"><input type="radio" name="regression-test-mode" value="full" checked={testMode === 'full'} onChange={() => setTestMode('full')} />Include destructive tests</label>
        </fieldset>
        {!!data?.diagnosticSelections?.length&&<Field label="Test selection">
          <select aria-label="Test selection" value={diagnostic} disabled={mutation.isPending} onChange={event=>{
            setDiagnostic(event.target.value);
            const profile=data.diagnosticSelections?.find(p=>p.id===event.target.value);
            if(profile){setTestMode('full');setSelectedPhases([profile.phase]);}
          }}><option value="">All tests in selected phases</option>
            {data.diagnosticSelections.map(profile=><option key={profile.id} value={profile.id}>{profile.title} (Phase {profile.phase} · {profile.caseIds.join(', ')})</option>)}
          </select>
        </Field>}
        {diagnostic&&<p role="status">Only this Phase {selectedPhases[0]} diagnostic subset will run. Preparation and cleanup remain required; this is not full-phase acceptance.</p>}
        {nonDestructiveBlocked && <p role="alert">Clean up the previous run separately before non-destructive tests. This mode never restores old test resources or clears their lock.</p>}
        <fieldset className="regression-phase-selection stack compact" disabled={mutation.isPending||Boolean(diagnostic)} aria-describedby="regression-phase-hint">
          <legend>Test phases</legend>
          <div className="actions">
            <Button type="button" variant="ghost" disabled={mutation.isPending} onClick={() => setSelectedPhases(allPhases)}>Select all</Button>
            <Button type="button" variant="ghost" disabled={mutation.isPending} onClick={() => setSelectedPhases([])}>Clear selection</Button>
          </div>
          <div className="form-grid">{phaseOptions.map(option => <label className="check-field" key={option.phase}>
            <input type="checkbox" checked={selectedPhases.includes(option.phase)} onChange={event => {
              const checked = event.target.checked;
              setSelectedPhases(previous => checked ? [...previous, option.phase].sort((a, b) => a - b) : previous.filter(phase => phase !== option.phase));
            }} />
            Phase {option.phase} · {option.name}
          </label>)}</div>
          <p id="regression-phase-hint" className="muted">{testMode === 'full' ? 'Preparation and cleanup run automatically for your selection.' : 'Only isolated tests and read-only inventory checks run. Existing workloads remain active.'} Other test phases are not executed or counted as passed.</p>
        </fieldset>
        {selectedPhases.length ? <p role="status">Selected phases: {selectedPhases.join(', ')}.</p> : <p role="alert">Select at least one test phase.</p>}
      </>}
    </ConfirmDialog>
  </div>;
};
