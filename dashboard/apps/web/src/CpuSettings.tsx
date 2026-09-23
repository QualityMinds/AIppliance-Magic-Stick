import {useState} from 'react';
import type {CpuResources, ModelsPayload} from '@magicstick/dashboard-contracts';
import {Button, Field} from './components';

const cpuDraft = (value: unknown) => {
  const policy = value as Partial<CpuResources> | undefined;
  return {
    request: typeof policy?.requestMillicores === 'number' ? String(policy.requestMillicores / 1000) : '',
    limit: typeof policy?.limitMillicores === 'number' ? String(policy.limitMillicores / 1000) : '',
  };
};
const validCpu = (value: string, minimum: number) => value === '' || (Number.isFinite(Number(value))
  && Number(value) >= minimum && Math.abs(Number(value) * 1000 - Math.round(Number(value) * 1000)) < 1e-8);

export const useCpuSettings = (initialValue: unknown, models: ModelsPayload, engine: string, target: string) => {
  const [initial] = useState(() => cpuDraft(initialValue));
  const [draft, setDraft] = useState(initial);
  const defaults = models.computeTargets.engineCatalog?.[engine]?.cpuDefaults?.[target === 'cpu' ? 'cpu' : 'gpu'];
  const request = draft.request === '' ? defaults?.requestMillicores : Math.round(Number(draft.request) * 1000);
  const limit = draft.limit === '' ? defaults?.limitMillicores : Math.round(Number(draft.limit) * 1000);
  return {
    draft, setDraft, defaults,
    changed: draft.request !== initial.request || draft.limit !== initial.limit,
    invalid: !validCpu(draft.request, 0.001) || !validCpu(draft.limit, 0)
      || (request !== undefined && limit !== undefined && limit > 0 && limit < request),
    payload: draft.request === '' && draft.limit === '' ? null : {
      ...(draft.request !== '' ? {requestMillicores: Math.round(Number(draft.request) * 1000)} : {}),
      ...(draft.limit !== '' ? {limitMillicores: Math.round(Number(draft.limit) * 1000)} : {}),
    },
  };
};

export type CpuSettingsState = ReturnType<typeof useCpuSettings>;

export const CpuSettings = ({settings}: {settings: CpuSettingsState}) => {
  const {draft, setDraft, defaults, invalid} = settings;
  return <section className="stack compact">
    <header><strong>CPU</strong> <span tabIndex={0} aria-label="CPU scheduling information" title="The reservation controls scheduling and CPU weight under contention; it does not pin cores. Models can use spare CPU up to the optional limit. RAM and VRAM budgets do not change CPU settings. Blank fields use engine defaults; a limit of 0 removes the CPU quota.">ⓘ</span></header>
    <div className="form-grid">
      <Field label="CPU reservation (cores)"><input type="number" min="0.001" step="0.001" value={draft.request} placeholder={defaults ? `Auto (${defaults.requestMillicores / 1000})` : 'Auto'} onChange={(event) => setDraft({...draft, request: event.target.value})} /></Field>
      <Field label="CPU limit (cores, 0 = unlimited)"><input type="number" min="0" step="0.001" value={draft.limit} placeholder={defaults ? `Auto (${defaults.limitMillicores ? defaults.limitMillicores / 1000 : 'unlimited'})` : 'Auto'} onChange={(event) => setDraft({...draft, limit: event.target.value})} /></Field>
    </div>
    {invalid && <p className="notice notice-warn" role="alert">Enter a positive CPU reservation. The limit must be at least the reservation, or 0 for unlimited.</p>}
    <Button type="button" variant="ghost" disabled={!draft.request && !draft.limit} onClick={() => setDraft({request: '', limit: ''})}>Use automatic CPU settings</Button>
  </section>;
};
