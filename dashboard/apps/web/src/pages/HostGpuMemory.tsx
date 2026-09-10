import {useEffect, useState} from 'react';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {canAdminister} from '@magicstick/dashboard-core';
import type {HostGpuMemory, HostGpuMemorySettings, ManagedHost, Session} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, Field} from '../components';

const terminal = new Set(['Succeeded', 'PreparedUnverified', 'Failed', 'Rejected', 'Interrupted']);
const formatMi = (value?: number) => value === undefined ? 'Unknown' : value < 1024 ? `${value.toLocaleString()} MiB` : `${Number((value / 1024).toFixed(1)).toLocaleString()} GiB`;
const positive = (value?: number): value is number => value !== undefined && Number.isFinite(value) && value > 0;

const MemoryControls = ({host, memory, session, stale}: {host: ManagedHost; memory: HostGpuMemory; session: Session; stale: boolean}) => {
  const client = useQueryClient();
  const options = [...(memory.options ?? [])].sort((left, right) => left.sizeMi - right.sizeMi);
  const step = memory.stepMi ?? 1024;
  const minimum = memory.minDynamicLimitMi ?? 1024;
  const reserve = Math.max(16384, memory.systemReserveMi ?? 16384);
  const complete = Boolean(memory.id && positive(memory.systemMemoryMi) && positive(memory.currentCarveoutMi)
    && positive(memory.currentDynamicLimitMi) && positive(step) && positive(minimum) && options.length
    && options.every((option) => Number.isInteger(option.index) && positive(option.sizeMi))
    && options.some((option) => option.index === memory.currentCarveoutIndex));
  const projectedRam = (index: number) => (memory.systemMemoryMi ?? 0) + (memory.currentCarveoutMi ?? 0) - (options.find((option) => option.index === index)?.sizeMi ?? 0);
  const maximumFor = (index: number) => Math.floor((projectedRam(index) - reserve) / step) * step;
  const snap = (value: number, index: number) => Math.max(minimum, Math.min(maximumFor(index), Math.floor(value / step) * step));
  const [draft, setDraft] = useState<HostGpuMemorySettings>(() => ({carveoutIndex: memory.currentCarveoutIndex ?? -1,
    dynamicLimitMi: complete ? snap(memory.currentDynamicLimitMi!, memory.currentCarveoutIndex!) : 0}));
  const [dirty, setDirty] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState<{settings: HostGpuMemorySettings; requestId: string} | null>(null);
  const [accepted, setAccepted] = useState('');
  const busy = Boolean(host.operation && !terminal.has(host.operation.phase));
  const awaitingObservation = Boolean(accepted && host.operation?.requestId !== accepted);
  const blocked = stale || !host.available || !complete || !memory.supported || busy || awaitingObservation;
  const selected = options.find((option) => option.index === draft.carveoutIndex);
  const maximum = maximumFor(draft.carveoutIndex);
  const changed = draft.carveoutIndex !== memory.currentCarveoutIndex || draft.dynamicLimitMi !== memory.currentDynamicLimitMi;
  const valid = Boolean(selected && Number.isInteger(draft.dynamicLimitMi) && draft.dynamicLimitMi >= minimum
    && draft.dynamicLimitMi <= maximum && draft.dynamicLimitMi % step === 0);
  const mutation = useMutation({
    mutationFn: () => {
      if (!pending || blocked || !canAdminister(session) || !acknowledged || !dirty || !valid || !changed) throw new Error('Host state changed. Review the current memory configuration again.');
      return api.requestHostOperation({action: 'configure-gpu-memory', nodeName: host.name, nodeUid: host.nodeUid,
        bootId: host.bootId, requestId: pending.requestId, confirmation: host.name, acknowledgeDisruption: true,
        allowExperimental: true, experimentMode: false, planId: memory.id, gpuMemory: pending.settings});
    },
    retry: false,
    onSuccess: async () => {
      setAccepted(pending?.requestId ?? 'accepted'); setPending(null); setAcknowledged(false);
      await client.invalidateQueries({queryKey: ['host-management']});
    },
  });
  useEffect(() => {
    if (pending && blocked && !mutation.isPending) {
      setPending(null); setAcknowledged(false);
      setFeedback('Host state changed. Review the current memory configuration again.');
    }
  }, [blocked, pending, mutation.isPending]);

  const changeFixed = (position: number) => {
    const option = options[position];
    if (!option) return;
    const dynamicLimitMi = snap(draft.dynamicLimitMi, option.index);
    setDraft({carveoutIndex: option.index, dynamicLimitMi}); setDirty(true); setAcknowledged(false); setAccepted('');
    setFeedback(dynamicLimitMi !== draft.dynamicLimitMi
      ? `The dynamic GPU limit was adjusted to ${formatMi(dynamicLimitMi)} to retain the ${formatMi(reserve)} CPU/OS safety allowance. Review both values.` : '');
  };
  const changeDynamic = (value: number) => {
    setDraft({...draft, dynamicLimitMi: snap(value, draft.carveoutIndex)}); setDirty(true); setAcknowledged(false); setAccepted(''); setFeedback('');
  };
  const firmwareChanges = pending?.settings.carveoutIndex !== memory.currentCarveoutIndex;
  const plannedFixed = options.find((option) => option.index === pending?.settings.carveoutIndex);
  const controlsDisabled = blocked || mutation.isPending || Boolean(pending);
  const description = `${host.name}: fixed GPU reservation ${formatMi(memory.currentCarveoutMi)} → ${formatMi(plannedFixed?.sizeMi)}; dynamic GPU ceiling ${formatMi(memory.currentDynamicLimitMi)} → ${formatMi(pending?.settings.dynamicLimitMi)}. ${firmwareChanges ? 'A firmware reservation change may require up to two restarts: first to apply the firmware setting, then to activate and verify the dynamic limit.' : 'Changing only the dynamic limit requires one restart.'} All workloads on this computer will be interrupted. This is experimental; startup and model success are not guaranteed. Keep local console access and a recovery path. No workload migration is performed. The dynamic limit is a ceiling, not a reservation or guaranteed free memory.`;

  return <section className="host-gpu-memory stack compact" aria-label={`Shared GPU memory on ${host.name}`}>
    <header><strong>Shared GPU memory · Strix Halo</strong></header>
    <p className="muted">CPU and GPU use the same physical RAM. Firmware-reserved GPU memory is unavailable to Linux; dynamic GPU memory is borrowed from Linux RAM only when needed. These are not additional independent pools.</p>
    <dl className="facts">
      <div><dt>Current fixed GPU reservation</dt><dd>{formatMi(memory.currentCarveoutMi)}</dd></div>
      <div><dt>Current dynamic GPU ceiling (TTM)</dt><dd>{formatMi(memory.currentDynamicLimitMi)}</dd></div>
      <div><dt>Currently visible Linux RAM</dt><dd>{formatMi(memory.systemMemoryMi)}</dd></div>
      <div><dt>CPU/OS safety allowance</dt><dd>{formatMi(reserve)}</dd></div>
    </dl>
    {memory.message && <p className="muted">{memory.message}</p>}
    {!complete && <div className="notice notice-warn">Complete firmware and memory information is not available. Configuration is disabled.</div>}
    {(stale || !host.available) && <div className="notice notice-warn">Host information is unavailable or stale. Wait for a fresh report before making changes.</div>}
    {busy && <p role="status">Another host operation is in progress. Memory configuration is locked.</p>}
    {canAdminister(session) && memory.supported && complete && <>
      <div className="estimate stack compact">
        <Field label="Fixed GPU reservation (firmware)" hint="Only settings reported by this computer's firmware are offered. Changes remain a local draft until confirmed.">
          <input aria-label="Fixed GPU reservation (firmware)" aria-description="Only firmware-supported settings. Changing this slider does not apply the setting." type="range" min="0" max={options.length - 1} step="1" value={Math.max(0, options.findIndex((option) => option.index === draft.carveoutIndex))}
            aria-valuetext={`${selected?.label ?? 'Unknown'}: ${formatMi(selected?.sizeMi)}`} disabled={controlsDisabled || options.length < 2} onChange={(event) => changeFixed(Number(event.target.value))} />
        </Field>
        <div className="slider-labels"><span>{options[0]?.label} · {formatMi(options[0]?.sizeMi)}</span><span>{options.at(-1)?.label} · {formatMi(options.at(-1)?.sizeMi)}</span></div>
        <p className="host-memory-draft">Planned fixed reservation: <strong>{formatMi(selected?.sizeMi)}</strong> <span className="muted">({selected?.label})</span></p>
        <Field label="Dynamic GPU memory limit" hint={`Upper bound for on-demand GPU use of shared RAM, not reserved RAM. Steps of ${formatMi(step)}.`}>
          <input aria-label="Dynamic GPU memory limit" aria-description="Upper bound for on-demand GPU use of shared RAM, not a reservation." type="range" min={minimum} max={Math.max(minimum, maximum)} step={step} value={draft.dynamicLimitMi}
            aria-valuetext={formatMi(draft.dynamicLimitMi)} disabled={controlsDisabled || maximum < minimum} onChange={(event) => changeDynamic(Number(event.target.value))} />
        </Field>
        <div className="slider-labels"><span>{formatMi(minimum)}</span><span>Maximum for this draft: {formatMi(Math.max(0, maximum))}</span></div>
        <p className="host-memory-draft">Planned dynamic ceiling: <strong>{formatMi(draft.dynamicLimitMi)}</strong></p>
        {!dirty && draft.dynamicLimitMi !== memory.currentDynamicLimitMi && <p className="muted">The current kernel limit does not match a selectable step. The draft is rounded to {formatMi(draft.dynamicLimitMi)}; move a slider to choose a change. Nothing is applied automatically.</p>}
        <dl className="facts"><div><dt>Projected Linux RAM after fixed reservation</dt><dd>{formatMi(projectedRam(draft.carveoutIndex))}</dd></div><div><dt>Minimum Linux RAM outside the dynamic ceiling</dt><dd>{formatMi(projectedRam(draft.carveoutIndex) - draft.dynamicLimitMi)}</dd></div></dl>
        <p className="muted">The dynamic ceiling must leave at least {formatMi(reserve)} outside GPU dynamic allocations. CPU processes still compete for the shared pool; this does not guarantee available memory or reserve RAM for a model.</p>
      </div>
      {!valid && <div className="notice notice-warn">This combination does not leave enough Linux RAM for the required CPU/OS safety allowance. Choose a smaller fixed reservation or dynamic limit.</div>}
      {feedback && <div className="notice notice-warn" role="status">{feedback}</div>}
      <label className="check-field"><input type="checkbox" checked={acknowledged} disabled={controlsDisabled || !dirty || !changed || !valid}
        onChange={(event) => setAcknowledged(event.target.checked)} /> I accept the experimental memory configuration, workload interruption and possible restarts. I have local recovery access.</label>
      <div className="form-actions"><Button variant="primary" disabled={controlsDisabled || !dirty || !changed || !valid || !acknowledged} onClick={() => {
        mutation.reset(); setPending({settings: {...draft}, requestId: crypto.randomUUID().replaceAll('-', '')});
      }}>Review memory configuration</Button></div>
      <ConfirmDialog key={pending?.requestId ?? 'closed'} open={Boolean(pending)} title="Configure GPU shared memory" description={description}
        confirmLabel="Apply memory configuration" expectedValue={host.name} busy={mutation.isPending || blocked} error={mutation.error}
        onClose={() => {if (!mutation.isPending) setPending(null);}} onConfirm={() => mutation.mutate()} />
    </>}
    {accepted && <p role="status">Memory configuration requested. Follow the host operation status; a request is not confirmation of a successful restart or applied memory layout.</p>}
  </section>;
};

export const HostGpuMemoryPanel = ({host, session, stale = false}: {host: ManagedHost; session: Session; stale?: boolean}) => {
  const memory = host.gpuMemory;
  if (!memory?.supported) return <section className="host-gpu-memory stack compact" aria-label={`Shared GPU memory on ${host.name}`}><strong>Shared GPU memory</strong><p className="muted">{memory?.message || 'Shared GPU memory configuration is unavailable for this computer.'}</p></section>;
  // Polling preserves the draft; changed node, boot or fingerprinted configuration evidence invalidates it and any open confirmation.
  return <MemoryControls key={`${host.name}:${host.nodeUid}:${host.bootId}:${memory.id}`} host={host} memory={memory} session={session} stale={stale} />;
};
