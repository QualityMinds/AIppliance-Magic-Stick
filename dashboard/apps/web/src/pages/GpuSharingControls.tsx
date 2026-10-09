import {useState, type ReactNode} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {canAdminister} from '@magicstick/dashboard-core';
import type {GpuSharingState, HardwareGpuDevice, Session} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, ErrorNotice, Field, Loading, StatusBadge} from '../components';
import {InfoPopover} from '../InfoPopover';

const SharingForm = ({state, session}: {state: GpuSharingState; session: Session}) => {
  const client = useQueryClient();
  const [mode, setMode] = useState(state.mode);
  const [maxModels, setMaxModels] = useState(state.maxModels);
  const [allocationBackend, setAllocationBackend] = useState<'dra' | 'device-plugin'>(state.backend === 'dra' ? 'dra' : 'device-plugin');
  const [confirm, setConfirm] = useState(false);
  const admin = canAdminister(session);
  const vendor = state.provider === 'amd' ? 'AMD' : 'NVIDIA';
  const backend = allocationBackend === 'dra' ? 'DRA' : 'Time-slicing';
  const shared = mode === 'shared';
  const changed = mode !== state.mode || shared && maxModels !== state.maxModels || state.provider === 'nvidia' && allocationBackend !== (state.backend === 'dra' ? 'dra' : 'device-plugin');
  const mutation = useMutation({
    mutationFn: () => api.configureGpuSharing({provider: state.provider, mode,
      maxModels: shared ? maxModels : Math.max(2, Math.min(16, Math.trunc(maxModels) || 2)),
      nodeName: state.nodeName, nodeUid: state.nodeUid, expectedRevision: state.expectedRevision,
      ...(state.provider === 'nvidia' ? {allocationBackend} : {}),
      acknowledgeSharing: shared, acknowledgeRestart: true}),
    onSuccess: async () => {
      setConfirm(false);
      await Promise.all([client.invalidateQueries({queryKey: ['gpu-sharing']}), client.invalidateQueries({queryKey: ['status']}), client.invalidateQueries({queryKey: ['models']})]);
    },
  });
  return <details className="gpu-sharing stack compact" aria-label={`${vendor} GPU sharing`}>
    <summary><strong>GPU sharing</strong> <InfoPopover label={`${vendor} GPU sharing`}>
      <p className="memory-info-note">Several model pods can share one physical GPU. This does not partition GPU memory or guarantee throughput. Model memory budgets and CPU offloading settings remain separate.</p>
      <p className="memory-info-note">{vendor} uses {backend}. Changes apply only to this provider. Managed {vendor} model pods may restart; model settings and downloads remain. AMD supports one GPU; NVIDIA supports multiple whole GPUs on one node.</p>
      {state.provider === 'nvidia' && <p className="memory-info-note">DRA enables exact card selection for ordinary vLLM and Ollama models. Device-plugin mode automatically assigns a card from the node pool. Stop FreeToken, Realtime and unmanaged NVIDIA workloads before switching to DRA. The driver and toolkit remain installed; allocation backends never run together.</p>}
      {state.reason && <p className="memory-info-note">{state.reason}</p>}{state.message && <p className="memory-info-note">{state.message}</p>}
    </InfoPopover> <StatusBadge phase={state.phase} /></summary>
    <div className="stack compact gpu-configuration-content">
    <div className="form-grid">
      {state.provider === 'nvidia' && <Field label="NVIDIA GPU allocation backend"><select value={allocationBackend} disabled={!admin || mutation.isPending} onChange={(event) => setAllocationBackend(event.target.value as typeof allocationBackend)}>
        <option value="device-plugin">Device plugin · automatic card assignment</option>
        <option value="dra" disabled={!state.draAvailable}>DRA · select individual cards (Kubernetes 1.36+)</option>
      </select></Field>}
      <Field label={`${vendor} allocation mode`}><select value={mode} disabled={!admin || mutation.isPending} onChange={(event) => setMode(event.target.value as typeof mode)}>
        <option value="exclusive">Exclusive · one model per GPU</option>
        <option value="shared" disabled={!state.available}>Shared · multiple models</option>
      </select></Field>
      {shared && <Field label={`${vendor} maximum simultaneous models`}><input aria-label={`${vendor} maximum simultaneous models`} type="number" min={2} max={16} step={1} value={maxModels} disabled={!admin || mutation.isPending} onChange={(event) => setMaxModels(Number(event.target.value))} /><small>Slots per physical GPU, shared by all model engines.</small></Field>}
    </div>
    <div className="tag-list"><span>{backend} {allocationBackend === 'dra' ? 'sharing configuration' : 'configuration'}</span>{state.managed && state.mode === 'shared' && <span>{state.activeModels} active · up to {state.maxModels} models per GPU</span>}{state.device?.pciAddress && <span>GPU: {state.device.pciAddress}</span>}</div>
    {admin && <div className="form-actions"><Button disabled={!changed || mutation.isPending || shared && (!state.available || !Number.isInteger(maxModels) || maxModels < 2 || maxModels > 16)} onClick={() => {mutation.reset(); setConfirm(true);}}>Apply {vendor} sharing</Button></div>}
    <ErrorNotice error={mutation.error} />
    <ConfirmDialog open={confirm} title={`Change ${vendor} GPU allocation`} description={`Managed ${vendor} model pods may restart. Model settings and cached downloads remain. Other GPU providers are unchanged. Shared mode has no isolated GPU memory or guaranteed performance per model.`} confirmLabel={`Apply and restart ${vendor} models`} busy={mutation.isPending} error={mutation.error} onClose={() => setConfirm(false)} onConfirm={() => mutation.mutate()} />
    </div>
  </details>;
};

export const GpuSharingControls = ({nodeUid, session, amdControls, device, leadingControls, singleProviderDevice = true}: {nodeUid?: string; session: Session; amdControls?: ReactNode; device?: HardwareGpuDevice; leadingControls?: ReactNode; singleProviderDevice?: boolean}) => {
  const query = useQuery({queryKey: ['gpu-sharing'], queryFn: () => api.gpuSharing(), refetchInterval: 15_000});
  const providers = (query.data?.providers ?? []).filter((state) => nodeUid && state.nodeUid === nodeUid);
  return <><ErrorNotice error={query.error} />{query.isPending && <Loading />}{(device ? [device.vendor] : ['amd', 'nvidia']).map((provider) => {
    const state = providers.find((item) => item.provider === provider && singleProviderDevice && (!device || !item.device?.pciAddress || item.device.pciAddress === device.pciAddress));
    const controls = provider === 'amd' ? amdControls : undefined;
    if (!state && !controls && !device) return null;
    const vendor = provider === 'amd' ? 'AMD' : provider === 'nvidia' ? 'NVIDIA' : provider === 'intel' ? 'Intel' : 'GPU';
    return <section key={provider} className="gpu-configuration" aria-label={device ? `GPU ${device.name} · ${device.pciAddress}` : `${vendor} GPU configuration`}><details>
      <summary><h4 className="gpu-configuration-title">GPU Configuration {vendor}</h4>{device && <span className="gpu-device-name"> · {device.name} · {device.pciAddress || 'PCI address not reported'}</span>}</summary>
      <div className="stack compact gpu-configuration-content">
        {leadingControls}
        {state && <SharingForm key={`${state.backend}:${state.mode}:${state.maxModels}:${state.nodeUid}`} state={state} session={session} />}
        {controls}
      </div>
    </details></section>;
  })}</>;
};
