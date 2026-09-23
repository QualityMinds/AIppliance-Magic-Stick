import {useEffect, useRef, useState} from 'react';
import type {ModelsPayload, VllmConfiguration} from '@magicstick/dashboard-contracts';
import {Field} from './components';

export const useVllmDeploymentSettings = (initialValue: unknown, models: ModelsPayload, engine: string, target: string) => {
  const definition = models.computeTargets.engineCatalog?.[engine]?.deploymentSettings?.visionAttention;
  const available = Boolean(definition?.computeTargets.includes(target));
  const automatic = definition?.default ?? 'auto';
  const [initial] = useState((initialValue as VllmConfiguration | undefined)?.visionAttention ?? automatic);
  const [value, setValue] = useState(initial);
  const previousSelection = useRef({engine, target});
  // Never carry an AMD override into another engine or compute target.
  useEffect(() => {
    const changedSelection = previousSelection.current.engine !== engine || previousSelection.current.target !== target;
    if (!available || changedSelection) setValue(automatic);
    previousSelection.current = {engine, target};
  }, [available, automatic, engine, target]);
  return {
    available, definition, value, setValue,
    changed: available && value !== initial,
    invalid: available && !definition?.options.some((option) => option.value === value),
    payload: available ? {visionAttention: value} : undefined,
  };
};

export type VllmDeploymentSettingsState = ReturnType<typeof useVllmDeploymentSettings>;

export const VllmDeploymentSettings = ({settings}: {settings: VllmDeploymentSettingsState}) => {
  const {available, definition, value, setValue, invalid} = settings;
  if (!available || !definition) return null;
  const selected = definition.options.find((option) => option.value === value);
  return <section className="stack compact">
    <header><strong>Deployment</strong> <span tabIndex={0} aria-label="Deployment information" title="vLLM vision encoder attention for multimodal models. This is separate from the text decoder and KV-cache precision. Manual backends depend on the GPU, model and runtime image; selecting one is not a successful compatibility test. Saving a change may restart the model.">ⓘ</span></header>
    <Field label="Vision attention backend"><select value={value} onChange={(event) => setValue(event.target.value as VllmConfiguration['visionAttention'])}>
      {invalid && <option value={value} disabled>Current setting unavailable: {value}</option>}
      {definition.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select></Field>
    {selected && <span className="muted" tabIndex={0} aria-label="Selected vision backend information" title={selected.description}>ⓘ</span>}
    {invalid && <p className="notice notice-warn" role="alert">This vision backend is no longer offered by the runtime catalog. Select an available option.</p>}
  </section>;
};
