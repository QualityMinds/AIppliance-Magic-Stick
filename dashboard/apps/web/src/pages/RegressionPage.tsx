import {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {RegressionRun} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, Empty, ErrorNotice, Loading, Panel, StatusBadge} from '../components';

const terminal = new Set(['Passed', 'Failed', 'Blocked', 'Cancelled']);
const timestamp = (value?: string) => value ? new Date(value).toLocaleString() : '—';
const Result = ({run}: {run: RegressionRun}) => {
  const [downloadError, setDownloadError] = useState<unknown>();
  const [downloading, setDownloading] = useState(false);
  const percent = Math.max(0, Math.min(100, run.progress.percent ?? 0));
  const counts = run.result?.executionCounts ?? run.progress.executionCounts;
  const download = async (kind: 'archive' | 'html' | 'junit') => {
    setDownloading(true); setDownloadError(undefined);
    try {
      const blob = await api.downloadRegression(run.id, kind), url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `magicstick-${run.id}.${kind === 'archive' ? 'tar.gz' : kind === 'html' ? 'html' : 'xml'}`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {setDownloadError(error);} finally {setDownloading(false);}
  };
  return <Panel title={timestamp(run.createdAt)} meta={`Runner revision ${run.sourceRevision.slice(0, 12)}`} actions={<StatusBadge phase={run.phase} />}>
    <p role="status">{run.message}</p>
    <div className="progress" role="progressbar" aria-label="Regression progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div className="progress-label"><span>{run.progress.currentPhase !== undefined ? `Phase ${run.progress.currentPhase} P0` : run.phase}</span><span>{percent}%</span></div>
      <div className="progress-track"><span style={{width: `${percent}%`}} /></div>
    </div>
    <p className="muted">{run.progress.completedPhases ?? 0} / {run.progress.totalPhases ?? 9} phases finished. Progress reflects completed test steps, not an estimated time.</p>
    {run.progress.step && <p>Current step: <code>{run.progress.step}</code> · {run.progress.testIndex ?? 0} / {run.progress.testTotal ?? 0} scenarios</p>}
    {!terminal.has(run.phase) && run.progress.currentTest && <p aria-live="polite">{run.progress.currentTest}</p>}
    {counts && <div className="metric-grid" aria-label="Executable scenario results">
      {(['Passed', 'Failed', 'Blocked'] as const).map(outcome => <article className="metric" key={outcome}><span>{outcome}</span><strong>{counts[outcome]}</strong><small>executable scenarios</small></article>)}
    </div>}
    {run.result?.recoveryRequired && <div role="alert" className="notice notice-error">Cleanup could not be verified. The next run must recover the retained journal before further live changes.</div>}
    {!!run.result?.phases.length && <div className="table-wrap"><table><caption>Phase results · case / variant / layer evidence</caption><thead><tr><th>Phase</th><th>Outcome</th><th>Passed</th><th>Failed</th><th>Blocked</th></tr></thead><tbody>
      {run.result.phases.map(row => <tr key={row.phase}><td>{row.phase}</td><td><StatusBadge phase={row.outcome} /></td><td>{row.counts.Passed}</td><td>{row.counts.Failed}</td><td>{row.counts.Blocked}</td></tr>)}
    </tbody></table></div>}
    {!!run.result?.cases.length && <details><summary>Failures and blocked checks ({run.result.cases.length}{run.result.omittedCases ? ` shown; ${run.result.omittedCases} more in the report` : ''})</summary><div className="list">
      {run.result.cases.map((row, index) => <article className="list-row" key={`${row.id}-${index}`}><div><strong>{row.id} · {row.layer} · {row.variant}</strong>
        {row.description && <p>{row.description}</p>}
        <p>Reason: <code>{row.reason}</code> — {row.message}</p>
        <p className="muted">{row.phase !== undefined ? `Phase ${row.phase} · ` : ''}Check layer {row.layer}{row.stage ? ` · Stage: ${row.stage}` : ''}</p>
        <p className="muted">Next action: {row.action}</p>
        {row.tracePath && <details><summary>Trace in report archive</summary><code className="break-anywhere">{row.tracePath}</code></details>}
      </div><StatusBadge phase={row.outcome} /></article>)}
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
  const client = useQueryClient(), [confirm, setConfirm] = useState<'register' | 'start' | 'cancel' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const query = useQuery({queryKey: ['regression'], queryFn: () => api.regression(), refetchInterval: 2000});
  const refresh = async () => {
    setRefreshing(true);
    try {await query.refetch({cancelRefetch: false});} finally {setRefreshing(false);}
  };
  const data = query.data, active = data?.runs.find(run => !terminal.has(run.phase));
  const cleanupPending = data?.runs.some(run => terminal.has(run.phase) && !run.credentialsCleaned);
  const mutation = useMutation({mutationFn: async (action: 'enable' | 'register' | 'start' | 'cancel') => {
    if (action === 'enable') return api.enableModule('regression');
    if (action === 'register') return api.registerRegression();
    if (action === 'start') return api.startRegression(crypto.randomUUID().replaceAll('-', ''));
    if (!active) throw new Error('No active run to cancel.');
    return api.cancelRegression(active.id);
  }, retry: false, onSuccess: async () => {setConfirm(null); await client.invalidateQueries({queryKey: ['regression']});}});
  const disabled = query.isPending || Boolean(query.error) || mutation.isPending;
  const open = (value: 'register' | 'start' | 'cancel') => {mutation.reset(); setConfirm(value);};
  return <div className="stack">
    <div className="section-title"><div><h2>Regression tests</h2><p>Run all Phase 0–8 P0 tests inside this Magic Stick's Kubernetes cluster.</p></div><Button variant="ghost" onClick={() => void refresh()} disabled={query.isPending || refreshing}>Refresh tests</Button></div>
    <ErrorNotice error={query.error ?? mutation.error} />{query.isPending && <Loading />}
    {data && <Panel title="Run the suite">
      <p>No license is required to run regression tests or download reports. Sign in as an administrator and register this disposable test server once; this is not license registration.</p>
      <p>For dedicated disposable test servers only. Tests may stop models, alter settings, deploy small models and services, replace test licenses and clear model caches.</p>
      <p className="muted">Host restart, power-loss, network-disconnection and software-replacement drills require the external Docker runner and are reported as Blocked here. Missing GPUs, Mesh peers or test identity providers block only their dependent cases.</p>
      {!data.runtimeAvailable && <><p role="status">{data.message}</p><Button disabled={disabled} onClick={() => mutation.mutate('enable')}>Enable regression runner</Button></>}
      {data.runtimeAvailable && !data.registered && <Button variant="danger" disabled={disabled} onClick={() => open('register')}>Register test Appliance</Button>}
      <div className="form-actions"><Button variant="primary" disabled={disabled || !data.registered || !data.runtimeAvailable || Boolean(active) || (cleanupPending && !data.recoveryAvailable)} onClick={() => open('start')}>Start regression tests</Button>
        {active && <Button variant="danger" disabled={disabled || active.phase === 'Cancelling'} onClick={() => open('cancel')}>Cancel tests</Button>}
      </div>
      {cleanupPending && <p role="status">{data.recoveryAvailable ? 'Start the next run to recover the interrupted setup with its retained test identity. Recovery must succeed before further live changes.' : "Removing the completed run's generated test account before another run can start."}</p>}
      <p className="muted">No recurring setup or manually prepared test files. Reloading or leaving this page does not stop the job.</p>
    </Panel>}
    {data?.runs.map(run => <Result key={run.uid} run={run} />)}
    {data && !data.runs.length && <Empty>No regression runs yet.</Empty>}
    <ConfirmDialog open={Boolean(confirm)} title={confirm === 'register' ? 'Register disposable test Appliance' : confirm === 'cancel' ? 'Cancel regression tests' : 'Start regression tests'}
      expectedValue={confirm === 'register' ? 'DISPOSABLE TEST SERVER' : undefined}
      description={confirm === 'register' ? 'This permanently binds the destructive test policy to this Appliance and its Node identities. Do not register a production server.' : confirm === 'cancel' ? 'Stop further tests and allow bounded cleanup. Interrupted operations retain their recovery journal; cancellation does not mean restoration succeeded.' : 'Run every implemented P0 phase. Existing models may be stopped; settings, services, licenses and caches may be changed on this dedicated test Appliance. Failures and unavailable prerequisites remain visible.'}
      confirmLabel={confirm === 'register' ? 'Register test Appliance' : confirm === 'cancel' ? 'Cancel tests' : 'Start tests'}
      busy={mutation.isPending} error={mutation.error} onClose={() => {if (!mutation.isPending) setConfirm(null);}}
      onConfirm={() => {if (confirm) mutation.mutate(confirm);}} />
  </div>;
};
