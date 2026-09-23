import {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {canAdminister, gpuCompatibilityParameters} from '@magicstick/dashboard-core';
import type {GpuCompatibility, GpuCompatibilityNode, HardwareGpuDevice, ManagedHost, Session} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, Empty, ErrorNotice, Field, Loading, Panel, StatusBadge} from '../components';
import {HostMemoryControls, HostPreparation, useHosts} from './HostManagement';
import {SharedMemoryOverview} from '../SharedMemoryOverview';
import {InfoPopover} from '../InfoPopover';
import {GpuSharingControls} from './GpuSharingControls';
import {SharedGpuMemoryInfo} from './HostGpuMemory';

const stage = (ready?: boolean | null) => ready === true ? 'Ready' : ready === false ? 'Not ready' : 'Not verified';

const HardwareNodeFacts = ({node}: {node: GpuCompatibilityNode}) => <>
    <div><dt>Profile</dt><dd>{node.profileId || 'Upstream rules'}{node.profileVersion ? ` · ${node.profileVersion}` : ''}</dd></div>
    <div><dt>Upstream operator recognition</dt><dd>{node.upstreamSupported === true ? 'Recognized' : node.upstreamSupported === false ? 'Not recognized' : 'Not verified'}</dd></div>
</>;

const DeviceFacts = ({device}: {device: HardwareGpuDevice}) => <dl className="facts">
  <div><dt>Architecture</dt><dd>{device.architecture || 'Not verified'}</dd></div>
  <div><dt>Host driver</dt><dd>{stage(device.hostDriverReady)}{device.hostDriver ? ` · ${device.hostDriver}` : ''}</dd></div>
  <div><dt>Kubernetes GPU resource</dt><dd>{stage(device.resourceRegistered)}</dd></div>
  <div><dt>Detected GPU device</dt><dd>{device.pciId || 'Not reported'}{device.pciAddress ? ` · ${device.pciAddress}` : ''}</dd></div>
</dl>;

const DeviceMemory = ({device}: {device: HardwareGpuDevice}) => device.memoryArchitecture === 'unified' && device.memory
  ? <SharedMemoryOverview pool={device.memory} />
  : <section className="operator-card shared-memory-overview stack compact" aria-label={`Physical memory layout for ${device.name}`}>
    <header className="inline-info"><strong>Physical memory layout</strong><InfoPopover label={`Physical memory layout for ${device.name}`}><p className="memory-info-note">Dedicated memory belongs to this physical GPU. It is not added to another GPU's memory or the Strix Halo shared-memory ceiling.</p></InfoPopover></header>
    <dl className="facts"><div><dt>Dedicated GPU memory</dt><dd>{device.memoryTotalMi == null ? 'Not reported' : device.memoryTotalMi < 1024 ? `${device.memoryTotalMi} MiB` : `${Number((device.memoryTotalMi / 1024).toFixed(1))} GiB`}</dd></div></dl>
  </section>;

const HardwareNode = ({node, host, compatibility, devices, session, stale}: {node: GpuCompatibilityNode; host?: ManagedHost; compatibility?: GpuCompatibility; devices: HardwareGpuDevice[]; session: Session; stale: boolean}) => <article className="operator-card stack compact" aria-label={`GPU node ${node.node}`}>
  <header><div className="inline-info"><strong>Node: {node.node}</strong>{node.message && <InfoPopover label={`Node ${node.node}`}><p className="memory-info-note">{node.message}</p></InfoPopover>}</div></header>
  {host ? <HostPreparation key={`${host.nodeUid}:${host.bootId}:${host.plan?.id}`} host={host} session={session} stale={stale} embedded leadingFacts={<HardwareNodeFacts node={node} />} /> : <dl className="facts"><HardwareNodeFacts node={node} /></dl>}
  <section className="stack compact" aria-label={`GPUs on ${node.node}`}><h3>GPUs</h3>
    {devices.map((device) => {
      const singleProviderDevice = devices.filter((item) => item.vendor === device.vendor).length === 1;
      const ownsMemory = device.vendor === 'amd' && host && (host.gpuMemory?.pciAddress === device.pciAddress || !host.gpuMemory?.pciAddress && singleProviderDevice && device.memoryArchitecture === 'unified');
      return <GpuSharingControls key={device.id} nodeUid={node.nodeUid} session={session} device={device} singleProviderDevice={singleProviderDevice}
        leadingControls={<><DeviceMemory device={device} /><DeviceFacts device={device} /></>}
        amdControls={device.vendor === 'amd' ? <>
          {compatibility && singleProviderDevice && <ProfileControls key={`${compatibility.selectedProfile}:${compatibility.allowExperimental}`} compatibility={compatibility} admin={canAdminister(session)} />}
          {ownsMemory && <details className="hardware-advanced"><summary><strong>Shared GPU memory</strong> <SharedGpuMemoryInfo host={host} /></summary><HostMemoryControls host={host} session={session} stale={stale} hideHeading /></details>}
        </> : undefined} />;
    })}
    {!devices.length && <Empty>No physical GPU inventory reported yet.</Empty>}
  </section>
  <DeviceEngineValidation key={node.nodeUid ?? node.node} node={node} devices={devices} session={session} />
</article>;

const ProfileControls = ({compatibility, admin}: {compatibility: GpuCompatibility; admin: boolean}) => {
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
  return <details className="hardware-advanced">
    <summary><strong>AMD runtime profile</strong> <InfoPopover label="AMD runtime profile"><p className="memory-info-note">Host preparation already activates the matching profile. This manual override changes the cluster's AMD ModuleActivation only; it installs no kernel or driver and does not start engine tests.</p><p className="memory-info-note">Switching back to upstream rules removes the custom profile; existing models may lose GPU eligibility.</p>{selected && <p className="memory-info-note">{selected.description} Profile selection applies only to matching hardware; it does not certify other cards.</p>}{!admin && <p className="memory-info-note">Administrator access is required to change profiles or run validation.</p>}</InfoPopover></summary>
    <div className="stack">{admin ? <>
    <Field label="AMD compatibility profile"><select value={profileId} disabled={mutation.isPending} onChange={(event) => {setProfileId(event.target.value); setAcknowledged(false);}}>
      <option value="">Upstream operator rules only</option>
      {compatibility.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName} · {profile.version}{profile.experimental ? ' · Experimental' : ''}</option>)}
    </select></Field>
    {selected?.experimental && <label className="check-field"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> I accept the experimental hardware profile and its limitations.</label>}
    <div className="form-actions"><Button disabled={mutation.isPending || Boolean(selected?.experimental && !acknowledged) || !changed} onClick={() => mutation.mutate()}>Save hardware profile</Button></div>
    <ErrorNotice error={mutation.error} />
    </> : <span>Current profile: {compatibility.selectedProfile || 'upstream rules'}</span>}</div>
  </details>;
};

const DeviceEngineValidation = ({node, devices, session}: {node: GpuCompatibilityNode; devices: HardwareGpuDevice[]; session: Session}) => {
  const client = useQueryClient();
  const [selection, setSelection] = useState('all');
  const [pending, setPending] = useState<{engine: 'OLlama' | 'VLLM'; devices: HardwareGpuDevice[]; requestId: string} | null>(null);
  const selected = devices.filter((device) => selection === 'all' || device.id === selection);
  const mutation = useMutation({
    retry: false,
    mutationFn: () => {
      if (!pending) throw new Error('No GPU verification selected.');
      return api.requestGpuValidation({nodeName: node.node, nodeUid: node.nodeUid ?? '', engine: pending.engine,
        deviceIds: pending.devices.map((d) => d.id), requestId: pending.requestId, acknowledgeResourceUse: true});
    },
    onSuccess: async () => {
      setPending(null);
      await Promise.all([client.invalidateQueries({queryKey: ['status']}), client.invalidateQueries({queryKey: ['modules']}), client.invalidateQueries({queryKey: ['models']})]);
    },
  });
  return <section className="stack compact" aria-label={`Engine validation on ${node.node}`}>
    <div className="inline-info"><h4>Engine validation · Optional</h4><InfoPopover label={`Engine validation on ${node.node}`}><p className="memory-info-note">Manual diagnostics only. Choose every GPU on this node or one physical device. Tests run sequentially and may wait for active models. Results never disable an otherwise ready GPU.</p>{selected.filter((d) => d.validationReason).map((d) => <p key={d.id} className="memory-info-note">{d.name}: {d.validationReason}</p>)}</InfoPopover></div>
    <div className="gpu-validation-target"><Field label="GPUs to verify"><select value={selection} onChange={(event) => setSelection(event.target.value)} disabled={mutation.isPending}>
      <option value="all">All GPUs on {node.node}</option>{devices.map((device) => <option value={device.id} key={device.id}>{device.name} · {device.pciAddress || 'PCI address unknown'}</option>)}
    </select></Field></div>
    {(['OLlama', 'VLLM'] as const).map((engine) => {
      const name = engine === 'OLlama' ? 'Ollama' : 'vLLM';
      return <div className="operator-card stack compact" key={engine}>
        <header><strong>{name}</strong>{canAdminister(session) && <Button variant="ghost" disabled={mutation.isPending || !selected.length || !node.nodeUid || selected.some((d) => !d.validationAvailable || ['queued', 'running'].includes(d.validation?.[engine]?.state ?? ''))}
          onClick={() => {mutation.reset(); setPending({engine, devices: [...selected], requestId: `dashboard-${Date.now()}-${crypto.randomUUID()}`});}}>Verify {name}</Button>}</header>
        {selected.map((device) => {
          const validation = device.validation?.[engine];
          return <div className="list-row gpu-validation-device" key={device.id}><div className="inline-info"><span>{device.name} · {device.pciAddress || 'PCI address unknown'}</span><InfoPopover label={`${name} validation on ${device.name} · ${device.pciAddress}`}><p className="memory-info-note">{validation?.message || 'No local GPU test recorded. Validation is optional.'}</p>{device.validationReason && <p className="memory-info-note">{device.validationReason}</p>}{validation?.image && <p className="memory-info-note">Image: {validation.image}</p>}{validation?.validatedAt && <p className="memory-info-note">Validated: {validation.validatedAt}</p>}{validation?.runtimeMessage && <p className="memory-info-note">{validation.runtimeMessage}</p>}</InfoPopover></div><div className="tag-list">{validation?.state === 'passed' ? <span className="status status-good">GPU smoke passed</span> : <StatusBadge phase={validation?.state ?? 'unverified'} />}{validation?.runtimeReady !== undefined && <span className={`status status-${validation.runtimeReady ? 'good' : 'warn'}`}>{validation.runtimeReady ? 'Runtime Ready' : 'Runtime pending'}</span>}</div></div>;
        })}
      </div>;
    })}
    <ConfirmDialog open={Boolean(pending)} title={`Verify ${pending?.engine === 'OLlama' ? 'Ollama' : 'vLLM'}`} description={`Verify ${pending?.devices.map((d) => `${d.name} (${d.pciAddress})`).join(', ')} on ${node.node} using the saved configuration. Unsaved profile changes are not applied. Test images may be downloaded and GPU resources used. Tests are sequential and may wait for active models. Other engines and nodes are not requested. Results are optional smoke checks, not model-size or quality guarantees.`} confirmLabel="Run verification" busy={mutation.isPending} error={mutation.error} onClose={() => setPending(null)} onConfirm={() => mutation.mutate()} />
  </section>;
};

export const HardwarePage = ({session}: {session: Session}) => {
  const query = useQuery({queryKey: ['status'], queryFn: () => api.status(), refetchInterval: 15_000});
  const hosts = useHosts();
  const sharing = useQuery({queryKey: ['gpu-sharing'], queryFn: () => api.gpuSharing(), refetchInterval: 15_000});
  if (query.error) return <ErrorNotice error={query.error} />;
  if (query.isPending || !query.data) return <Loading />;
  const operators = Object.entries(query.data.hardwareOperators ?? {});
  const compatibility = query.data.hardwareOperators?.['amd-gpu']?.compatibility;
  const nodes: GpuCompatibilityNode[] = [...(compatibility?.nodes ?? [])];
  const devices = operators.flatMap(([, operator]) => operator.devices ?? []);
  for (const device of devices) {
    if (!nodes.some((node) => node.nodeUid === device.nodeUid)) nodes.push({node: device.node, nodeUid: device.nodeUid});
  }
  for (const host of hosts.data?.nodes ?? []) {
    if (!nodes.some((node) => node.nodeUid ? node.nodeUid === host.nodeUid : node.node === host.name)) {
      nodes.push({node: host.name, nodeUid: host.nodeUid});
    }
  }
  return <div className="stack">
    <div className="section-title"><div className="inline-info"><h2>Hardware</h2><InfoPopover label="Hardware"><p className="memory-info-note">GPUs are available when hardware and driver checks pass and Kubernetes registers the resource. Engine validation is optional.</p></InfoPopover></div><Button variant="ghost" onClick={() => query.refetch()}>Refresh hardware</Button></div>
    <Panel title="GPU operators"><div className="list">{operators.map(([id, operator]) => <article className="list-row" key={id}><div><div className="inline-info"><strong>{operator.displayName ?? id}</strong>{operator.message && <InfoPopover label={operator.displayName ?? id}><p className="memory-info-note">{operator.message}</p></InfoPopover>}</div><small className="muted">{operator.detectedNodes?.length ?? 0} nodes · {operator.allocatableResources ?? 0} GPU resources · {operator.operatorVersion ?? 'Version unknown'}</small></div><StatusBadge phase={operator.phase} /></article>)}</div>{!operators.length && <Empty>No hardware operator status reported.</Empty>}</Panel>
    <Panel title="GPU nodes"><ErrorNotice error={hosts.error} />{hosts.isPending && <Loading />}{nodes.length ? <div className="stack">{nodes.map((node) => {
      const nodeCompatibility = compatibility?.nodes.some((item) => node.nodeUid ? item.nodeUid === node.nodeUid : item.node === node.node) ? compatibility : undefined;
      const nodeDevices = devices.filter((d) => d.nodeUid === node.nodeUid);
      // During a rolling upgrade show existing evidence, but do not claim an
      // exact-device test is available until physical PCI inventory arrives.
      if (!nodeDevices.length) {
        if (nodeCompatibility) nodeDevices.push({id: `${node.nodeUid}/legacy-amd`, node: node.node, nodeUid: node.nodeUid ?? '', vendor: 'amd', name: 'AMD GPU', pciAddress: '', pciId: node.pciDevices?.join(', ') ?? '', architecture: node.detectedArchitecture, hostDriverReady: node.hostDriverReady, resourceRegistered: node.resourceRegistered, memoryArchitecture: node.memoryArchitecture, memory: node, validation: node.validation, validationAvailable: false, validationReason: 'Waiting for fresh physical GPU inventory from the host.'});
        if (sharing.data?.providers.some((s) => s.nodeUid === node.nodeUid && s.provider === 'nvidia')) nodeDevices.push({id: `${node.nodeUid}/legacy-nvidia`, node: node.node, nodeUid: node.nodeUid ?? '', vendor: 'nvidia', name: 'NVIDIA GPU', pciAddress: '', pciId: '', validationAvailable: false, validationReason: 'Waiting for fresh physical GPU inventory from the host.'});
      }
      return <HardwareNode key={node.nodeUid ?? node.node} node={node} devices={nodeDevices} compatibility={nodeCompatibility} session={session} stale={Boolean(hosts.error)} host={hosts.data?.nodes.find((host) => node.nodeUid ? node.nodeUid === host.nodeUid : node.node === host.name)} />;
    })}</div> : !hosts.isPending && <Empty>No GPU nodes reported.</Empty>}</Panel>
  </div>;
};
