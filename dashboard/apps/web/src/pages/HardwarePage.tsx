import {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {canAdminister, gpuCompatibilityParameters} from '@magicstick/dashboard-core';
import type {GpuCompatibility, GpuCompatibilityNode, Session} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, Empty, ErrorNotice, Field, Loading, Panel, StatusBadge} from '../components';
import {HostPreparationPanel} from './HostManagement';
import {SharedMemoryOverview} from '../SharedMemoryOverview';

const stage = (ready?: boolean | null) => ready === true ? 'Ready' : ready === false ? 'Not ready' : 'Not verified';

const HardwareNode = ({node}: {node: GpuCompatibilityNode}) => <article className="operator-card">
  <header><strong>{node.node}</strong><StatusBadge phase={node.eligible ? 'Eligible' : 'Not eligible'} /></header>
  <dl className="facts">
    <div><dt>Profile</dt><dd>{node.profileId || 'Upstream rules'}{node.profileVersion ? ` · ${node.profileVersion}` : ''}</dd></div>
    <div><dt>Upstream operator recognition</dt><dd>{node.upstreamSupported ? 'Recognized' : 'Not recognized'}</dd></div>
    <div><dt>Architecture</dt><dd>{node.detectedArchitecture || 'Not verified'}{node.expectedArchitecture ? ` (expected ${node.expectedArchitecture})` : ''}</dd></div>
    <div><dt>Host driver</dt><dd>{stage(node.hostDriverReady)}</dd></div>
    <div><dt>Kubernetes GPU resource</dt><dd>{stage(node.resourceRegistered)}</dd></div>
    {Boolean(node.pciDevices?.length) && <div><dt>PCI devices</dt><dd>{node.pciDevices?.join(', ')}</dd></div>}
  </dl>
  {node.message && <p className="muted">{node.message}</p>}
  {node.memoryArchitecture === 'unified' && <SharedMemoryOverview pool={node} />}
  <h4>Engine validation · Optional</h4>
  <p className="muted">Manual diagnostic only. Untested, running, failed or stale tests do not disable a ready GPU.</p>
  <div className="list">{['OLlama', 'VLLM'].map((engine) => {
    const validation = node.validation?.[engine];
    const state = validation?.state ?? 'unverified';
    return <div className="list-row" key={engine}><div><strong>{engine === 'OLlama' ? 'Ollama' : 'vLLM'}</strong><p>{validation?.message || (state === 'upstream' ? 'Upstream support path; no local validation recorded.' : 'No local GPU test recorded. Validation is optional.')}</p>{validation && <p className="muted">{validation.runtimeMessage || (validation.runtimeReady ? 'The configured runtime image is ready.' : 'Runtime image readiness has not been confirmed yet.')}</p>}{validation?.image && <small className="muted">Image: {validation.image}</small>}{validation?.validatedAt && <p className="muted">Validated: {validation.validatedAt}</p>}</div><div className="stack compact">{state === 'passed' ? <span className="status status-good">GPU smoke passed</span> : <StatusBadge phase={state} />}{validation && <span className={`status status-${validation.runtimeReady ? 'good' : 'warn'}`}>{validation.runtimeReady ? 'Runtime Ready' : 'Runtime pending'}</span>}</div></div>;
  })}</div>
</article>;

const ProfileControls = ({compatibility}: {compatibility: GpuCompatibility}) => {
  const client = useQueryClient();
  const [profileId, setProfileId] = useState(compatibility.selectedProfile ?? '');
  const [acknowledged, setAcknowledged] = useState(compatibility.allowExperimental === true);
  const [confirmValidation, setConfirmValidation] = useState(false);
  const selected = compatibility.profiles.find((profile) => profile.id === profileId);
  const changed = profileId !== (compatibility.selectedProfile ?? '') || acknowledged !== (compatibility.allowExperimental === true);
  const mutation = useMutation({
    mutationFn: async (validate: boolean) => {
      const parameters = gpuCompatibilityParameters(profileId, compatibility.profiles, acknowledged);
      if (validate) parameters.validationRequest = `dashboard-${Date.now()}-${crypto.randomUUID()}`;
      return api.enableModule('amd-gpu', parameters);
    },
    onSuccess: async () => {
      setConfirmValidation(false);
      await Promise.all([client.invalidateQueries({queryKey: ['status']}), client.invalidateQueries({queryKey: ['modules']}), client.invalidateQueries({queryKey: ['models']})]);
    },
  });
  return <div className="stack">
    <Field label="AMD compatibility profile"><select value={profileId} disabled={mutation.isPending} onChange={(event) => {setProfileId(event.target.value); setAcknowledged(false);}}>
      <option value="">Upstream operator rules only</option>
      {compatibility.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName} · {profile.version}{profile.experimental ? ' · Experimental' : ''}</option>)}
    </select></Field>
    {selected && <p className="muted">{selected.description} Profile selection applies only to matching hardware; it does not certify other cards.</p>}
    {selected?.experimental && <div className="notice notice-warn"><strong>Experimental GPU support</strong><p>This opts matching nodes into an additional compatibility profile. A ready host driver and registered Kubernetes GPU enable model use. Engine validation is optional; availability is not proof that every model works.</p><label className="check-field"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> I accept the experimental hardware profile and its limitations.</label></div>}
    <div className="form-actions"><Button disabled={mutation.isPending || Boolean(selected?.experimental && !acknowledged) || !changed} onClick={() => mutation.mutate(false)}>Save hardware profile</Button><Button variant="ghost" disabled={mutation.isPending || changed || !profileId || Boolean(selected?.experimental && !acknowledged)} onClick={() => setConfirmValidation(true)}>Run GPU validation</Button></div>
    <p className="muted">Saving enables the profile without starting engine tests. Switching back to upstream rules removes the custom profile; existing models may lose GPU eligibility. Optional validation uses GPU resources and may need to wait for active models.</p>
    <ErrorNotice error={mutation.error} />
    <ConfirmDialog open={confirmValidation} title="Run GPU validation" description="Optionally run the profile's bounded GPU tests on matching nodes. Test images may be downloaded and GPU resources used; tests may wait for active models. Results do not block GPU use and are not a full model quality benchmark." confirmLabel="Run tests" busy={mutation.isPending} error={mutation.error} onClose={() => setConfirmValidation(false)} onConfirm={() => mutation.mutate(true)} />
  </div>;
};

export const HardwarePage = ({session}: {session: Session}) => {
  const query = useQuery({queryKey: ['status'], queryFn: () => api.status(), refetchInterval: 15_000});
  if (query.error) return <ErrorNotice error={query.error} />;
  if (query.isPending || !query.data) return <Loading />;
  const operators = Object.entries(query.data.hardwareOperators ?? {});
  const compatibility = query.data.hardwareOperators?.['amd-gpu']?.compatibility;
  return <div className="stack">
    <div className="section-title"><div><h2>Hardware</h2><p>GPUs are available when hardware and driver checks pass and Kubernetes registers the resource. Engine validation is optional.</p></div><Button variant="ghost" onClick={() => query.refetch()}>Refresh hardware</Button></div>
    <HostPreparationPanel session={session} />
    <Panel title="GPU operators"><div className="list">{operators.map(([id, operator]) => <article className="list-row" key={id}><div><strong>{operator.displayName ?? id}</strong><p>{operator.message}</p><small className="muted">{operator.detectedNodes?.length ?? 0} detected node(s) · {operator.allocatableResources ?? 0} allocatable GPU resource(s) · {operator.operatorVersion ?? 'version unknown'}</small></div><StatusBadge phase={operator.phase} /></article>)}</div>{!operators.length && <Empty>No hardware operator status reported.</Empty>}</Panel>
    {compatibility ? <>
      <Panel title="AMD compatibility profiles">{canAdminister(session) ? <ProfileControls key={`${compatibility.selectedProfile}:${compatibility.allowExperimental}`} compatibility={compatibility} /> : <p className="muted">Current profile: {compatibility.selectedProfile || 'upstream rules'}. Administrator access is required to change profiles or run validation.</p>}</Panel>
      <Panel title="GPU nodes">{compatibility.nodes.length ? <div className="stack">{compatibility.nodes.map((node) => <HardwareNode key={node.nodeUid ?? node.node} node={node} />)}</div> : <Empty>No AMD GPU nodes detected. Unknown hardware is not automatically enabled.</Empty>}</Panel>
    </> : <Empty>The server has not reported a GPU compatibility catalog yet. Refresh after the hardware controller update.</Empty>}
  </div>;
};
