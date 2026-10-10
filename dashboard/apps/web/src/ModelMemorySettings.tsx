import type {CSSProperties} from 'react';
import {formatBytes, formatMi} from '@magicstick/dashboard-core';
import type {DiscoveryItem, GpuDeployment, MemoryCalculation, MemoryEstimate, VllmConfiguration} from '@magicstick/dashboard-contracts';
import {Button, Field} from './components';
import {MemoryInfo, unreservedCalculation} from './MemoryInfo';

export const roundMemory = (value: number) => Math.max(100, Math.ceil(value / 100) * 100);
export const quantizationText = (value: unknown) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  const item = value as {label?: string; method?: string; bits?: number};
  return item.label ?? [item.method, item.bits ? `${item.bits}-bit` : ''].filter(Boolean).join(' ');
};

export const GpuDeploymentSelect = ({mode, onChange, replication, count}: {mode: GpuDeployment; onChange: (mode: GpuDeployment) => void; replication: boolean; count: number}) => <section className="stack compact">
  <Field label="GPU deployment"><select value={mode} onChange={(event) => onChange(event.target.value as GpuDeployment)}>
    <option value="single">Single GPU · one model copy</option><option value="split">Split one model · across GPUs</option>
    {replication && <option value="replicated">Replicate model copies · one per GPU</option>}
  </select></Field>
  {mode === 'replicated' && <p>One API model name, with requests balanced across healthy copies. Each copy needs the full model memory budget; system RAM and CPU are reserved per copy.</p>}
  {mode !== 'single' && count < 2 && <p role="status">Select at least two GPUs on the same node for this deployment mode.</p>}
</section>;
export const MultiGpuSettings = ({count, engine, strategy, onStrategy, ramMi, onRam, offloading, ramMaximumMi, replicated}: {
  count: number; engine: string; strategy: NonNullable<VllmConfiguration['parallelism']>; onStrategy: (value: NonNullable<VllmConfiguration['parallelism']>) => void;
  ramMi: number; onRam: (value: number) => void; offloading: boolean; ramMaximumMi?: number | null; replicated: boolean;
}) => count > 1 ? <section className="stack compact"><strong>Multi-GPU runtime</strong>
  {!replicated && (engine === 'VLLM' ? <Field label="GPU parallelism"><select value={strategy} onChange={(event) => onStrategy(event.target.value as typeof strategy)}>
    <option value="auto">Auto · compatible model split</option><option value="tensor">Tensor · split layers across GPUs</option><option value="pipeline">Pipeline · consecutive layers per GPU</option>
  </select></Field> : <p>Ollama spreads the model across all selected GPUs. Its layer split is not a hard VRAM limit.</p>)}
  {!replicated && engine === 'VLLM' && <p className="muted">Auto uses tensor parallelism when model dimensions divide evenly, otherwise supported pipeline parallelism. Pipeline may be preferable without fast GPU interconnects; performance depends on the model and topology.</p>}
  {!offloading && <Field label={replicated ? 'System RAM per copy (MiB)' : 'Multi-GPU system RAM (MiB)'}><input type="number" min="1100" step="100" max={typeof ramMaximumMi === 'number' ? Math.floor(ramMaximumMi / 100) * 100 : undefined} value={ramMi} onChange={(event) => onRam(Number(event.target.value))} /></Field>}
  <p className="muted">{replicated ? 'Maximum system RAM per copy' : 'Unreserved system RAM on the selected node'}: {typeof ramMaximumMi === 'number' ? formatMi(ramMaximumMi) : 'not yet verified'}. The API rechecks this limit when saving.</p>
  <p className="muted">{replicated ? `${count} complete copies · ${formatMi(ramMi)} RAM each · ${formatMi(ramMi * count)} total host RAM. CPU settings apply to each copy.` : 'System RAM and CPU reservations apply once to the whole model Pod, not once per GPU.'}</p>
</section> : null;
export const EstimateBreakdown = ({estimate, budgetDevices = 1}: {estimate: MemoryEstimate; budgetDevices?: number}) => {
  const offloading = estimate.offloading;
  const runtime = estimate.runtimeDetails ?? {};
  const kvBudgetMi = Number(estimate.kvCacheMi ?? 0);
  const hasTheoreticalKv = estimate.theoreticalKvCacheMi !== null && estimate.theoreticalKvCacheMi !== undefined;
  const baseKvMi = Number(hasTheoreticalKv ? estimate.theoreticalKvCacheMi : kvBudgetMi);
  const hybridSafetyMi = Number(estimate.hybridAllocatorSafetyMi ?? Math.max(0, kvBudgetMi - baseKvMi));
  const attentionKvMi = Number(runtime.attentionKvCacheMi ?? 0);
  const recurrentStateMi = Number(runtime.recurrentStateMi ?? 0);
  const kvSavingsMi = Number(estimate.kvCacheSavingsMi ?? 0);
  const hasDetailedOllamaCache = attentionKvMi > 0 || recurrentStateMi > 0;
  const runtimeParts = [
    {label: 'Compile / warm-up', key: 'compileReserveMi', value: Number(runtime.compileReserveMi ?? 0)},
    {label: 'Multimodal processor cache', key: 'multimodalReserveMi', value: Number(runtime.multimodalReserveMi ?? 0)},
    {label: 'Quantization working copy', key: 'unpackReserveMi', value: Number(runtime.unpackReserveMi ?? 0)},
    {label: 'Engine runtime reserve', key: 'engineRuntimeReserveMi', value: Number(runtime.engineRuntimeReserveMi ?? 0)},
  ].filter((item) => item.value > 0);
  const explainedRuntimeMi = runtimeParts.reduce((total, item) => total + item.value, 0);
  const otherRuntimeMi = Math.max(0, Number(estimate.reserveMi ?? 0) - explainedRuntimeMi);
  const cards = [
    {label: 'Weights', key: 'weightsMi', value: formatMi(estimate.weightsMi)},
    ...(hasDetailedOllamaCache
      ? [
          {label: 'Attention KV cache', key: 'attentionKvCacheMi', value: formatMi(attentionKvMi)},
          ...(recurrentStateMi > 0 ? [{label: 'Recurrent state cache', key: 'recurrentStateMi', value: formatMi(recurrentStateMi)}] : []),
        ]
      : [{label: hasTheoreticalKv ? 'Theoretical KV cache' : 'Estimated KV cache', key: hasTheoreticalKv ? 'theoreticalKvCacheMi' : 'kvCacheMi', value: formatMi(baseKvMi)}]),
    ...(hybridSafetyMi > 0 ? [{label: 'Hybrid allocator safety', key: 'hybridAllocatorSafetyMi', value: formatMi(hybridSafetyMi)}] : []),
    ...(kvSavingsMi > 0 ? [{label: 'KV cache saving vs F16', key: 'kvCacheSavingsMi', value: formatMi(kvSavingsMi)}] : []),
    ...runtimeParts.map((item) => ({...item, value: formatMi(item.value)})),
    ...(otherRuntimeMi > 0 ? [{label: 'Other runtime reserve', key: 'otherRuntimeMi', value: formatMi(otherRuntimeMi)}] : []),
    ...(Number(estimate.recommendedReserveMi ?? 0) > 0 ? [{label: 'Recommended headroom', key: 'recommendedReserveMi', value: formatMi(estimate.recommendedReserveMi)}] : []),
    {label: 'Download (disk / network)', key: 'downloadBytes', value: formatBytes(estimate.downloadBytes)},
  ];
  const calculations: Record<string, MemoryCalculation> = {...estimate.calculations, otherRuntimeMi: {
    formula: 'total runtime reserve − runtime components itemized above',
    substitution: `${Number(estimate.reserveMi ?? 0)} − ${explainedRuntimeMi} = ${otherRuntimeMi} MiB`,
    notes: ['This is the unitemized remainder, not another reserve added to the total.'],
  }};
  const offloadCards = offloading ? [
    {label: 'Weights · GPU', key: 'weightsOnGpuMi', value: formatMi(offloading.weightsOnGpuMi)},
    {label: 'Weights · RAM', key: 'weightsOnCpuMi', value: formatMi(offloading.weightsOnCpuMi)},
    {label: 'KV budget · GPU', key: 'kvOnGpuMi', value: formatMi(offloading.kvOnGpuMi)},
    {label: 'KV upper bound · RAM', key: 'kvOnCpuMi', value: formatMi(offloading.kvOnCpuMi)},
    {label: 'GPU runtime reserve', key: 'reserveMi', value: formatMi(estimate.reserveMi)},
    {label: 'GPU recommended headroom', key: 'recommendedReserveMi', value: formatMi(estimate.recommendedReserveMi)},
    {label: 'Host runtime reserve', key: 'hostRuntimeMi', value: formatMi(offloading.hostRuntimeMi)},
    {label: 'RAM startup headroom', key: 'ramHeadroomMi', value: formatMi(offloading.ramRecommendedMi - offloading.ramMinimumMi)},
    {label: 'Download (disk / network)', key: 'downloadBytes', value: formatBytes(estimate.downloadBytes)},
  ] : [];
  return <details>
    <summary>Breakdown</summary>
    {budgetDevices > 1 && <p className="muted">GPU estimates below are per GPU. The total VRAM budget covers {budgetDevices} GPUs; host RAM and download size remain separate.</p>}
    <dl className="facts">{(offloading ? offloadCards : cards).map((item) => <div key={item.key}><dt>{item.label}</dt><dd><MemoryInfo label={item.label} value={item.value} calculation={calculations[item.key]} /></dd></div>)}</dl>
    {offloading && <p className="muted">Planning estimates, not measured usage. Host RAM includes offloaded weights and runtime. Ollama uses GPU-first auto-fit; its displayed weight/cache split is proportional and the exact placement is confirmed only after loading. vLLM weight offloading does not offload KV cache.</p>}
    {hybridSafetyMi > 0 && <p className="muted">Configured KV budget: {formatMi(kvBudgetMi)} = {formatMi(baseKvMi)} theoretical cache + {formatMi(hybridSafetyMi)} compatibility safety for the hybrid vLLM allocator.</p>}
    {!offloading && <p className="muted">Minimum includes weights, the complete KV budget, and runtime components. Recommended adds the separate headroom shown above. Download size is not added to memory.</p>}
    {estimate.warnings?.map((warning) => <p className="muted" key={warning}>{warning}</p>)}
  </details>;
};

export const EstimatePanel = ({estimate, availableMi, capacityKnown = true, selectedMi, onSelected, hideBreakdown = false, preserveSelectedMi, budgetDevices = 1}: {estimate?: MemoryEstimate; availableMi: number; capacityKnown?: boolean; selectedMi: number; onSelected: (value: number) => void; hideBreakdown?: boolean; preserveSelectedMi?: number; budgetDevices?: number}) => {
  if (!estimate) return <div className="empty compact-empty">Choose a model reference to calculate memory.</div>;
  const minimum = roundMemory(estimate.minimumMi);
  const recommended = roundMemory(estimate.recommendedMi);
  const maximum = Math.max(0, Math.floor(availableMi / 100) * 100);
  const scaleMaximum = Math.max(100, maximum, minimum, recommended);
  const selectedStep = preserveSelectedMi === selectedMi ? 1 : 100;
  // State, estimates and saved intent remain per device; split-model controls show the group total.
  const total = (value: number) => value * budgetDevices;
  const availablePercent = maximum / scaleMaximum * 100;
  const marker = (value: number) => {
    const percent = Math.min(100, value / scaleMaximum * 100);
    return {left: `${percent}%`, '--marker-label-shift': percent > 85 ? '-100%' : percent < 15 ? '0%' : '-50%'} as CSSProperties;
  };
  return <section className="estimate">
    <header><div><strong>{budgetDevices > 1 ? 'Total VRAM' : estimate.computeTarget === 'cpu' ? 'RAM' : 'VRAM'} reservation</strong><span className="muted">{estimate.confidence ?? 'estimated'} confidence</span></div></header>
    <div className="estimate-metrics"><div><span>Minimum</span><strong><MemoryInfo label="Minimum" value={formatMi(total(minimum))} calculation={estimate.calculations?.minimumMi} roundedMi={estimate.minimumMi} budgetDevices={budgetDevices} /></strong></div><div><span>Recommended</span><strong><MemoryInfo label="Recommended" value={formatMi(total(recommended))} calculation={estimate.calculations?.recommendedMi} roundedMi={estimate.recommendedMi} budgetDevices={budgetDevices} /></strong></div><div><span>100% unreserved</span><strong><MemoryInfo label="100% unreserved" value={capacityKnown ? formatMi(total(maximum)) : 'Unknown'} calculation={unreservedCalculation(capacityKnown ? availableMi : null, budgetDevices)} /></strong></div></div>
    <div className="capacity-scale">
      <div className="capacity-available" style={{width: `${availablePercent}%`}}><input aria-label="Memory reservation" type="range" min={total(100)} max={total(Math.max(100, maximum))} step={total(selectedStep)} disabled={!capacityKnown || maximum < 100} value={total(Math.min(Math.max(100, maximum), Math.max(100, selectedMi)))} onChange={(event) => onSelected(Number(event.target.value) / budgetDevices)} /></div>
      {availablePercent < 100 && <div className="capacity-overflow" style={{left: `${availablePercent}%`}} />}
      <span className="capacity-marker minimum" style={marker(minimum)}><span>Minimum {formatMi(total(minimum))}</span></span>
      <span className="capacity-marker recommended" style={marker(recommended)}><span>Recommended {formatMi(total(recommended))}</span></span>
      <span className="capacity-marker available" style={marker(maximum)}><span>{capacityKnown ? `100% ${formatMi(total(maximum))}` : 'Capacity unknown'}</span></span>
    </div>
    <div className="slider-labels"><span>Selected: {formatMi(total(selectedMi))}</span><span>{!capacityKnown ? 'Capacity unknown' : maximum > 0 ? `${Math.round(selectedMi / maximum * 100)}% of unreserved memory` : `< ${total(100)} MiB unreserved`}</span></div>
    <Field label={budgetDevices > 1 ? 'Total VRAM budget (MiB)' : estimate.computeTarget === 'cpu' ? 'RAM budget (MiB)' : 'VRAM budget (MiB)'}><input type="number" min={total(100)} step={total(selectedStep)} value={total(selectedMi)} onChange={(event) => onSelected(Number(event.target.value) / budgetDevices)} /></Field>
    <div className="button-grid three"><Button type="button" onClick={() => onSelected(capacityKnown && maximum >= 100 ? Math.min(maximum, minimum) : minimum)}>Minimum</Button><Button type="button" variant="primary" onClick={() => onSelected(capacityKnown && maximum >= 100 ? Math.min(maximum, recommended) : recommended)}>Recommended</Button><Button type="button" disabled={!capacityKnown || maximum < 100} onClick={() => onSelected(maximum)}>100%</Button></div>
    {capacityKnown && (minimum > maximum || recommended > maximum) && <div className="notice notice-warn">{minimum > maximum ? 'Minimum and recommended' : 'Recommended'} memory extends into the grey area beyond currently unreserved capacity.</div>}
    {!hideBreakdown && <EstimateBreakdown estimate={estimate} budgetDevices={budgetDevices} />}
  </section>;
};

export const DiscoveryMetadata = ({item}: {item?: DiscoveryItem}) => item ? <div className="tag-list discovery-meta">
  <span className="tag">Publisher: {item.author ?? item.repo.split('/')[0]}</span>
  {item.format && <span className="tag">Format: {item.format}</span>}
  {quantizationText(item.quantization) && <span className="tag">Quantization: {quantizationText(item.quantization)}</span>}
  {item.trustStatus && <span className="tag">Trust: {item.trustStatus}</span>}
  {(item.sizeLabel || item.downloadBytes) && <span className="tag">Download: {item.sizeLabel ?? formatBytes(item.downloadBytes)}</span>}
  {item.revision && <span className="tag">Revision: {item.revision}</span>}
  {item.modelMaxContext && <span className="tag">Model context: {item.modelMaxContext.toLocaleString()}{item.modelContextSource === 'base-model' ? ' · base model' : ''}</span>}
</div> : null;
