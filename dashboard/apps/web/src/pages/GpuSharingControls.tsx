import {useState} from 'react';
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
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const admin = canAdminister(session);
  const vendor = state.provider === 'amd' ? 'AMD' : 'NVIDIA';
  const backend = state.backend === 'dra' ? 'DRA' : 'Time-slicing';
  const shared = mode === 'shared';
  const changed = !state.managed || mode !== state.mode || shared && maxModels !== state.maxModels;
  const mutation = useMutation({
    mutationFn: () => api.configureGpuSharing({provider: state.provider, mode,
      maxModels: shared ? maxModels : Math.max(2, Math.min(16, Math.trunc(maxModels) || 2)),
      nodeName: state.nodeName, nodeUid: state.nodeUid, expectedRevision: state.expectedRevision,
      acknowledgeSharing: acknowledged, acknowledgeRestart: true}),
    onSuccess: async () => {
      setConfirm(false);
      await Promise.all([client.invalidateQueries({queryKey: ['gpu-sharing']}), client.invalidateQueries({queryKey: ['status']}), client.invalidateQueries({queryKey: ['models']})]);
    },
  });
  return <section className="stack compact" aria-label={`${vendor} GPU sharing`}>
    <header><div className="inline-info"><h4>GPU sharing · {vendor}</h4><InfoPopover label={`${vendor} GPU sharing`}>
      <p className="memory-info-note">Several model pods can share one physical GPU. This does not partition GPU memory or guarantee throughput. Model memory budgets and CPU offloading settings remain separate.</p>
      <p className="memory-info-note">{vendor} uses {backend}. Changes apply only to this provider. Managed {vendor} model pods may restart; model settings and downloads remain. This first version manages one GPU on one node per provider.</p>
      {state.provider === 'nvidia' && <p className="memory-info-note">The existing NVIDIA device plugin and driver stay installed. This does not enable NVIDIA DRA, MIG or MPS.</p>}
      {state.reason && <p className="memory-info-note">{state.reason}</p>}{state.message && <p className="memory-info-note">{state.message}</p>}
    </InfoPopover></div><StatusBadge phase={state.phase} /></header>
    <div className="form-grid">
      <Field label={`${vendor} allocation mode`}><select value={mode} disabled={!admin || mutation.isPending} onChange={(event) => {setMode(event.target.value as typeof mode); setAcknowledged(false);}}>
        <option value="exclusive">Exclusive · one model per GPU</option>
        <option value="shared" disabled={!state.available}>Shared · multiple models</option>
      </select></Field>
      {shared && <Field label={`${vendor} maximum simultaneous models`}><input type="number" min={2} max={16} step={1} value={maxModels} disabled={!admin || mutation.isPending} onChange={(event) => setMaxModels(Number(event.target.value))} /></Field>}
    </div>
    <div className="meta"><span>{backend}{state.experimental ? ' · Experimental' : ''}</span>{!state.managed && <span>Inherited configuration</span>}{state.managed && state.mode === 'shared' && <span>{state.activeModels} active · up to {state.maxModels} models</span>}{state.device?.pciAddress && <span>GPU: {state.device.pciAddress}</span>}</div>
    {admin && changed && shared && <label className="check-field"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> I accept {state.experimental ? 'experimental ' : ''}{vendor} sharing without isolated GPU memory limits.</label>}
    {admin && <div className="form-actions"><Button disabled={!changed || mutation.isPending || shared && (!state.available || !acknowledged || !Number.isInteger(maxModels) || maxModels < 2 || maxModels > 16)} onClick={() => {mutation.reset(); setConfirm(true);}}>Apply {vendor} sharing</Button></div>}
    <ErrorNotice error={mutation.error} />
    <ConfirmDialog open={confirm} title={`Change ${vendor} GPU allocation`} description={`Managed ${vendor} model pods may restart. Model settings and cached downloads remain. Other GPU providers are unchanged. Shared mode has no isolated GPU memory or guaranteed performance per model.`} confirmLabel={`Apply and restart ${vendor} models`} busy={mutation.isPending} error={mutation.error} onClose={() => setConfirm(false)} onConfirm={() => mutation.mutate()} />
  </section>;
};

export const GpuSharingControls = ({nodeUid, session}: {nodeUid?: string; session: Session}) => {
  const query = useQuery({queryKey: ['gpu-sharing'], queryFn: () => api.gpuSharing(), refetchInterval: 15_000});
  if (query.error) return <ErrorNotice error={query.error} />;
  if (query.isPending) return <Loading />;
  const providers = (query.data?.providers ?? []).filter((state) => nodeUid && state.nodeUid === nodeUid);
  return <>{providers.map((state) => <SharingForm key={`${state.provider}:${state.mode}:${state.maxModels}:${state.nodeUid}`} state={state} session={session} />)}</>;
};
