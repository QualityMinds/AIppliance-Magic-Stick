import {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {canAdminister, gpuCompatibilityParameters} from '@magicstick/dashboard-core';
import type {GpuCompatibility, GpuCompatibilityNode, Session} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, Empty, ErrorNotice, Field, Loading, Panel, StatusBadge} from '../components';
import {HostMemoryPanel, HostPreparationPanel} from './HostManagement';
import {SharedMemoryOverview} from '../SharedMemoryOverview';
import {InfoPopover} from '../InfoPopover';

const stage = (ready?: boolean | null) => ready === true ? 'Ready' : ready === false ? 'Not ready' : 'Not verified';

const HardwareNode = ({node}: {node: GpuCompatibilityNode}) => <article className="operator-card">
  <header><div className="inline-info"><strong>{node.node}</strong>{node.message && <InfoPopover label={`GPU on ${node.node}`}><p className="memory-info-note">{node.message}</p></InfoPopover>}</div><StatusBadge phase={node.eligible ? 'Eligible' : 'Not eligible'} /></header>
  <dl className="facts">
    <div><dt>Profile</dt><dd>{node.profileId || 'Upstream rules'}{node.profileVersion ? ` · ${node.profileVersion}` : ''}</dd></div>
    <div><dt>Upstream operator recognition</dt><dd>{node.upstreamSupported ? 'Recognized' : 'Not recognized'}</dd></div>
    <div><dt>Architecture</dt><dd>{node.detectedArchitecture || 'Not verified'}{node.expectedArchitecture ? ` (expected ${node.expectedArchitecture})` : ''}</dd></div>
    <div><dt>Host driver</dt><dd>{stage(node.hostDriverReady)}</dd></div>
    <div><dt>Kubernetes GPU resource</dt><dd>{stage(node.resourceRegistered)}</dd></div>
    {Boolean(node.pciDevices?.length) && <div><dt>PCI devices</dt><dd>{node.pciDevices?.join(', ')}</dd></div>}
  </dl>
  {node.memoryArchitecture === 'unified' && <SharedMemoryOverview pool={node} />}
  <div className="inline-info"><h4>Engine validation · Optional</h4><InfoPopover label={`Engine validation on ${node.node}`}><p className="memory-info-note">Manual diagnostic only. Untested, running, failed or stale tests do not disable a ready GPU. A successful smoke test does not confirm model size, quality or memory accounting.</p></InfoPopover></div>
  <div className="list">{['OLlama', 'VLLM'].map((engine) => {
    const validation = node.validation?.[engine];
    const state = validation?.state ?? 'unverified';
    const name = engine === 'OLlama' ? 'Ollama' : 'vLLM';
    return <div className="list-row" key={engine}><div className="inline-info"><strong>{name}</strong><InfoPopover label={`${name} validation on ${node.node}`}><p className="memory-info-note">{validation?.message || (state === 'upstream' ? 'Upstream support path; no local validation recorded.' : 'No local GPU test recorded. Validation is optional.')}</p>{validation && <p className="memory-info-note">{validation.runtimeMessage || (validation.runtimeReady ? 'The configured runtime image is ready.' : 'Runtime image readiness has not been confirmed yet.')}</p>}{validation?.image && <p className="memory-info-note">Image: {validation.image}</p>}{validation?.validatedAt && <p className="memory-info-note">Validated: {validation.validatedAt}</p>}</InfoPopover></div><div className="stack compact">{state === 'passed' ? <span className="status status-good">GPU smoke passed</span> : <StatusBadge phase={state} />}{validation && <span className={`status status-${validation.runtimeReady ? 'good' : 'warn'}`}>{validation.runtimeReady ? 'Runtime Ready' : 'Runtime pending'}</span>}</div></div>;
  })}</div>
</article>;

const ProfileControls = ({compatibility}: {compatibility: GpuCompatibility}) => {
  const client = useQueryClient();
  const [profileId, setProfileId] = useState(compatibility.selectedProfile ?? '');
  const [acknowledged, setAcknowledged] = useState(compatibility.allowExperimental === true);
  const selected = compatibility.profiles.find((profile) => profile.id === profileId);
  const changed = profileId !== (compatibility.selectedProfile ?? '') || acknowledged !== (compatibility.allowExperimental === true);
  const mutation = useMutation({
    mutationFn: async () => {
      const parameters = gpuCompatibilityParameters(profileId, compatibility.profiles, acknowledged);
      return api.enableModule('amd-gpu', parameters);
    },
    onSuccess: async () => {
      await Promise.all([client.invalidateQueries({queryKey: ['status']}), client.invalidateQueries({queryKey: ['modules']}), client.invalidateQueries({queryKey: ['models']})]);
    },
  });
  return <div className="stack">
    <div className="inline-info"><strong>AMD runtime profile</strong><InfoPopover label="AMD runtime profile"><p className="memory-info-note">Host preparation already activates the matching profile. This manual override changes the cluster's AMD ModuleActivation only; it installs no kernel or driver and does not start engine tests.</p><p className="memory-info-note">Switching back to upstream rules removes the custom profile; existing models may lose GPU eligibility.</p>{selected && <p className="memory-info-note">{selected.description} Profile selection applies only to matching hardware; it does not certify other cards.</p>}</InfoPopover></div>
    <Field label="AMD compatibility profile"><select value={profileId} disabled={mutation.isPending} onChange={(event) => {setProfileId(event.target.value); setAcknowledged(false);}}>
      <option value="">Upstream operator rules only</option>
      {compatibility.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName} · {profile.version}{profile.experimental ? ' · Experimental' : ''}</option>)}
    </select></Field>
    {selected?.experimental && <label className="check-field"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> I accept the experimental hardware profile and its limitations.</label>}
    <div className="form-actions"><Button disabled={mutation.isPending || Boolean(selected?.experimental && !acknowledged) || !changed} onClick={() => mutation.mutate()}>Save hardware profile</Button></div>
    <ErrorNotice error={mutation.error} />
  </div>;
};

const GpuValidationButton = ({compatibility}: {compatibility: GpuCompatibility}) => {
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const selected = compatibility.profiles.find((profile) => profile.id === compatibility.selectedProfile);
  const mutation = useMutation({
    mutationFn: () => api.enableModule('amd-gpu', {
      ...gpuCompatibilityParameters(compatibility.selectedProfile ?? '', compatibility.profiles, compatibility.allowExperimental === true),
      validationRequest: `dashboard-${Date.now()}-${crypto.randomUUID()}`,
    }),
    onSuccess: async () => {
      setConfirm(false);
      await Promise.all([client.invalidateQueries({queryKey: ['status']}), client.invalidateQueries({queryKey: ['modules']}), client.invalidateQueries({queryKey: ['models']})]);
    },
  });
  return <><Button variant="ghost" disabled={mutation.isPending || !selected || Boolean(selected.experimental && !compatibility.allowExperimental)} onClick={() => setConfirm(true)}>Run GPU validation</Button>
    <ConfirmDialog open={confirm} title="Run GPU validation" description={`Optionally test the saved profile ${selected?.displayName ?? compatibility.selectedProfile} on matching nodes. Unsaved profile changes are not applied. Test images may be downloaded and GPU resources used; tests may wait for active models. Results do not block GPU use and are not a full model quality benchmark.`} confirmLabel="Run tests" busy={mutation.isPending} error={mutation.error} onClose={() => setConfirm(false)} onConfirm={() => mutation.mutate()} />
  </>;
};

export const HardwarePage = ({session}: {session: Session}) => {
  const query = useQuery({queryKey: ['status'], queryFn: () => api.status(), refetchInterval: 15_000});
  if (query.error) return <ErrorNotice error={query.error} />;
  if (query.isPending || !query.data) return <Loading />;
  const operators = Object.entries(query.data.hardwareOperators ?? {});
  const compatibility = query.data.hardwareOperators?.['amd-gpu']?.compatibility;
  return <div className="stack">
    <div className="section-title"><div className="inline-info"><h2>Hardware</h2><InfoPopover label="Hardware"><p className="memory-info-note">GPUs are available when hardware and driver checks pass and Kubernetes registers the resource. Engine validation is optional.</p></InfoPopover></div><Button variant="ghost" onClick={() => query.refetch()}>Refresh hardware</Button></div>
    <Panel title="GPU operators"><div className="list">{operators.map(([id, operator]) => <article className="list-row" key={id}><div><div className="inline-info"><strong>{operator.displayName ?? id}</strong>{operator.message && <InfoPopover label={operator.displayName ?? id}><p className="memory-info-note">{operator.message}</p></InfoPopover>}</div><small className="muted">{operator.detectedNodes?.length ?? 0} nodes · {operator.allocatableResources ?? 0} GPU resources · {operator.operatorVersion ?? 'Version unknown'}</small></div><StatusBadge phase={operator.phase} /></article>)}</div>{!operators.length && <Empty>No hardware operator status reported.</Empty>}</Panel>
    <HostPreparationPanel session={session}>
      {compatibility && <details className="hardware-advanced"><summary>Advanced · AMD runtime profile</summary>
        {canAdminister(session) ? <ProfileControls key={`${compatibility.selectedProfile}:${compatibility.allowExperimental}`} compatibility={compatibility} /> : <div className="stack"><div className="inline-info"><span>Current profile: {compatibility.selectedProfile || 'upstream rules'}</span><InfoPopover label="AMD runtime profile"><p className="memory-info-note">Administrator access is required to change profiles or run validation.</p></InfoPopover></div></div>}
      </details>}
    </HostPreparationPanel>
    <HostMemoryPanel session={session} />
    {compatibility ? <Panel title="GPU nodes" actions={canAdminister(session) && <GpuValidationButton key={`${compatibility.selectedProfile}:${compatibility.allowExperimental}`} compatibility={compatibility} />}>{compatibility.nodes.length ? <div className="stack">{compatibility.nodes.map((node) => <HardwareNode key={node.nodeUid ?? node.node} node={node} />)}</div> : <Empty>No AMD GPU nodes detected.</Empty>}</Panel> : <Empty>No GPU compatibility catalog reported.</Empty>}
  </div>;
};
