import {useState, type ReactNode} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {canAdminister} from '@magicstick/dashboard-core';
import type {GpuSharingState, Session} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, ErrorNotice, Field, Loading, StatusBadge} from '../components';
import {InfoPopover} from '../InfoPopover';

const SharingForm = ({state, session}: {state: GpuSharingState; session: Session}) => {
  const client = useQueryClient();
  const [mode, setMode] = useState(state.mode);
  const [maxModels, setMaxModels] = useState(state.maxModels);
  const [confirm, setConfirm] = useState(false);
  const admin = canAdminister(session);
  const vendor = state.provider === 'amd' ? 'AMD' : 'NVIDIA';
  const backend = state.backend === 'dra' ? 'DRA' : 'Time-slicing';
  const shared = mode === 'shared';
  const changed = mode !== state.mode || shared && maxModels !== state.maxModels;
  const mutation = useMutation({
    mutationFn: () => api.configureGpuSharing({provider: state.provider, mode,
      maxModels: shared ? maxModels : Math.max(2, Math.min(16, Math.trunc(maxModels) || 2)),
      nodeName: state.nodeName, nodeUid: state.nodeUid, expectedRevision: state.expectedRevision,
      acknowledgeSharing: shared, acknowledgeRestart: true}),
    onSuccess: async () => {
      setConfirm(false);
      await Promise.all([client.invalidateQueries({queryKey: ['gpu-sharing']}), client.invalidateQueries({queryKey: ['status']}), client.invalidateQueries({queryKey: ['models']})]);
    },
  });
  return <section className="stack compact" aria-label={`${vendor} GPU sharing`}>
    <header><div className="inline-info"><h5 className="gpu-sharing-title">GPU sharing</h5><InfoPopover label={`${vendor} GPU sharing`}>
      <p className="memory-info-note">Several model pods can share one physical GPU. This does not partition GPU memory or guarantee throughput. Model memory budgets and CPU offloading settings remain separate.</p>
      <p className="memory-info-note">{vendor} uses {backend}. Changes apply only to this provider. Managed {vendor} model pods may restart; model settings and downloads remain. This first version manages one GPU on one node per provider.</p>
      {state.provider === 'nvidia' && <p className="memory-info-note">The existing NVIDIA device plugin and driver stay installed. This does not enable NVIDIA DRA, MIG or MPS.</p>}
      {state.reason && <p className="memory-info-note">{state.reason}</p>}{state.message && <p className="memory-info-note">{state.message}</p>}
    </InfoPopover></div><StatusBadge phase={state.phase} /></header>
    <div className="form-grid">
      <Field label={`${vendor} allocation mode`}><select value={mode} disabled={!admin || mutation.isPending} onChange={(event) => setMode(event.target.value as typeof mode)}>
        <option value="exclusive">Exclusive · one model per GPU</option>
        <option value="shared" disabled={!state.available}>Shared · multiple models</option>
      </select></Field>
      {shared && <Field label={`${vendor} maximum simultaneous models`}><input type="number" min={2} max={16} step={1} value={maxModels} disabled={!admin || mutation.isPending} onChange={(event) => setMaxModels(Number(event.target.value))} /></Field>}
    </div>
    <div className="tag-list"><span>{backend} {state.backend === 'dra' ? 'sharing configuration' : 'configuration'}</span>{state.managed && state.mode === 'shared' && <span>{state.activeModels} active · up to {state.maxModels} models</span>}{state.device?.pciAddress && <span>GPU: {state.device.pciAddress}</span>}</div>
    {admin && <div className="form-actions"><Button disabled={!changed || mutation.isPending || shared && (!state.available || !Number.isInteger(maxModels) || maxModels < 2 || maxModels > 16)} onClick={() => {mutation.reset(); setConfirm(true);}}>Apply {vendor} sharing</Button></div>}
    <ErrorNotice error={mutation.error} />
    <ConfirmDialog open={confirm} title={`Change ${vendor} GPU allocation`} description={`Managed ${vendor} model pods may restart. Model settings and cached downloads remain. Other GPU providers are unchanged. Shared mode has no isolated GPU memory or guaranteed performance per model.`} confirmLabel={`Apply and restart ${vendor} models`} busy={mutation.isPending} error={mutation.error} onClose={() => setConfirm(false)} onConfirm={() => mutation.mutate()} />
  </section>;
};

export const GpuSharingControls = ({nodeUid, session, amdControls}: {nodeUid?: string; session: Session; amdControls?: ReactNode}) => {
  const query = useQuery({queryKey: ['gpu-sharing'], queryFn: () => api.gpuSharing(), refetchInterval: 15_000});
  const providers = (query.data?.providers ?? []).filter((state) => nodeUid && state.nodeUid === nodeUid);
  return <><ErrorNotice error={query.error} />{query.isPending && <Loading />}{(['amd', 'nvidia'] as const).map((provider) => {
    const state = providers.find((item) => item.provider === provider);
    const controls = provider === 'amd' ? amdControls : undefined;
    if (!state && !controls) return null;
    const vendor = provider === 'amd' ? 'AMD' : 'NVIDIA';
    return <section key={provider} className="gpu-configuration" aria-label={`${vendor} GPU configuration`}><details>
      <summary><h4 className="gpu-configuration-title">GPU Configuration {vendor}</h4></summary>
      <div className="stack compact gpu-configuration-content">
        {state && <SharingForm key={`${state.mode}:${state.maxModels}:${state.nodeUid}`} state={state} session={session} />}
        {controls}
      </div>
    </details></section>;
  })}</>;
};
