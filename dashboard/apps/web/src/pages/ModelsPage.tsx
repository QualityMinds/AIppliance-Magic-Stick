import {useEffect, useMemo, useState, type CSSProperties} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  canAdminister, canMutateRuntime, formatBytes, formatMi, matchingVariants, safeModelName,
  selectedArtifact,
} from '@magicstick/dashboard-core';
import type {
  DiscoveryItem, MemoryCalculation, MemoryEstimate, ModelArtifact, ModelVariant,
  ModelActivation, ModelsPayload, Session,
} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, CopyButton, Dialog, Empty, ErrorNotice, Field, Loading, Panel, ProgressBar, StatusBadge} from '../components';
import {MemoryInfo, unreservedCalculation} from '../MemoryInfo';
import {ComputeMemory} from '../ComputeMemory';
import {slotsFull, targetSlots} from '../GpuSlots';
import {useCpuSettings} from '../CpuSettings';
import {useVllmDeploymentSettings} from '../VllmDeploymentSettings';
import {AdvancedModelSettings} from '../AdvancedModelSettings';
import {RealtimeModelForm} from '../RealtimeModelForm';

const roundMemory = (value: number) => Math.max(100, Math.ceil(value / 100) * 100);
const modelEditRevision = (activation: ModelActivation) => {
  const {uid, generation, resourceVersion} = activation.metadata ?? {};
  return uid && Number.isInteger(generation) && Number(generation) > 0
    ? `generation:${uid}:${generation}`
    : String(resourceVersion ?? '');
};
const parseMemoryMi = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti)?$/i);
  if (!match) return 0;
  const factors: Record<string, number> = {ki: 1 / 1024, mi: 1, gi: 1024, ti: 1024 * 1024};
  return Math.max(0, Math.round(Number(match[1]) * (factors[(match[2] ?? 'Mi').toLowerCase()] ?? 1)));
};
const quantizationText = (value: unknown) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  const item = value as {label?: string; method?: string; bits?: number};
  return item.label ?? [item.method, item.bits ? `${item.bits}-bit` : ''].filter(Boolean).join(' ');
};

const fallbackKvCacheOptions = (engine: string) => engine === 'OLlama'
  ? [{value: 'f16', label: 'Standard - F16', description: 'Highest cache precision.'}]
  : [{value: 'auto', label: 'Standard - model precision', description: 'Uses the model precision selected by vLLM.'}];

const EstimateBreakdown = ({estimate}: {estimate: MemoryEstimate}) => {
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
    <dl className="facts">{(offloading ? offloadCards : cards).map((item) => <div key={item.key}><dt>{item.label}</dt><dd><MemoryInfo label={item.label} value={item.value} calculation={calculations[item.key]} /></dd></div>)}</dl>
    {offloading && <p className="muted">Planning estimates, not measured usage. Host RAM includes offloaded weights and runtime. Ollama uses GPU-first auto-fit; its displayed weight/cache split is proportional and the exact placement is confirmed only after loading. vLLM weight offloading does not offload KV cache.</p>}
    {hybridSafetyMi > 0 && <p className="muted">Configured KV budget: {formatMi(kvBudgetMi)} = {formatMi(baseKvMi)} theoretical cache + {formatMi(hybridSafetyMi)} compatibility safety for the hybrid vLLM allocator.</p>}
    {!offloading && <p className="muted">Minimum includes weights, the complete KV budget, and runtime components. Recommended adds the separate headroom shown above. Download size is not added to memory.</p>}
    {estimate.warnings?.map((warning) => <p className="muted" key={warning}>{warning}</p>)}
  </details>;
};

const EstimatePanel = ({estimate, availableMi, capacityKnown = true, selectedMi, onSelected, hideBreakdown = false, preserveSelectedMi}: {estimate?: MemoryEstimate; availableMi: number; capacityKnown?: boolean; selectedMi: number; onSelected: (value: number) => void; hideBreakdown?: boolean; preserveSelectedMi?: number}) => {
  if (!estimate) return <div className="empty compact-empty">Choose a model reference to calculate memory.</div>;
  const minimum = roundMemory(estimate.minimumMi);
  const recommended = roundMemory(estimate.recommendedMi);
  const maximum = Math.max(0, Math.floor(availableMi / 100) * 100);
  const scaleMaximum = Math.max(100, maximum, minimum, recommended);
  const selectedStep = preserveSelectedMi === selectedMi ? 1 : 100;
  const availablePercent = maximum / scaleMaximum * 100;
  const marker = (value: number) => {
    const percent = Math.min(100, value / scaleMaximum * 100);
    return {left: `${percent}%`, '--marker-label-shift': percent > 85 ? '-100%' : percent < 15 ? '0%' : '-50%'} as CSSProperties;
  };
  return <section className="estimate">
    <header><div><strong>{estimate.computeTarget === 'cpu' ? 'RAM' : 'VRAM'} reservation</strong><span className="muted">{estimate.confidence ?? 'estimated'} confidence</span></div></header>
    <div className="estimate-metrics"><div><span>Minimum</span><strong><MemoryInfo label="Minimum" value={formatMi(minimum)} calculation={estimate.calculations?.minimumMi} roundedMi={estimate.minimumMi} /></strong></div><div><span>Recommended</span><strong><MemoryInfo label="Recommended" value={formatMi(recommended)} calculation={estimate.calculations?.recommendedMi} roundedMi={estimate.recommendedMi} /></strong></div><div><span>100% unreserved</span><strong><MemoryInfo label="100% unreserved" value={capacityKnown ? formatMi(maximum) : 'Unknown'} calculation={unreservedCalculation(capacityKnown ? availableMi : null)} /></strong></div></div>
    <div className="capacity-scale">
      <div className="capacity-available" style={{width: `${availablePercent}%`}}><input aria-label="Memory reservation" type="range" min="100" max={Math.max(100, maximum)} step={selectedStep} disabled={!capacityKnown || maximum < 100} value={Math.min(Math.max(100, maximum), Math.max(100, selectedMi))} onChange={(event) => onSelected(Number(event.target.value))} /></div>
      {availablePercent < 100 && <div className="capacity-overflow" style={{left: `${availablePercent}%`}} />}
      <span className="capacity-marker minimum" style={marker(minimum)}><span>Minimum {formatMi(minimum)}</span></span>
      <span className="capacity-marker recommended" style={marker(recommended)}><span>Recommended {formatMi(recommended)}</span></span>
      <span className="capacity-marker available" style={marker(maximum)}><span>{capacityKnown ? `100% ${formatMi(maximum)}` : 'Capacity unknown'}</span></span>
    </div>
    <div className="slider-labels"><span>Selected: {formatMi(selectedMi)}</span><span>{!capacityKnown ? 'Capacity unknown' : maximum > 0 ? `${Math.round(selectedMi / maximum * 100)}% of unreserved memory` : '< 100 MiB unreserved'}</span></div>
    <Field label={estimate.computeTarget === 'cpu' ? 'RAM budget (MiB)' : 'VRAM budget (MiB)'}><input type="number" min="100" step={selectedStep} value={selectedMi} onChange={(event) => onSelected(Number(event.target.value))} /></Field>
    <div className="button-grid three"><Button type="button" onClick={() => onSelected(capacityKnown && maximum >= 100 ? Math.min(maximum, minimum) : minimum)}>Minimum</Button><Button type="button" variant="primary" onClick={() => onSelected(capacityKnown && maximum >= 100 ? Math.min(maximum, recommended) : recommended)}>Recommended</Button><Button type="button" disabled={!capacityKnown || maximum < 100} onClick={() => onSelected(maximum)}>100%</Button></div>
    {capacityKnown && (minimum > maximum || recommended > maximum) && <div className="notice notice-warn">{minimum > maximum ? 'Minimum and recommended' : 'Recommended'} memory extends into the grey area beyond currently unreserved capacity.</div>}
    {!hideBreakdown && <EstimateBreakdown estimate={estimate} />}
  </section>;
};

const DiscoveryMetadata = ({item}: {item?: DiscoveryItem}) => item ? <div className="tag-list discovery-meta">
  <span className="tag">Publisher: {item.author ?? item.repo.split('/')[0]}</span>
  {item.format && <span className="tag">Format: {item.format}</span>}
  {quantizationText(item.quantization) && <span className="tag">Quantization: {quantizationText(item.quantization)}</span>}
  {item.trustStatus && <span className="tag">Trust: {item.trustStatus}</span>}
  {(item.sizeLabel || item.downloadBytes) && <span className="tag">Download: {item.sizeLabel ?? formatBytes(item.downloadBytes)}</span>}
  {item.modelMaxContext && <span className="tag">Model context: {item.modelMaxContext.toLocaleString()}{item.modelContextSource === 'base-model' ? ' · base model' : ''}</span>}
</div> : null;

type FreeTokenMemoryStrategy = 'auto' | 'offload' | 'cpu' | 'hybrid' | 'fused';
type ModelLifecycleAction = 'start' | 'stop' | 'restart';
const freeTokenMinimumMemoryMi = 256;

interface FreeTokenSettingsValue {
  gpuDevice: string;
  gpuCount: number;
  gpuMemoryMi: number;
  systemMemoryMi: number;
  memoryStrategy: FreeTokenMemoryStrategy;
  advanced: {
    contextWindow: number;
    maxNumSeqs: number;
    maxOutputTokens: number | null;
    cacheType: 'radix' | 'naive' | string;
    kvReserveTokens: number | null;
    cpuThreads: number | null;
    cudaGraphMaxBatchSize: number | null;
    moeCacheSize: number | null;
    maxPrefillLength: number | null;
    expertLoad: string | null;
    dtype: string | null;
  };
}

const isFreeTokenEngine = (engine: string) => engine.trim().toLowerCase() === 'freetoken';
const freeTokenNodeName = (value: unknown) => {
  const node = String(value ?? '').trim();
  return node.startsWith('node:') ? node.slice('node:'.length) : node;
};
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const boundedInteger = (value: unknown, fallback: number, minimum = 1) => {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= minimum ? numeric : fallback;
};
const optionalInteger = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
};
const optionalNonnegativeInteger = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
};
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const freeTokenMinimumMi = (value: unknown) => Math.max(
  freeTokenMinimumMemoryMi,
  boundedInteger(value, freeTokenMinimumMemoryMi, freeTokenMinimumMemoryMi),
);
const positiveCapacity = (...values: Array<number | null | undefined>) => values.find((value) => typeof value === 'number' && Number.isFinite(value) && value > 0) ?? 0;
const smallestPositiveCapacity = (values: Array<number | null | undefined>) => {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  return known.length ? Math.min(...known) : 0;
};
const safeAvailableCapacity = (...values: Array<number | null | undefined>) => {
  // An explicit zero is a real measurement, not a missing value.  In that
  // case the runtime must not fall back to physical capacity and overcommit.
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return known.length ? Math.max(0, Math.floor(Math.min(...known))) : 0;
};
// FreeToken pins a model server to one GPU node. Its RAM controls must never
// inherit a cluster-wide CPU total when that node's live memory sample is
// absent; unknown node capacity is deliberately not configurable.
const freeTokenNodeAvailableMemoryMi = (value: number | null | undefined) => (
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
);
const freeTokenStrategyLabels: Record<FreeTokenMemoryStrategy, string> = {
  auto: 'Auto',
  offload: 'GPU cache + streaming',
  cpu: 'CPU execution',
  hybrid: 'Hybrid GPU + CPU',
  fused: 'GPU-resident experts',
};

const emptyFreeTokenSettings = (contextWindow = 4096, maxNumSeqs = 1): FreeTokenSettingsValue => ({
  gpuDevice: '', gpuCount: 1, gpuMemoryMi: 0, systemMemoryMi: 0, memoryStrategy: 'auto',
  advanced: {contextWindow, maxNumSeqs, maxOutputTokens: null, cacheType: 'radix', kvReserveTokens: null, cpuThreads: null,
    cudaGraphMaxBatchSize: null, moeCacheSize: null, maxPrefillLength: null, expertLoad: null, dtype: null},
});

const freeTokenSettingsFrom = (value: unknown, contextWindow = 4096, maxNumSeqs = 1): FreeTokenSettingsValue => {
  const raw = asRecord(value); const advanced = asRecord(raw.advanced);
  const memoryStrategy = String(raw.memoryStrategy ?? 'auto') as FreeTokenMemoryStrategy;
  return {
    gpuDevice: String(raw.gpuDevice ?? ''),
    gpuCount: boundedInteger(raw.gpuCount, 1),
    gpuMemoryMi: Math.max(0, parseMemoryMi(raw.gpuMemoryMi)),
    systemMemoryMi: Math.max(0, parseMemoryMi(raw.systemMemoryMi)),
    memoryStrategy: Object.hasOwn(freeTokenStrategyLabels, memoryStrategy) ? memoryStrategy : 'auto',
    advanced: {
      contextWindow: boundedInteger(advanced.contextWindow ?? raw.contextWindow, contextWindow),
      maxNumSeqs: boundedInteger(advanced.maxNumSeqs ?? raw.maxNumSeqs, maxNumSeqs),
      maxOutputTokens: optionalInteger(advanced.maxOutputTokens ?? raw.maxOutputTokens),
      cacheType: String(advanced.cacheType ?? raw.cacheType ?? 'radix'),
      kvReserveTokens: optionalInteger(advanced.kvReserveTokens ?? raw.kvReserveTokens),
      cpuThreads: optionalInteger(advanced.cpuThreads ?? raw.cpuThreads),
      cudaGraphMaxBatchSize: optionalInteger(advanced.cudaGraphMaxBatchSize ?? raw.cudaGraphMaxBatchSize),
      moeCacheSize: optionalNonnegativeInteger(advanced.moeCacheSize ?? raw.moeCacheSize),
      maxPrefillLength: optionalInteger(advanced.maxPrefillLength ?? raw.maxPrefillLength),
      expertLoad: advanced.expertLoad === null || advanced.expertLoad === undefined || advanced.expertLoad === '' ? null : String(advanced.expertLoad),
      dtype: advanced.dtype === null || advanced.dtype === undefined || advanced.dtype === '' ? null : String(advanced.dtype),
    },
  };
};

const freeTokenPayload = (value: FreeTokenSettingsValue, models: ModelsPayload) => {
  const advertised = asRecord(models.computeTargets.freeTokenCapabilities?.advanced);
  const cacheTypes = Array.isArray(advertised.cacheType)
    ? advertised.cacheType
    : models.computeTargets.freeTokenCapabilities?.cacheTypes ?? [];
  const advanced: Record<string, unknown> = {};
  if (cacheTypes.some((cacheType) => cacheType === value.advanced.cacheType)) {
    advanced.cacheType = value.advanced.cacheType;
  }
  for (const key of ['kvReserveTokens', 'cpuThreads'] as const) {
    if (advertised[key] === true && value.advanced[key] !== null) advanced[key] = value.advanced[key];
  }
  for (const key of ['cudaGraphMaxBatchSize', 'moeCacheSize', 'maxPrefillLength'] as const) {
    if (advertised[key] && value.advanced[key] !== null) advanced[key] = value.advanced[key];
  }
  for (const key of ['expertLoad', 'dtype'] as const) {
    if (advertised[key] && value.advanced[key]) advanced[key] = value.advanced[key];
  }
  return {...value, advanced};
};

const freeTokenDeviceOptions = (models: ModelsPayload, computeTarget: string, replacement?: FreeTokenSettingsValue, gpuCount = replacement?.gpuCount) => {
  const capability = models.computeTargets.freeTokenCapabilities;
  const catalogDevices = [...(capability?.devices ?? []), ...(capability?.unavailableDevices ?? [])];
  const catalogById = new Map(catalogDevices.map((device) => [device.id, device]));
  const physicalDevices = models.computeMemory?.devices?.filter((device) => device.kind === 'gpu'
    && (device.computeTarget === computeTarget || device.id === computeTarget)) ?? [];
  const catalogIds = catalogDevices.filter((device) => !device.computeTarget || device.computeTarget === computeTarget).map((device) => device.id);
  // When the server supplies capability inventory, it is authoritative. This
  // avoids presenting raw GPU UUIDs as a selectable scheduling mechanism.
  const ids = new Set(catalogIds.length ? catalogIds : physicalDevices.map((device) => device.id));
  return [...ids].map((id) => {
    const catalog = catalogById.get(id);
    const node = catalog?.node ?? (id.startsWith('node:') ? id.slice('node:'.length) : undefined);
    const nodeDevices = physicalDevices.filter((item) => Boolean(node && item.nodes?.includes(node)));
    const device = nodeDevices.find((item) => item.id === id || item.freeToken?.id === id) ?? nodeDevices[0];
    const supported = catalog?.supported ?? device?.freeToken?.supported ?? false;
    const replacingNode = replacement?.gpuDevice === id;
    const retainedGpuMi = replacingNode && replacement.gpuCount === gpuCount
      ? Math.floor(replacement.gpuMemoryMi / replacement.gpuCount) : 0;
    const availableGpuMi = (item: typeof physicalDevices[number]) => safeAvailableCapacity(
      typeof item.unreservedMi === 'number' ? item.unreservedMi + retainedGpuMi : item.unreservedMi,
      typeof item.freeMi === 'number' ? Math.max(item.freeMi, retainedGpuMi) : item.freeMi,
      item.totalMi,
    );
    return {
      id,
      name: catalog?.name ?? device?.name ?? id,
      node,
      supported,
      reason: catalog?.reason ?? device?.freeToken?.reason ?? capability?.message ?? 'This GPU is not supported by the selected FreeToken runtime.',
      // A multi-GPU allocation is made by Kubernetes, not by a raw UUID. Use
      // the smallest physical/available card on the selected node so one
      // per-GPU FreeToken limit is valid for every card that may be assigned.
      totalMi: nodeDevices.length
        ? smallestPositiveCapacity(nodeDevices.map((item) => positiveCapacity(item.totalMi)))
        : positiveCapacity(device?.totalMi, catalog?.totalMi),
      // The physical/DCGM device is the source for VRAM. Capability inventory
      // only supplies a fallback when that device is not reported yet.
      availableMi: nodeDevices.length
        ? Math.min(...nodeDevices.map(availableGpuMi))
        : device
        ? availableGpuMi(device)
        : safeAvailableCapacity(catalog?.unreservedMi, catalog?.freeMi, catalog?.totalMi),
      gpuCount: boundedInteger(catalog?.gpuCount, Math.max(1, nodeDevices.length || 1)),
      maxGpuCount: Math.max(1, Math.min(
        boundedInteger(catalog?.maxGpuCount ?? catalog?.gpuCount, Math.max(1, nodeDevices.length || 1)),
        nodeDevices.length || boundedInteger(catalog?.gpuCount, 1),
      )),
      systemMemoryMi: catalog?.systemMemoryMi,
      systemAvailableMi: replacingNode && typeof catalog?.systemAvailableMi === 'number'
        ? Math.min(catalog.systemMemoryMi ?? catalog.systemAvailableMi, Math.max(catalog.systemAvailableMi, replacement.systemMemoryMi))
        : catalog?.systemAvailableMi,
    };
  });
};

const FreeTokenSettingsPanel = ({models, computeTarget, value, onChange, replacement}: {
  models: ModelsPayload;
  computeTarget: string;
  value: FreeTokenSettingsValue;
  onChange: (value: FreeTokenSettingsValue) => void;
  replacement?: FreeTokenSettingsValue;
}) => {
  const capability = models.computeTargets.freeTokenCapabilities;
  const devices = freeTokenDeviceOptions(models, computeTarget, replacement, value.gpuCount);
  const capacityLabel = replacement ? 'available on restart' : 'currently available';
  const supportedDevices = devices.filter((device) => device.supported);
  const selectedDevice = devices.find((device) => device.id === value.gpuDevice) ?? supportedDevices[0];
  const gpuMaximumPerDeviceMi = Math.floor(selectedDevice?.availableMi ?? 0);
  const gpuPhysicalPerDeviceMi = selectedDevice?.totalMi ?? 0;
  const maximumGpuCount = Math.max(1, selectedDevice?.maxGpuCount ?? selectedDevice?.gpuCount ?? 1);
  const selectedGpuCount = clamp(boundedInteger(value.gpuCount, 1), 1, maximumGpuCount);
  const gpuMinimumPerDeviceMi = freeTokenMinimumMi(capability?.minimumGpuMemoryMi);
  const gpuMinimumMi = gpuMinimumPerDeviceMi * selectedGpuCount;
  const gpuMaximumMi = gpuMaximumPerDeviceMi * selectedGpuCount;
  const gpuPhysicalMi = gpuPhysicalPerDeviceMi * selectedGpuCount;
  const systemRequiredMinimumMi = freeTokenMinimumMi(capability?.minimumSystemMemoryMi);
  const systemTotalMi = positiveCapacity(selectedDevice?.systemMemoryMi);
  const systemMaximumMi = freeTokenNodeAvailableMemoryMi(selectedDevice?.systemAvailableMi);
  const gpuCapacitySatisfiesMinimum = gpuMaximumPerDeviceMi >= gpuMinimumPerDeviceMi;
  const systemCapacitySatisfiesMinimum = systemMaximumMi >= systemRequiredMinimumMi;
  const defaultRatio = clamp(Number(capability?.defaultMemoryRatio ?? 0.9), 0.01, 1);
  // Keep the first-render value aligned with the server-side auto policy:
  // a quarter of this node's installed RAM, bounded to 8–32 GiB.  It must
  // never use the cluster-wide CPU aggregate or exceed live node capacity.
  const automaticSystemMi = Math.min(32768, Math.max(8192, Math.floor((systemTotalMi || systemMaximumMi) / 4)));
  const defaultSystemMi = systemCapacitySatisfiesMinimum
    ? clamp(automaticSystemMi, systemRequiredMinimumMi, systemMaximumMi)
    : 0;
  const advertisedStrategies = capability?.memoryStrategies?.filter((strategy): strategy is FreeTokenMemoryStrategy => Object.hasOwn(freeTokenStrategyLabels, strategy)) ?? [];
  const memoryStrategies: FreeTokenMemoryStrategy[] = advertisedStrategies.length ? advertisedStrategies : ['auto'];
  const advancedCapabilities = asRecord(capability?.advanced);
  const cacheTypes = Array.isArray(advancedCapabilities.cacheType) ? advancedCapabilities.cacheType.filter((item): item is string => typeof item === 'string' && Boolean(item)) : capability?.cacheTypes ?? [];
  const optionValues = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item)) : [];
  const expertLoadOptions = optionValues(advancedCapabilities.expertLoad);
  const dtypeOptions = optionValues(advancedCapabilities.dtype).length
    ? optionValues(advancedCapabilities.dtype)
    : optionValues(capability?.supportedPrecisionModes);
  const freeTokenAvailable = capability?.available !== false && supportedDevices.length > 0;

  useEffect(() => {
    const nextDevice = supportedDevices.find((device) => device.id === value.gpuDevice) ?? supportedDevices[0];
    const nextGpuCount = clamp(boundedInteger(value.gpuCount, 1), 1, Math.max(1, nextDevice?.maxGpuCount ?? nextDevice?.gpuCount ?? 1));
    const nextGpuMaximum = Math.floor(nextDevice?.availableMi ?? 0) * nextGpuCount;
    const nextGpuMinimum = gpuMinimumPerDeviceMi * nextGpuCount;
    const nextGpu = nextGpuMaximum >= nextGpuMinimum
      ? clamp(value.gpuMemoryMi || Math.max(nextGpuMinimum, Math.floor(nextGpuMaximum * defaultRatio)), nextGpuMinimum, nextGpuMaximum)
      : 0;
    const nextSystem = systemMaximumMi >= systemRequiredMinimumMi
      ? clamp(value.systemMemoryMi || defaultSystemMi, systemRequiredMinimumMi, systemMaximumMi)
      : 0;
    const nextStrategy = memoryStrategies.includes(value.memoryStrategy) ? value.memoryStrategy : 'auto';
    if ((nextDevice?.id ?? '') !== value.gpuDevice || nextGpu !== value.gpuMemoryMi || nextSystem !== value.systemMemoryMi
      || nextGpuCount !== value.gpuCount || nextStrategy !== value.memoryStrategy) {
      onChange({...value, gpuDevice: nextDevice?.id ?? '', gpuCount: nextGpuCount, gpuMemoryMi: nextGpu, systemMemoryMi: nextSystem,
        memoryStrategy: nextStrategy});
    }
  }, [computeTarget, defaultRatio, defaultSystemMi, gpuMinimumPerDeviceMi, memoryStrategies, onChange, supportedDevices, systemMaximumMi, systemRequiredMinimumMi, value]);

  const updateAdvanced = (advanced: Partial<FreeTokenSettingsValue['advanced']>) => onChange({...value, advanced: {...value.advanced, ...advanced}});
  return <Panel title="FreeToken" className="nested-panel">
    <div className="stack compact">
      <div className="form-grid">
        {supportedDevices.length > 1 ? <Field label="GPU node"><select value={value.gpuDevice} onChange={(event) => onChange({...value, gpuDevice: event.target.value})}>
          {supportedDevices.map((device) => <option key={device.id} value={device.id}>{device.node ? `${device.node} · ` : ''}{device.name}</option>)}
        </select></Field> : <div className="field" aria-label="FreeToken GPU allocation"><span>GPU allocation</span><strong>{selectedDevice?.supported ? `${selectedDevice.node ? `${selectedDevice.node} · ` : ''}${selectedDevice.name}` : 'No eligible GPU'}</strong></div>}
        <Field label="GPUs on node"><select aria-label="FreeToken GPU count" value={selectedGpuCount} disabled={!freeTokenAvailable || maximumGpuCount < 2} onChange={(event) => onChange({...value, gpuCount: Number(event.target.value)})}>
          {Array.from({length: maximumGpuCount}, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count} {count === 1 ? 'GPU' : 'GPUs'}</option>)}
        </select></Field>
        <Field label="Memory strategy"><select value={value.memoryStrategy} onChange={(event) => onChange({...value, memoryStrategy: event.target.value as FreeTokenMemoryStrategy})} disabled={!freeTokenAvailable}>
          {memoryStrategies.map((strategy) => <option value={strategy} key={strategy}>{freeTokenStrategyLabels[strategy]}</option>)}
        </select></Field>
      </div>
      {!freeTokenAvailable && <div className="notice notice-warn" role="status">{capability?.message ?? 'No GPU supported by the installed FreeToken runtime is available on this target.'}</div>}
      {freeTokenAvailable && (!gpuCapacitySatisfiesMinimum || !systemCapacitySatisfiesMinimum) && <div className="notice notice-warn" role="status">{!gpuCapacitySatisfiesMinimum
        ? `FreeToken requires at least ${formatMi(gpuMinimumPerDeviceMi)} currently available GPU memory on every selected GPU.`
        : `FreeToken requires at least ${formatMi(systemRequiredMinimumMi)} currently available system RAM on the selected node.`}</div>}
      {devices.some((device) => !device.supported) && <div className="tag-list">{devices.filter((device) => !device.supported).map((device) => <span className="tag" key={device.id} title={device.reason}>{device.node ? `${device.node} · ` : ''}{device.name} · unavailable</span>)}</div>}
      <section className="estimate stack compact">
        <header><strong>GPU memory</strong><span className="muted">{gpuPhysicalMi ? `${formatMi(gpuPhysicalMi)} physical · ` : ''}{gpuMaximumMi ? `${formatMi(gpuMaximumMi)} ${capacityLabel}` : 'Capacity unavailable'}</span></header>
        <input aria-label="FreeToken GPU memory" type="range" min={gpuCapacitySatisfiesMinimum ? gpuMinimumMi : 0} max={gpuCapacitySatisfiesMinimum ? gpuMaximumMi : 0} step="1" disabled={!freeTokenAvailable || !gpuCapacitySatisfiesMinimum} value={gpuCapacitySatisfiesMinimum ? clamp(value.gpuMemoryMi, gpuMinimumMi, gpuMaximumMi) : 0} onChange={(event) => {
          const gpuMemoryMi = Number(event.target.value);
          onChange({...value, gpuMemoryMi});
        }} />
        <div className="slider-labels"><span>FreeToken total limit: {value.gpuMemoryMi ? formatMi(value.gpuMemoryMi) : '—'}</span><span>{gpuMaximumMi ? `${Math.round(value.gpuMemoryMi / gpuMaximumMi * 100)}% of ${capacityLabel} VRAM` : '—'}</span></div>
        <Field label="GPU memory limit total (MiB)"><input type="number" min={gpuMinimumMi} max={gpuMaximumMi || undefined} step="1" value={gpuCapacitySatisfiesMinimum ? value.gpuMemoryMi || '' : ''} disabled={!freeTokenAvailable || !gpuCapacitySatisfiesMinimum} onChange={(event) => {
          const gpuMemoryMi = Number(event.target.value);
          onChange({...value, gpuMemoryMi: gpuCapacitySatisfiesMinimum ? clamp(gpuMemoryMi, gpuMinimumMi, gpuMaximumMi) : gpuMemoryMi});
        }} /></Field>
      </section>
      <section className="estimate stack compact">
        <header><strong>System RAM</strong><span className="muted">{systemTotalMi ? `${formatMi(systemTotalMi)} installed · ` : ''}{systemMaximumMi ? `${formatMi(systemMaximumMi)} ${capacityLabel}` : 'Capacity unavailable'}</span></header>
        <input aria-label="FreeToken system RAM" type="range" min={systemCapacitySatisfiesMinimum ? systemRequiredMinimumMi : 0} max={systemCapacitySatisfiesMinimum ? systemMaximumMi : 0} step="1" disabled={!freeTokenAvailable || !systemCapacitySatisfiesMinimum} value={systemCapacitySatisfiesMinimum ? clamp(value.systemMemoryMi, systemRequiredMinimumMi, systemMaximumMi) : 0} onChange={(event) => onChange({...value, systemMemoryMi: Number(event.target.value)})} />
        <div className="slider-labels"><span>Pod RAM reservation: {value.systemMemoryMi ? formatMi(value.systemMemoryMi) : '—'}</span><span>{systemMaximumMi ? `${Math.round(value.systemMemoryMi / systemMaximumMi * 100)}% of available RAM` : '—'}</span></div>
        <Field label="System RAM reservation (MiB)"><input type="number" min={systemRequiredMinimumMi} max={systemMaximumMi || undefined} step="1" value={systemCapacitySatisfiesMinimum ? value.systemMemoryMi || '' : ''} disabled={!freeTokenAvailable || !systemCapacitySatisfiesMinimum} onChange={(event) => onChange({...value, systemMemoryMi: systemCapacitySatisfiesMinimum ? clamp(Number(event.target.value), systemRequiredMinimumMi, systemMaximumMi) : Number(event.target.value)})} /></Field>
      </section>
      <details>
        <summary><strong>Advanced Settings</strong></summary>
        <div className="form-grid stack compact">
          <Field label="Context length"><input type="number" min="1" value={value.advanced.contextWindow} onChange={(event) => updateAdvanced({contextWindow: Number(event.target.value)})} /></Field>
          <Field label="Maximum running requests"><input type="number" min="1" value={value.advanced.maxNumSeqs} onChange={(event) => updateAdvanced({maxNumSeqs: Number(event.target.value)})} /></Field>
          <Field label="Maximum output tokens"><input type="number" min="1" value={value.advanced.maxOutputTokens ?? ''} placeholder="Runtime default" onChange={(event) => updateAdvanced({maxOutputTokens: optionalInteger(event.target.value)})} /></Field>
          {cacheTypes.length > 0 && <Field label="Cache type"><select value={value.advanced.cacheType} onChange={(event) => updateAdvanced({cacheType: event.target.value})}>{cacheTypes.map((cacheType) => <option key={cacheType} value={cacheType}>{cacheType}</option>)}</select></Field>}
          {advancedCapabilities.kvReserveTokens === true && <Field label="KV reserve tokens"><input type="number" min="1" value={value.advanced.kvReserveTokens ?? ''} placeholder="Runtime default" onChange={(event) => updateAdvanced({kvReserveTokens: optionalInteger(event.target.value)})} /></Field>}
          {advancedCapabilities.cpuThreads === true && <Field label="MoE CPU threads"><input type="number" min="1" value={value.advanced.cpuThreads ?? ''} placeholder="Runtime default" onChange={(event) => updateAdvanced({cpuThreads: optionalInteger(event.target.value)})} /></Field>}
          {advancedCapabilities.cudaGraphMaxBatchSize === true && <Field label="CUDA graph maximum batch size"><input type="number" min="1" value={value.advanced.cudaGraphMaxBatchSize ?? ''} placeholder="Runtime default" onChange={(event) => updateAdvanced({cudaGraphMaxBatchSize: optionalInteger(event.target.value)})} /></Field>}
          {advancedCapabilities.moeCacheSize === true && <Field label="MoE cache size"><input type="number" min="0" value={value.advanced.moeCacheSize ?? ''} placeholder="Runtime default" onChange={(event) => updateAdvanced({moeCacheSize: optionalNonnegativeInteger(event.target.value)})} /></Field>}
          {advancedCapabilities.maxPrefillLength === true && <Field label="Maximum prefill length"><input type="number" min="1" value={value.advanced.maxPrefillLength ?? ''} placeholder="Runtime default" onChange={(event) => updateAdvanced({maxPrefillLength: optionalInteger(event.target.value)})} /></Field>}
          {Boolean(advancedCapabilities.expertLoad) && <Field label="Expert load"><select value={value.advanced.expertLoad ?? ''} onChange={(event) => updateAdvanced({expertLoad: event.target.value || null})}><option value="">Runtime default</option>{expertLoadOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></Field>}
          {Boolean(advancedCapabilities.dtype) && <Field label="Precision"><select value={value.advanced.dtype ?? ''} onChange={(event) => updateAdvanced({dtype: event.target.value || null})}><option value="">Runtime default</option>{dtypeOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></Field>}
        </div>
      </details>
    </div>
  </Panel>;
};

const LocalModelForm = ({models, onClose, onCreated}: {models: ModelsPayload; onClose: () => void; onCreated: () => Promise<void>}) => {
  const availableTargets = models.computeTargets.targets.filter((target) => target.available);
  const hasRealtime = Object.keys(models.computeTargets.engineCatalog?.VLLM?.realtimeProfiles ?? {}).length > 0;
  const experimentalEngines = new Set(['FreeToken', 'VLLM-Omni']);
  const engineDisplayName = (engine: string) => engine === 'VLLM-Omni' ? 'vLLM-Omni' : models.computeTargets.engineCatalog?.[engine]?.displayName ?? engine;
  const engineOptions = [...new Set([
    ...Object.keys(models.computeTargets.engineCatalog ?? {}),
    ...availableTargets.flatMap((target) => target.declaredEngines ?? target.engines ?? []),
  ])].flatMap((engine) => engine === 'VLLM' && hasRealtime ? [engine, 'VLLM-Omni'] : [engine])
    .sort((a, b) => Number(experimentalEngines.has(a)) - Number(experimentalEngines.has(b))
      || engineDisplayName(a).localeCompare(engineDisplayName(b), 'en', {sensitivity: 'base'}));
  const [selectedEngine, setEngine] = useState(engineOptions[0] ?? 'VLLM');
  const engine = engineOptions.includes(selectedEngine) ? selectedEngine : engineOptions[0] ?? 'VLLM';
  return <>
    <Field label="Inference Engine"><select value={engine} onChange={(event) => setEngine(event.target.value)}>{engineOptions.map((item) => <option key={item} value={item}>{experimentalEngines.has(item) ? '(Experimental) ' : ''}{engineDisplayName(item)}</option>)}</select></Field>
    {engine === 'VLLM-Omni'
      ? <RealtimeModelForm models={models} onClose={onClose} onSaved={onCreated} />
      : <StandardLocalModelForm models={models} engine={engine} onClose={onClose} onCreated={onCreated} />}
  </>;
};

const StandardLocalModelForm = ({models, engine, onClose, onCreated}: {models: ModelsPayload; engine: string; onClose: () => void; onCreated: () => Promise<void>}) => {
  const availableTargets = models.computeTargets.targets.filter((target) => target.available);
  const targetSupportsEngine = (target: typeof availableTargets[number], candidate: string) => (target.engines ?? []).includes(candidate)
    || (target.declaredEngines ?? []).includes(candidate)
    || Boolean(target.engineAvailability?.[candidate]);
  const targetEngineAvailable = (target: typeof availableTargets[number] | undefined, candidate: string) => Boolean(target)
    && (target?.engineAvailability?.[candidate]?.available ?? target?.engines?.includes(candidate) ?? false);
  const targets = availableTargets.filter((target) => targetSupportsEngine(target, engine));
  const [computeTarget, setComputeTarget] = useState(targets.find((target) => targetEngineAvailable(target, engine) && !slotsFull(target, engine))?.id ?? '');
  const selectedTarget = availableTargets.find((target) => target.id === computeTarget);
  const cpuSettings = useCpuSettings(undefined, models, engine, computeTarget);
  const deploymentSettings = useVllmDeploymentSettings(undefined, models, engine, computeTarget);
  const noSlots = slotsFull(selectedTarget, engine);
  const engineUnavailable = !targetEngineAvailable(selectedTarget, engine);
  const isFreeToken = isFreeTokenEngine(engine);
  const kvCacheOptions = useMemo(
    () => selectedTarget?.kvCacheTypes?.[engine] ?? fallbackKvCacheOptions(engine),
    [engine, selectedTarget],
  );
  const [kvCacheType, setKvCacheType] = useState(kvCacheOptions[0]?.value ?? (engine === 'OLlama' ? 'f16' : 'auto'));
  const provider = engine === 'OLlama' ? 'ollama' : 'huggingface';
  const [source, setSource] = useState<'search' | 'preset' | 'direct'>('search');
  const [name, setName] = useState(''); const [modelType, setModelType] = useState('chat');
  const [contextWindow, setContextWindow] = useState(4096); const [maxNumSeqs, setMaxNumSeqs] = useState(1);
  const [url, setUrl] = useState(''); const [presetId, setPresetId] = useState(''); const [artifactId, setArtifactId] = useState('');
  const [search, setSearch] = useState('Qwen'); const [popular, setPopular] = useState<DiscoveryItem[]>([]);
  const [searchResults, setSearchResults] = useState<DiscoveryItem[]>([]); const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [searchModel, setSearchModel] = useState(''); const [artifacts, setArtifacts] = useState<DiscoveryItem[]>([]);
  const [artifactCursor, setArtifactCursor] = useState<string | null>(null); const [selectedSearchArtifact, setSelectedSearchArtifact] = useState('');
  const [artifactBaseModel, setArtifactBaseModel] = useState<DiscoveryItem>();
  const [estimate, setEstimate] = useState<MemoryEstimate>(); const [selectedMi, setSelectedMi] = useState(100);
  const [cpuOffloading, setCpuOffloading] = useState(false);
  const [offloadEstimate, setOffloadEstimate] = useState<MemoryEstimate>();
  const [hostMemoryMi, setHostMemoryMi] = useState(100);
  const [hostMemoryEdited, setHostMemoryEdited] = useState(false);
  const [offloadError, setOffloadError] = useState<unknown>(null);
  const [formError, setFormError] = useState<unknown>(null); const [searching, setSearching] = useState(false); const [loadingArtifacts, setLoadingArtifacts] = useState(false);
  const [freeToken, setFreeToken] = useState<FreeTokenSettingsValue>(() => emptyFreeTokenSettings());

  useEffect(() => {
    const declaredTargets = availableTargets.filter((target) => targetSupportsEngine(target, engine));
    if (!declaredTargets.some((target) => target.id === computeTarget && targetEngineAvailable(target, engine) && !slotsFull(target, engine))) {
      setComputeTarget(declaredTargets.find((target) => targetEngineAvailable(target, engine) && !slotsFull(target, engine))?.id ?? '');
    }
    setUrl(''); setPresetId(''); setArtifactId(''); setSearchResults([]); setArtifacts([]); setEstimate(undefined);
  }, [engine]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!kvCacheOptions.some((option) => option.value === kvCacheType)) {
      setKvCacheType(kvCacheOptions[0]?.value ?? (engine === 'OLlama' ? 'f16' : 'auto'));
    }
  }, [computeTarget, engine, kvCacheOptions, kvCacheType]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({provider, engine, computeTarget, modelType, limit: '8'});
    api.popularModels(params).then((result) => { if (!cancelled) setPopular(result.results); }).catch(() => { if (!cancelled) setPopular([]); });
    return () => { cancelled = true; };
  }, [provider, engine, computeTarget, modelType]);

  const presets = useMemo(() => Object.entries(models.presets).flatMap(([id, preset]) => matchingVariants(preset.variants, engine, computeTarget).map((variant) => ({id, label: preset.displayName ?? id, variant}))), [computeTarget, engine, models.presets]);
  const selectedPreset = presets.find((item) => item.id === presetId);
  const selectedPresetArtifact = selectedArtifact(selectedPreset?.variant, artifactId);
  const selectedSearchModel = searchResults.find((item) => item.repo === searchModel);
  const targetDevices = models.computeMemory?.devices?.filter((device) => device.computeTarget === computeTarget || device.id === computeTarget) ?? [];
  const capacities = [...targetDevices.map((device) => device.unreservedMi), estimate?.maximumMi].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const capacityKnown = capacities.length > 0;
  const availableMi = capacityKnown ? Math.max(...capacities) : 0;
  const selectedDiscoveryArtifact = artifacts.find((item) => item.id === selectedSearchArtifact);
  const supportsOffloading = !isFreeToken && computeTarget === 'nvidia-gpu';
  const offload = supportsOffloading && cpuOffloading ? offloadEstimate?.offloading : undefined;
  const hostMaximum = Math.max(0, Math.floor((offload?.ramMaximumMi ?? 0) / 100) * 100);
  const activeEstimate = cpuOffloading ? offloadEstimate : estimate;
  const memoryRisks = !isFreeToken && activeEstimate ? [
    ...(activeEstimate.confidence !== 'high' ? ['Memory requirements are estimated and may differ at runtime.'] : []),
    ...(selectedMi < roundMemory(activeEstimate.minimumMi) ? ['The selected memory is below the estimated minimum.'] : []),
    ...(capacityKnown && selectedMi > availableMi ? ['The selected memory exceeds currently unreserved capacity.'] : []),
    ...(!capacityKnown ? ['Unreserved device capacity could not be verified.'] : []),
    ...(cpuOffloading && (!offload || !offload.fitsVram) ? ['The offloading plan may not fit the selected VRAM budget.'] : []),
    ...(cpuOffloading && offload?.ramMaximumMi === null ? ['Unreserved host RAM could not be verified.'] : []),
    ...(offload && hostMemoryMi < offload.ramMinimumMi ? ['Host RAM is below the estimated offloading minimum.'] : []),
    ...(offload && offload.ramMaximumMi !== null && hostMemoryMi > hostMaximum ? ['Host RAM exceeds currently unreserved capacity.'] : []),
  ] : [];
  const hasMemoryRisk = memoryRisks.length > 0;
  const selectedFreeTokenDevice = freeTokenDeviceOptions(models, computeTarget).find((device) => device.id === freeToken.gpuDevice);
  const freeTokenCapability = models.computeTargets.freeTokenCapabilities;
  const freeTokenGpuMinimumPerDevice = freeTokenMinimumMi(freeTokenCapability?.minimumGpuMemoryMi);
  const freeTokenSystemMinimum = freeTokenMinimumMi(freeTokenCapability?.minimumSystemMemoryMi);
  const freeTokenGpuMaximumPerDevice = Math.floor(selectedFreeTokenDevice?.availableMi ?? 0);
  const freeTokenSystemMaximum = freeTokenNodeAvailableMemoryMi(selectedFreeTokenDevice?.systemAvailableMi);
  const freeTokenMaximumGpuCount = Math.max(1, selectedFreeTokenDevice?.maxGpuCount ?? selectedFreeTokenDevice?.gpuCount ?? 1);
  const selectedFreeTokenGpuCount = clamp(boundedInteger(freeToken.gpuCount, 1), 1, freeTokenMaximumGpuCount);
  const freeTokenGpuMinimum = freeTokenGpuMinimumPerDevice * selectedFreeTokenGpuCount;
  const freeTokenGpuMaximum = freeTokenGpuMaximumPerDevice * selectedFreeTokenGpuCount;
  const invalidFreeToken = !selectedFreeTokenDevice?.supported || !Number.isInteger(freeToken.gpuCount) || freeToken.gpuCount < 1 || freeToken.gpuCount > freeTokenMaximumGpuCount || !Number.isInteger(freeToken.gpuMemoryMi)
    || freeToken.gpuMemoryMi < freeTokenGpuMinimum || freeToken.gpuMemoryMi > freeTokenGpuMaximum
    || !Number.isInteger(freeToken.systemMemoryMi) || freeToken.systemMemoryMi < freeTokenSystemMinimum || freeToken.systemMemoryMi > freeTokenSystemMaximum
    || !Number.isInteger(freeToken.advanced.contextWindow) || freeToken.advanced.contextWindow < 1
    || !Number.isInteger(freeToken.advanced.maxNumSeqs) || freeToken.advanced.maxNumSeqs < 1
    || (freeToken.advanced.maxOutputTokens !== null && (!Number.isInteger(freeToken.advanced.maxOutputTokens) || freeToken.advanced.maxOutputTokens < 1))
    || (freeToken.advanced.kvReserveTokens !== null && (!Number.isInteger(freeToken.advanced.kvReserveTokens) || freeToken.advanced.kvReserveTokens < 1))
    || (freeToken.advanced.cpuThreads !== null && (!Number.isInteger(freeToken.advanced.cpuThreads) || freeToken.advanced.cpuThreads < 1))
    || (freeToken.advanced.cudaGraphMaxBatchSize !== null && (!Number.isInteger(freeToken.advanced.cudaGraphMaxBatchSize) || freeToken.advanced.cudaGraphMaxBatchSize < 1))
    || (freeToken.advanced.moeCacheSize !== null && (!Number.isInteger(freeToken.advanced.moeCacheSize) || freeToken.advanced.moeCacheSize < 0))
    || (freeToken.advanced.maxPrefillLength !== null && (!Number.isInteger(freeToken.advanced.maxPrefillLength) || freeToken.advanced.maxPrefillLength < 1));
  const invalidBudget = isFreeToken ? invalidFreeToken : !Number.isInteger(selectedMi) || selectedMi < 100 || selectedMi % 100 !== 0
    || (cpuOffloading && (!Number.isInteger(hostMemoryMi) || hostMemoryMi < 100 || hostMemoryMi % 100 !== 0));

  useEffect(() => { setCpuOffloading(false); setOffloadEstimate(undefined); setHostMemoryEdited(false); }, [engine, computeTarget]);
  useEffect(() => { setHostMemoryEdited(false); }, [url]);
  useEffect(() => {
    if (!hostMemoryEdited && offload) setHostMemoryMi(roundMemory(offload.ramRecommendedMi));
  }, [offload, hostMemoryEdited]);
  useEffect(() => {
    setOffloadEstimate(undefined); setOffloadError(null);
    if (!cpuOffloading || !supportsOffloading || !url) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.estimateMemory({engine, computeTarget, url, contextWindow, maxNumSeqs, modelType, kvCacheType, cpuOffloading: true, vramMi: selectedMi});
        if (!cancelled) setOffloadEstimate(result);
      } catch (reason) { if (!cancelled) setOffloadError(reason); }
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [cpuOffloading, supportsOffloading, engine, computeTarget, url, contextWindow, maxNumSeqs, modelType, kvCacheType, selectedMi]);

  const applyModel = (nextUrl: string, artifact?: ModelArtifact, variant?: ModelVariant, baseModel?: DiscoveryItem) => {
    setUrl(nextUrl); setName((current) => current || safeModelName(nextUrl));
    const context = [artifact?.modelMaxContext, variant?.contextWindow, baseModel?.modelMaxContext]
      .map((value) => Number(value ?? 0))
      .find((value) => Number.isFinite(value) && value > 0) ?? 0;
    if (context > 0) {
      setContextWindow(context);
      if (isFreeToken) setFreeToken((current) => ({...current, advanced: {...current.advanced, contextWindow: context}}));
    }
    if (variant?.maxNumSeqs) {
      setMaxNumSeqs(variant.maxNumSeqs);
      if (isFreeToken) setFreeToken((current) => ({...current, advanced: {...current.advanced, maxNumSeqs: variant.maxNumSeqs!}}));
    }
  };

  useEffect(() => {
    if (source !== 'preset' || !selectedPreset) return;
    applyModel(selectedPresetArtifact?.url ?? selectedPreset.variant.url ?? '', selectedPresetArtifact, selectedPreset.variant);
  }, [artifactId, presetId, source]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!url || isFreeToken) { setEstimate(undefined); return; }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.estimateMemory({engine, computeTarget, url, contextWindow, maxNumSeqs, modelType, kvCacheType});
        if (!cancelled) {
          setEstimate(result);
          const maximum = capacityKnown ? Math.max(100, Math.floor(availableMi / 100) * 100) : roundMemory(result.recommendedMi);
          setSelectedMi((current) => Math.min(maximum, cpuOffloading ? current : roundMemory(result.recommendedMi)));
          setFormError(null);
        }
      } catch (reason) { if (!cancelled) setFormError(reason); }
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [computeTarget, contextWindow, engine, isFreeToken, kvCacheType, maxNumSeqs, modelType, url, cpuOffloading]);

  const searchParams = (query: string, cursor?: string | null) => {
    const params = new URLSearchParams({provider, q: query, engine, computeTarget, modelType, limit: '20'});
    if (cursor) params.set('cursor', cursor);
    return params;
  };
  const artifactParams = (repo: string, cursor?: string | null) => {
    const params = new URLSearchParams({provider, repo, engine, computeTarget, modelType, limit: '20'});
    if (cursor) params.set('cursor', cursor);
    return params;
  };
  const runSearch = async (query = search, append = false) => {
    setSearching(true); setFormError(null);
    if (!append) { setArtifacts([]); setSelectedSearchArtifact(''); setArtifactBaseModel(undefined); }
    try {
      const result = await api.searchModels(searchParams(query, append ? searchCursor : null));
      const combined = append ? [...searchResults, ...result.results] : result.results;
      setSearchResults(combined); setSearchCursor(result.nextCursor ?? null);
      if (!append) { const first = result.results[0]?.repo ?? ''; setSearchModel(first); if (first) await loadArtifacts(first, false); }
    } catch (reason) { setFormError(reason); } finally { setSearching(false); }
  };
  const loadArtifacts = async (repo: string, append = false) => {
    setSearchModel(repo); setFormError(null); setLoadingArtifacts(true);
    try {
      const result = await api.modelArtifacts(artifactParams(repo, append ? artifactCursor : null));
      const combined = append ? [...artifacts, ...result.artifacts] : result.artifacts;
      setArtifacts(combined); setArtifactCursor(result.nextCursor ?? null); if (!append) setArtifactBaseModel(result.baseModel);
      if (!append) {
        const first = result.artifacts.find((item) => item.compatibility !== 'incompatible') ?? result.artifacts[0];
        setSelectedSearchArtifact(first?.id ?? ''); if (first?.url) applyModel(first.url, first, undefined, result.baseModel ?? selectedSearchModel);
      }
    } catch (reason) { setFormError(reason); } finally { setLoadingArtifacts(false); }
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!url) throw new Error('Select or enter a model reference.');
      if (cpuSettings.invalid) throw new Error('Enter a valid CPU reservation and optional limit.');
      if (deploymentSettings.invalid) throw new Error('Select a vision attention backend offered by the runtime catalog.');
      if (noSlots) throw new Error('No free GPU model slots. Remove a model or change GPU sharing in System > Hardware.');
      if (engineUnavailable) throw new Error(selectedTarget?.engineAvailability?.[engine]?.message ?? 'The selected engine and hardware combination is not available.');
      if (invalidBudget) throw new Error(isFreeToken
        ? 'Select a supported FreeToken GPU node and memory budgets that meet the runtime minimums and currently available capacity.'
        : 'Enter positive memory budgets in steps of 100 MiB.');
      const target = availableTargets.find((item) => item.id === computeTarget);
      if (!target?.available || !targetSupportsEngine(target, engine)) throw new Error('The selected engine and hardware combination is not available.');
      const local: Record<string, unknown> = {modelType, computeTarget, engine};
      if (cpuSettings.payload) local.cpuResources = cpuSettings.payload;
      if (deploymentSettings.payload) local.vllm = deploymentSettings.payload;
      if (isFreeToken) {
        local.contextWindow = freeToken.advanced.contextWindow;
        local.maxNumSeqs = freeToken.advanced.maxNumSeqs;
        if (freeToken.advanced.maxOutputTokens !== null) local.maxOutputTokens = freeToken.advanced.maxOutputTokens;
        local.freetoken = freeTokenPayload(freeToken, models);
      } else {
        local.contextWindow = contextWindow;
        local.maxNumSeqs = maxNumSeqs;
        local.kvCacheType = kvCacheType;
        if (hasMemoryRisk) local.allowMemoryRisk = true;
        if (target.kind === 'cpu' || computeTarget === 'cpu') local.memoryRequiredMi = selectedMi; else local.vram = `${selectedMi}Mi`;
        if (supportsOffloading) {
          local.cpuOffloading = cpuOffloading;
          if (cpuOffloading) {
            local.memoryRequiredMi = hostMemoryMi;
          }
        }
      }
      if (source === 'preset' && presetId) { local.preset = presetId; if (artifactId) local.artifact = artifactId; } else local.url = url;
      await api.createLocalModel({name: name || safeModelName(url), enabled: true, targetNamespace: 'ai', local});
    },
    onSuccess: async () => { await onCreated(); onClose(); },
  });

  return <form className="stack" onSubmit={(event) => { event.preventDefault(); createMutation.mutate(); }}>
    <div className="form-grid">
      <Field label="Hardware"><select value={computeTarget} aria-describedby={noSlots ? 'model-slots-full' : undefined} onChange={(event) => setComputeTarget(event.target.value)}>
        {!computeTarget && <option value="" disabled>No hardware with free slots</option>}
        {targets.map((target) => {const slots = targetSlots(target, engine); const available = targetEngineAvailable(target, engine); return <option key={target.id} value={target.id} disabled={!available || slotsFull(target, engine)}>{target.displayName ?? target.id}{!available ? ` · unavailable: ${target.engineAvailability?.[engine]?.message ?? 'engine is not eligible'}` : slots ? slots.free === 0 ? ` · no free slots (${slots.used}/${slots.total} occupied)` : ` · ${slots.free}/${slots.total} slots free` : ''}</option>;})}
      </select></Field>
      <Field label="Model source"><select value={source} onChange={(event) => setSource(event.target.value as typeof source)}><option value="search">{provider === 'ollama' ? 'Ollama Library' : 'Hugging Face search'}</option><option value="preset">Tested preset</option><option value="direct">Direct reference</option></select></Field>
    </div>

    {noSlots && <p id="model-slots-full" className="notice notice-warn" role="status">No free GPU model slots. Remove a model or change GPU sharing in System &gt; Hardware.</p>}
    {engineUnavailable && <p className="notice notice-warn" role="status">{selectedTarget?.engineAvailability?.[engine]?.message ?? `${engine} is not available on the selected hardware.`}</p>}

    {source === 'search' && <Panel title={provider === 'ollama' ? 'Ollama Library' : 'Hugging Face'} className="nested-panel">
      <div className="search-row"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Qwen, GLM, DeepSeek…" /><Button type="button" variant="primary" disabled={searching || search.trim().length < 2} onClick={() => runSearch()}>{searching ? 'Searching…' : 'Search'}</Button></div>
      <div className="quick-list"><span className="muted">Model families</span>{['Qwen', 'DeepSeek', 'GLM', 'Llama', 'Gemma', 'Mistral'].map((item) => <Button key={item} type="button" variant="ghost" onClick={() => { setSearch(item); void runSearch(item); }}>{item}</Button>)}</div>
      <ErrorNotice error={formError} />
      {popular.length > 0 && <div className="quick-list"><span className="muted">{provider === 'ollama' ? 'Popular on Ollama' : 'Trending on Hugging Face'}</span>{popular.slice(0, 8).map((item) => <Button key={item.repo} type="button" variant="ghost" onClick={() => { setSearch(item.repo); void runSearch(item.repo); }}>{item.name ?? item.repo}</Button>)}</div>}
      {searchResults.length > 0 && <div className="stack compact discovery-selects">
        <Field label="Matching model"><select value={searchModel} onChange={(event) => loadArtifacts(event.target.value, false)}>{searchResults.map((item) => <option key={item.repo} value={item.repo}>{item.repo}{item.pulls ? ` · ${item.pulls.toLocaleString()} pulls` : ''}</option>)}</select></Field>
        {searchCursor && <Button type="button" variant="ghost" disabled={searching} onClick={() => runSearch(search, true)}>Load more models</Button>}
        <Field label={provider === 'ollama' ? 'Tag / quantization' : 'Quantization / artifact'}><select value={selectedSearchArtifact} disabled={loadingArtifacts} onChange={(event) => { const id = event.target.value; setSelectedSearchArtifact(id); const item = artifacts.find((artifact) => artifact.id === id); if (item?.url) applyModel(item.url, item, undefined, artifactBaseModel ?? selectedSearchModel); }}>{artifacts.map((item) => <option key={item.id} value={item.id}>{item.label ?? item.repo}{item.sizeLabel ? ` · ${item.sizeLabel}` : item.downloadBytes ? ` · ${formatBytes(item.downloadBytes)}` : ''}</option>)}</select></Field>
        {artifactCursor && <Button type="button" variant="ghost" disabled={loadingArtifacts} onClick={() => loadArtifacts(searchModel, true)}>Load more {provider === 'ollama' ? 'tags' : 'quantizations'}</Button>}
        <DiscoveryMetadata item={selectedDiscoveryArtifact} />
      </div>}
      {!searching && !searchResults.length && <p className="muted">Enter at least two characters or choose a model family or popular model.</p>}
    </Panel>}

    {source === 'preset' && <div className="stack compact discovery-selects"><Field label="Preset"><select value={presetId} onChange={(event) => { setPresetId(event.target.value); setArtifactId(''); }}><option value="">Select a tested preset</option>{presets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field><Field label="Precision / Quantization"><select value={artifactId} onChange={(event) => setArtifactId(event.target.value)} disabled={!selectedPreset}><option value="">Default artifact</option>{selectedPreset?.variant.artifacts?.map((item) => <option key={item.id} value={item.id}>{item.title ?? item.id}</option>)}</select></Field></div>}
    {source === 'direct' && <Field label={engine === 'OLlama' ? 'Ollama model reference' : isFreeToken ? 'Hugging Face model reference' : 'Hugging Face URL'}><input value={url} onChange={(event) => { const nextUrl = event.target.value; setUrl(nextUrl); if (nextUrl) setName((current) => current || safeModelName(nextUrl)); }} placeholder={engine === 'OLlama' ? 'ollama://qwen3.5:9b' : 'hf://Qwen/Qwen3.6-27B'} required /></Field>}

    <div className="form-grid three"><Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field label="Type"><select value={modelType} onChange={(event) => setModelType(event.target.value)}><option value="chat">Chat</option><option value="embedding">Embedding</option></select></Field><Field label="Selected URL"><input value={url} readOnly /></Field>{!isFreeToken && <><Field label="Max Num Seqs"><input type="number" min="1" value={maxNumSeqs} onChange={(event) => setMaxNumSeqs(Number(event.target.value))} /></Field><Field label="Context Size"><input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(Number(event.target.value))} /></Field><Field label="KV Cache"><select value={kvCacheType} onChange={(event) => setKvCacheType(event.target.value)}>{kvCacheOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field></>}</div>
    {isFreeToken ? <FreeTokenSettingsPanel models={models} computeTarget={computeTarget} value={freeToken} onChange={setFreeToken} /> : <>
      <p className="muted">{kvCacheOptions.find((option) => option.value === kvCacheType)?.description} Attention-cache values are recalculated immediately; recurrent state and runtime reserve remain separate.</p>
      <EstimatePanel estimate={cpuOffloading ? offloadEstimate ?? estimate : estimate} availableMi={availableMi} capacityKnown={capacityKnown} selectedMi={selectedMi} onSelected={setSelectedMi} hideBreakdown={cpuOffloading} />
    </>}
    {supportsOffloading && <Panel title="CPU offloading" className="nested-panel">
      <label className="check-field"><input type="checkbox" checked={cpuOffloading} onChange={(event) => setCpuOffloading(event.target.checked)} />Use additional system RAM</label>
      <p className="muted">Stores part of the model in this GPU node's RAM. This can run larger models, but may substantially reduce response speed. No disk swap or RAM from another node is used.</p>
      {cpuOffloading && <>
        {!offload && !offloadError && <p role="status">Calculating the RAM / VRAM allocation…</p>}
        {offload && <section className="estimate stack compact">
          <header><strong>Host RAM reservation</strong><p className="muted">Includes offloading and runtime</p></header>
          <div className="estimate-metrics"><div><span>Minimum</span><strong><MemoryInfo label="Host RAM minimum" value={formatMi(offload.ramMinimumMi)} calculation={offloadEstimate?.calculations?.ramMinimumMi} /></strong></div><div><span>Recommended</span><strong><MemoryInfo label="Host RAM recommended" value={formatMi(offload.ramRecommendedMi)} calculation={offloadEstimate?.calculations?.ramRecommendedMi} /></strong></div><div><span>100% unreserved on an eligible GPU node</span><strong><MemoryInfo label="Unreserved host RAM" value={offload.ramMaximumMi === null ? 'Unknown' : formatMi(hostMaximum)} calculation={unreservedCalculation(offload.ramMaximumMi)} /></strong></div></div>
          <input aria-label="Host RAM reservation" type="range" min="100" step="100" max={Math.max(100, hostMaximum)} value={Math.min(Math.max(100, hostMaximum), hostMemoryMi)} disabled={!hostMaximum} onChange={(event) => { setHostMemoryEdited(true); setHostMemoryMi(Number(event.target.value)); }} />
          <Field label="Host RAM budget (MiB)"><input type="number" min="100" step="100" value={hostMemoryMi} onChange={(event) => { setHostMemoryEdited(true); setHostMemoryMi(Number(event.target.value)); }} /></Field>
          <Button type="button" onClick={() => { setHostMemoryEdited(false); setHostMemoryMi(roundMemory(offload.ramRecommendedMi)); }}>Use recommended RAM allocation</Button>
          <p className="muted">The GPU budget above is preserved. Kubernetes reserves this host RAM on the same node as the GPU; the estimate uses the largest eligible node, not a cluster-wide sum.</p>
          {engine === 'OLlama' && <p className="muted">Ollama always uses GPU-first auto-fit and places as many layers in actual free VRAM as possible. The selected values remain planning and Kubernetes host-memory budgets; the loaded model's effective split is shown separately.</p>}
        </section>}
        {offloadEstimate && <EstimateBreakdown estimate={offloadEstimate} />}
      </>}
      <ErrorNotice error={offloadError} />
    </Panel>}
    <AdvancedModelSettings cpuSettings={cpuSettings} deploymentSettings={deploymentSettings} />
    <ErrorNotice error={source === 'search' ? createMutation.error : formError ?? createMutation.error} />
    {hasMemoryRisk && <div id="model-memory-risk" className="notice notice-warn" role="note"><strong>Memory warning — you can still try to start this model.</strong><ul>{memoryRisks.map((risk) => <li key={risk}>{risk}</li>)}</ul><p>Adding it accepts this risk. The pod may remain Pending, fail with out-of-memory errors or restart. Requests and limits stay at your selected budgets; a successful start is not guaranteed.</p></div>}
    <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" className={hasMemoryRisk ? 'memory-risk-button' : undefined} aria-describedby={[noSlots ? 'model-slots-full' : '', hasMemoryRisk ? 'model-memory-risk' : ''].filter(Boolean).join(' ') || undefined} disabled={createMutation.isPending || !url || invalidBudget || cpuSettings.invalid || deploymentSettings.invalid || !selectedTarget || noSlots || engineUnavailable}>{hasMemoryRisk && <span aria-hidden="true">⚠ </span>}Add Local Model</Button></div>
  </form>;
};

const ExternalModelForm = ({onClose, onCreated}: {onClose: () => void; onCreated: () => Promise<void>}) => {
  const [name, setName] = useState(''); const [model, setModel] = useState('openai/gpt-4o-mini'); const [apiBase, setApiBase] = useState('https://api.openai.com/v1'); const [apiKey, setApiKey] = useState(''); const [modelType, setModelType] = useState('chat'); const [contextWindow, setContextWindow] = useState(128000);
  const mutation = useMutation({mutationFn: () => api.createExternalModel({name, enabled: true, targetNamespace: 'ai', external: {model, apiBase, modelType, contextWindow}, ...(apiKey ? {apiKey} : {})}), onSuccess: async () => { await onCreated(); onClose(); }});
  return <form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><div className="form-grid"><Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field label="Provider Model"><input value={model} onChange={(event) => setModel(event.target.value)} required /></Field><Field label="API Base"><input value={apiBase} onChange={(event) => setApiBase(event.target.value)} type="url" required /></Field><Field label="Type"><select value={modelType} onChange={(event) => setModelType(event.target.value)}><option value="chat">Chat</option><option value="embedding">Embedding</option></select></Field><Field label="Context Size"><input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(Number(event.target.value))} /></Field><Field label="API Key"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" placeholder="Optional when supplied elsewhere" /></Field></div><ErrorNotice error={mutation.error} /><div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={mutation.isPending}>Add External Model</Button></div></form>;
};

const FreeTokenModelEditForm = ({activation, models, onClose, onUpdated}: {activation: ModelActivation; models: ModelsPayload; onClose: () => void; onUpdated: () => Promise<void>}) => {
  const name = String(activation.metadata?.name ?? '');
  const local = asRecord(activation.spec?.local);
  const status = asRecord(activation.status);
  const [initial] = useState(() => {
    const contextWindow = boundedInteger(local.contextWindow ?? status.contextWindow, 4096);
    const maxNumSeqs = boundedInteger(local.maxNumSeqs ?? status.maxNumSeqs, 1);
    return {
      revision: modelEditRevision(activation),
      computeTarget: String(local.computeTarget ?? status.computeTarget ?? 'nvidia-gpu'),
      modelType: String(local.modelType ?? 'chat'),
      freetoken: freeTokenSettingsFrom(local.freetoken, contextWindow, maxNumSeqs),
    };
  });
  const [modelType, setModelType] = useState(initial.modelType);
  const [freetoken, setFreeToken] = useState(initial.freetoken);
  const cpuSettings = useCpuSettings(local.cpuResources, models, 'FreeToken', initial.computeTarget);
  const replacement = activation.spec?.enabled !== false ? initial.freetoken : undefined;
  const selectedDevice = freeTokenDeviceOptions(models, initial.computeTarget, replacement, freetoken.gpuCount).find((device) => device.id === freetoken.gpuDevice);
  const freeTokenCapability = models.computeTargets.freeTokenCapabilities;
  const gpuMinimumPerDeviceMi = freeTokenMinimumMi(freeTokenCapability?.minimumGpuMemoryMi);
  const systemMinimumMi = freeTokenMinimumMi(freeTokenCapability?.minimumSystemMemoryMi);
  const gpuMaximumPerDeviceMi = Math.floor(selectedDevice?.availableMi ?? 0);
  const systemMaximumMi = freeTokenNodeAvailableMemoryMi(selectedDevice?.systemAvailableMi);
  const maximumGpuCount = Math.max(1, selectedDevice?.maxGpuCount ?? selectedDevice?.gpuCount ?? 1);
  const selectedGpuCount = clamp(boundedInteger(freetoken.gpuCount, 1), 1, maximumGpuCount);
  const gpuMinimumMi = gpuMinimumPerDeviceMi * selectedGpuCount;
  const gpuMaximumMi = gpuMaximumPerDeviceMi * selectedGpuCount;
  const rootRuntimeChanged = freetoken.advanced.contextWindow !== initial.freetoken.advanced.contextWindow
    || freetoken.advanced.maxNumSeqs !== initial.freetoken.advanced.maxNumSeqs
    || freetoken.advanced.maxOutputTokens !== initial.freetoken.advanced.maxOutputTokens;
  const freeTokenRuntimeChanged = JSON.stringify(freeTokenPayload(freetoken, models)) !== JSON.stringify(freeTokenPayload(initial.freetoken, models));
  const changed = cpuSettings.changed || modelType !== initial.modelType || rootRuntimeChanged || freeTokenRuntimeChanged;
  const invalid = cpuSettings.invalid || !initial.revision || !selectedDevice?.supported || !Number.isInteger(freetoken.gpuCount) || freetoken.gpuCount < 1 || freetoken.gpuCount > maximumGpuCount || !Number.isInteger(freetoken.gpuMemoryMi)
    || freetoken.gpuMemoryMi < gpuMinimumMi || freetoken.gpuMemoryMi > gpuMaximumMi
    || !Number.isInteger(freetoken.systemMemoryMi) || freetoken.systemMemoryMi < systemMinimumMi || freetoken.systemMemoryMi > systemMaximumMi
    || !Number.isInteger(freetoken.advanced.contextWindow) || freetoken.advanced.contextWindow < 1
    || !Number.isInteger(freetoken.advanced.maxNumSeqs) || freetoken.advanced.maxNumSeqs < 1
    || (freetoken.advanced.maxOutputTokens !== null && (!Number.isInteger(freetoken.advanced.maxOutputTokens) || freetoken.advanced.maxOutputTokens < 1))
    || (freetoken.advanced.kvReserveTokens !== null && (!Number.isInteger(freetoken.advanced.kvReserveTokens) || freetoken.advanced.kvReserveTokens < 1))
    || (freetoken.advanced.cpuThreads !== null && (!Number.isInteger(freetoken.advanced.cpuThreads) || freetoken.advanced.cpuThreads < 1))
    || (freetoken.advanced.cudaGraphMaxBatchSize !== null && (!Number.isInteger(freetoken.advanced.cudaGraphMaxBatchSize) || freetoken.advanced.cudaGraphMaxBatchSize < 1))
    || (freetoken.advanced.moeCacheSize !== null && (!Number.isInteger(freetoken.advanced.moeCacheSize) || freetoken.advanced.moeCacheSize < 0))
    || (freetoken.advanced.maxPrefillLength !== null && (!Number.isInteger(freetoken.advanced.maxPrefillLength) || freetoken.advanced.maxPrefillLength < 1));
  const mutation = useMutation({
    mutationFn: () => {
      const next: Record<string, unknown> = {};
      if (modelType !== initial.modelType) next.modelType = modelType;
      if (freetoken.advanced.contextWindow !== initial.freetoken.advanced.contextWindow) next.contextWindow = freetoken.advanced.contextWindow;
      if (freetoken.advanced.maxNumSeqs !== initial.freetoken.advanced.maxNumSeqs) next.maxNumSeqs = freetoken.advanced.maxNumSeqs;
      if (freetoken.advanced.maxOutputTokens !== initial.freetoken.advanced.maxOutputTokens) next.maxOutputTokens = freetoken.advanced.maxOutputTokens;
      if (freeTokenRuntimeChanged) next.freetoken = freeTokenPayload(freetoken, models);
      if (cpuSettings.changed) next.cpuResources = cpuSettings.payload;
      return api.updateModel(name, {expectedRevision: initial.revision, local: next});
    },
    onSuccess: async () => { await onUpdated(); onClose(); },
  });
  return <form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
    <div className="tag-list"><span className="tag">Model: {name}</span><span className="tag">Engine: FreeToken</span><span className="tag">Compute: {initial.computeTarget}</span><span className="tag">Source unchanged</span></div>
    <Field label="Type"><select value={modelType} onChange={(event) => setModelType(event.target.value)}><option value="chat">Chat</option><option value="embedding">Embedding</option></select></Field>
    <FreeTokenSettingsPanel models={models} computeTarget={initial.computeTarget} value={freetoken} onChange={setFreeToken} replacement={replacement} />
    <AdvancedModelSettings cpuSettings={cpuSettings} />
    <p className="muted">Saving reconciles the FreeToken runtime. The Pod restarts while the new parameters are applied.</p>
    <ErrorNotice error={mutation.error} />
    <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!changed || invalid || mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Save changes'}</Button></div>
  </form>;
};

const StandardLocalModelEditForm = ({activation, models, onClose, onUpdated}: {activation: ModelActivation; models: ModelsPayload; onClose: () => void; onUpdated: () => Promise<void>}) => {
  const name = String(activation.metadata?.name ?? '');
  const local = (activation.spec?.local ?? {}) as Record<string, unknown>;
  const status = (activation.status ?? {}) as Record<string, unknown>;
  const [initial] = useState(() => {
    const computeTarget = String(local.computeTarget ?? status.computeTarget ?? 'nvidia-gpu');
    const engine = String(local.engine ?? status.engine ?? 'VLLM');
    const budget = computeTarget === 'cpu'
      ? parseMemoryMi(local.memoryRequiredMi ?? status.memoryRequiredMi)
      : parseMemoryMi(local.vramMi ?? local.vram ?? status.vramRequiredMi);
    return {
      revision: modelEditRevision(activation), computeTarget, engine,
      modelType: String(local.modelType ?? 'chat'), contextWindow: Number(local.contextWindow ?? 4096),
      maxOutputTokens: local.maxOutputTokens ? String(local.maxOutputTokens) : '', maxNumSeqs: Number(local.maxNumSeqs ?? 1),
      kvCacheType: String(local.kvCacheType ?? (engine === 'OLlama' ? 'f16' : 'auto')),
      selectedMi: Math.max(100, budget || 100), cpuOffloading: local.cpuOffloading === true,
      hostMemoryMi: Math.max(100, parseMemoryMi(local.memoryRequiredMi ?? status.memoryRequiredMi) || 100),
      allowMemoryRisk: local.allowMemoryRisk === true,
    };
  });
  const [modelType, setModelType] = useState(initial.modelType);
  const [contextWindow, setContextWindow] = useState(initial.contextWindow);
  const [maxOutputTokens, setMaxOutputTokens] = useState(initial.maxOutputTokens);
  const [maxNumSeqs, setMaxNumSeqs] = useState(initial.maxNumSeqs);
  const [kvCacheType, setKvCacheType] = useState(initial.kvCacheType);
  const [selectedMi, setSelectedMi] = useState(initial.selectedMi);
  const [cpuOffloading, setCpuOffloading] = useState(initial.cpuOffloading);
  const [hostMemoryMi, setHostMemoryMi] = useState(initial.hostMemoryMi);
  const cpuSettings = useCpuSettings(local.cpuResources, models, initial.engine, initial.computeTarget);
  const deploymentSettings = useVllmDeploymentSettings(local.vllm, models, initial.engine, initial.computeTarget);
  const target = models.computeTargets.targets.find((item) => item.id === initial.computeTarget);
  const advertisedKvCacheOptions = target?.kvCacheTypes?.[initial.engine] ?? fallbackKvCacheOptions(initial.engine);
  const kvCacheOptions = advertisedKvCacheOptions.some((option) => option.value === initial.kvCacheType)
    ? advertisedKvCacheOptions
    : [{value: initial.kvCacheType, label: `Current - ${initial.kvCacheType}`, description: 'Currently stored value.'}, ...advertisedKvCacheOptions];
  const supportsOffloading = initial.computeTarget === 'nvidia-gpu';
  const userChanged = cpuSettings.changed || deploymentSettings.changed || modelType !== initial.modelType || contextWindow !== initial.contextWindow
    || maxOutputTokens !== initial.maxOutputTokens || maxNumSeqs !== initial.maxNumSeqs
    || kvCacheType !== initial.kvCacheType || selectedMi !== initial.selectedMi
    || cpuOffloading !== initial.cpuOffloading || (cpuOffloading && hostMemoryMi !== initial.hostMemoryMi);
  const estimateQuery = useQuery({
    queryKey: ['model-edit-estimate', name, modelType, contextWindow, maxOutputTokens, maxNumSeqs, kvCacheType, selectedMi, cpuOffloading],
    queryFn: () => api.estimateModelUpdate(name, {
      modelType, contextWindow, maxOutputTokens: maxOutputTokens ? Number(maxOutputTokens) : null,
      maxNumSeqs, kvCacheType, cpuOffloading, ...(initial.computeTarget === 'cpu' ? {memoryRequiredMi: selectedMi} : {vramMi: selectedMi}),
    }),
    enabled: Boolean(name), retry: false,
    // Keep the range input mounted while a changed budget is re-estimated. If
    // the panel is replaced during pointer interaction, the browser loses the
    // active drag and the dialog visibly flickers.
    placeholderData: (previousData) => previousData,
  });
  const estimate = estimateQuery.data;
  const targetDevices = models.computeMemory?.devices?.filter((device) => device.computeTarget === initial.computeTarget || device.id === initial.computeTarget) ?? [];
  const fallbackAvailable = targetDevices.reduce((maximum, device) => Math.max(maximum, Number(device.unreservedMi ?? 0)), 0) + initial.selectedMi;
  const capacityKnown = typeof estimate?.maximumMi === 'number' || fallbackAvailable > initial.selectedMi;
  const availableMi = typeof estimate?.maximumMi === 'number' ? estimate.maximumMi : fallbackAvailable;
  const offload = cpuOffloading ? estimate?.offloading : undefined;
  const hostMaximum = Math.max(0, Math.floor(Number(offload?.ramMaximumMi ?? 0) / 100) * 100);
  const memoryRisks = estimate ? [
    ...(estimate.confidence !== 'high' ? ['Memory requirements are estimated and may differ at runtime.'] : []),
    ...(selectedMi < roundMemory(estimate.minimumMi) ? ['The selected memory is below the estimated minimum.'] : []),
    ...(capacityKnown && selectedMi > availableMi ? ['The selected memory exceeds currently unreserved capacity.'] : []),
    ...(!capacityKnown ? ['Unreserved device capacity could not be verified.'] : []),
    ...(cpuOffloading && (!offload || !offload.fitsVram) ? ['The offloading plan may not fit the selected VRAM budget.'] : []),
    ...(offload?.ramMaximumMi === null ? ['Unreserved host RAM could not be verified.'] : []),
    ...(offload && hostMemoryMi < offload.ramMinimumMi ? ['Host RAM is below the estimated offloading minimum.'] : []),
    ...(offload && offload.ramMaximumMi !== null && hostMemoryMi > hostMaximum ? ['Host RAM exceeds currently unreserved capacity.'] : []),
  ] : [];
  const hasMemoryRisk = memoryRisks.length > 0;
  const changes = useMemo(() => {
    const next: Record<string, unknown> = {};
    if (modelType !== initial.modelType) next.modelType = modelType;
    if (contextWindow !== initial.contextWindow) next.contextWindow = contextWindow;
    if (maxOutputTokens !== initial.maxOutputTokens) next.maxOutputTokens = maxOutputTokens ? Number(maxOutputTokens) : null;
    if (maxNumSeqs !== initial.maxNumSeqs) next.maxNumSeqs = maxNumSeqs;
    if (kvCacheType !== initial.kvCacheType) next.kvCacheType = kvCacheType;
    if (selectedMi !== initial.selectedMi) next[initial.computeTarget === 'cpu' ? 'memoryRequiredMi' : 'vramMi'] = selectedMi;
    if (cpuOffloading !== initial.cpuOffloading) next.cpuOffloading = cpuOffloading;
    if (cpuOffloading && (hostMemoryMi !== initial.hostMemoryMi || !initial.cpuOffloading)) next.memoryRequiredMi = hostMemoryMi;
    if (!cpuOffloading && initial.cpuOffloading) next.memoryRequiredMi = null;
    if (userChanged && hasMemoryRisk !== initial.allowMemoryRisk) next.allowMemoryRisk = hasMemoryRisk;
    if (cpuSettings.changed) next.cpuResources = cpuSettings.payload;
    if (deploymentSettings.changed) next.vllm = deploymentSettings.payload;
    return next;
  }, [cpuOffloading, contextWindow, hasMemoryRisk, hostMemoryMi, initial, kvCacheType, maxNumSeqs, maxOutputTokens, modelType, selectedMi, userChanged, cpuSettings.changed, cpuSettings.payload, deploymentSettings.changed, deploymentSettings.payload]);
  const invalid = cpuSettings.invalid || deploymentSettings.invalid || !initial.revision || !Number.isInteger(contextWindow) || contextWindow < 1
    || !Number.isInteger(maxNumSeqs) || maxNumSeqs < 1
    || (maxOutputTokens !== '' && (!Number.isInteger(Number(maxOutputTokens)) || Number(maxOutputTokens) < 1))
    || !Number.isInteger(selectedMi) || selectedMi < 100 || (selectedMi !== initial.selectedMi && selectedMi % 100 !== 0)
    || (cpuOffloading && (!Number.isInteger(hostMemoryMi) || hostMemoryMi < 100 || (hostMemoryMi !== initial.hostMemoryMi && hostMemoryMi % 100 !== 0)));
  const mutation = useMutation({
    mutationFn: () => api.updateModel(name, {expectedRevision: initial.revision, local: changes}),
    onSuccess: async () => { await onUpdated(); onClose(); },
  });
  return <form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
    <div className="tag-list"><span className="tag">Model: {name}</span><span className="tag">Engine: {initial.engine}</span><span className="tag">Compute: {initial.computeTarget}</span><span className="tag">Source unchanged</span></div>
    <div className="form-grid"><Field label="Type"><select value={modelType} onChange={(event) => setModelType(event.target.value)}><option value="chat">Chat</option><option value="embedding">Embedding</option></select></Field><Field label="Context Size"><input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(Number(event.target.value))} /></Field><Field label="Max Output Tokens"><input type="number" min="1" value={maxOutputTokens} placeholder="Runtime default" onChange={(event) => setMaxOutputTokens(event.target.value)} /></Field><Field label="Max Num Seqs"><input type="number" min="1" value={maxNumSeqs} onChange={(event) => setMaxNumSeqs(Number(event.target.value))} /></Field><Field label="KV Cache"><select value={kvCacheType} onChange={(event) => setKvCacheType(event.target.value)}>{kvCacheOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field></div>
    <p className="muted">{kvCacheOptions.find((option) => option.value === kvCacheType)?.description}</p>
    {estimateQuery.isPending && <p role="status">Recalculating memory…</p>}
    <EstimatePanel estimate={estimate} availableMi={availableMi} capacityKnown={capacityKnown} selectedMi={selectedMi} onSelected={setSelectedMi} hideBreakdown={cpuOffloading} preserveSelectedMi={initial.selectedMi} />
    {supportsOffloading && <Panel title="CPU offloading" className="nested-panel"><label className="check-field"><input type="checkbox" checked={cpuOffloading} onChange={(event) => setCpuOffloading(event.target.checked)} />Use additional system RAM</label>{cpuOffloading && offload && <div className="stack compact"><div className="estimate-metrics"><div><span>Minimum</span><strong>{formatMi(offload.ramMinimumMi)}</strong></div><div><span>Recommended</span><strong>{formatMi(offload.ramRecommendedMi)}</strong></div><div><span>Unreserved</span><strong>{offload.ramMaximumMi === null ? 'Unknown' : formatMi(hostMaximum)}</strong></div></div><Field label="Host RAM budget (MiB)"><input type="number" min="100" step={hostMemoryMi === initial.hostMemoryMi ? 1 : 100} value={hostMemoryMi} onChange={(event) => setHostMemoryMi(Number(event.target.value))} /></Field><Button type="button" onClick={() => setHostMemoryMi(roundMemory(offload.ramRecommendedMi))}>Use recommended RAM allocation</Button></div>}</Panel>}
    {hasMemoryRisk && <div className="notice notice-warn" role="note"><strong>Memory warning — this change can still be applied.</strong><ul>{memoryRisks.map((risk) => <li key={risk}>{risk}</li>)}</ul></div>}
    <AdvancedModelSettings cpuSettings={cpuSettings} deploymentSettings={deploymentSettings} />
    <p className="muted">Saving reconciles the model runtime. The Pod may restart while the new parameters are applied.</p>
    <ErrorNotice error={estimateQuery.error ?? mutation.error} />
    <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" className={hasMemoryRisk ? 'memory-risk-button' : undefined} disabled={!userChanged || invalid || estimateQuery.isFetching || estimateQuery.isError || mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Save changes'}</Button></div>
  </form>;
};

const LocalModelEditForm = ({activation, models, onClose, onUpdated}: {activation: ModelActivation; models: ModelsPayload; onClose: () => void; onUpdated: () => Promise<void>}) => {
  const local = asRecord(activation.spec?.local);
  const status = asRecord(activation.status);
  if (local.realtime) return <RealtimeModelForm activation={activation} models={models} onClose={onClose} onSaved={onUpdated} />;
  return isFreeTokenEngine(String(local.engine ?? status.engine ?? ''))
    ? <FreeTokenModelEditForm activation={activation} models={models} onClose={onClose} onUpdated={onUpdated} />
    : <StandardLocalModelEditForm activation={activation} models={models} onClose={onClose} onUpdated={onUpdated} />;
};

const optionalPositive = (value: string) => value ? Number(value) : null;

const ExternalModelEditForm = ({activation, onClose, onUpdated}: {activation: ModelActivation; onClose: () => void; onUpdated: () => Promise<void>}) => {
  const name = String(activation.metadata?.name ?? '');
  const external = (activation.spec?.external ?? {}) as Record<string, unknown>;
  const [initial] = useState(() => ({
    revision: modelEditRevision(activation), model: String(external.model ?? ''), apiBase: String(external.apiBase ?? ''),
    modelType: String(external.modelType ?? 'chat'), apiVersion: String(external.apiVersion ?? ''), customLlmProvider: String(external.customLlmProvider ?? ''),
    tpm: external.tpm ? String(external.tpm) : '', rpm: external.rpm ? String(external.rpm) : '',
    contextWindow: external.contextWindow ? String(external.contextWindow) : '', maxOutputTokens: external.maxOutputTokens ? String(external.maxOutputTokens) : '',
  }));
  const [model, setModel] = useState(initial.model); const [apiBase, setApiBase] = useState(initial.apiBase); const [modelType, setModelType] = useState(initial.modelType);
  const [apiVersion, setApiVersion] = useState(initial.apiVersion); const [customLlmProvider, setCustomLlmProvider] = useState(initial.customLlmProvider);
  const [tpm, setTpm] = useState(initial.tpm); const [rpm, setRpm] = useState(initial.rpm); const [contextWindow, setContextWindow] = useState(initial.contextWindow); const [maxOutputTokens, setMaxOutputTokens] = useState(initial.maxOutputTokens); const [apiKey, setApiKey] = useState('');
  const current = {model, apiBase, modelType, apiVersion, customLlmProvider, tpm, rpm, contextWindow, maxOutputTokens};
  const changes = Object.fromEntries(Object.entries(current).filter(([key, value]) => value !== initial[key as keyof typeof initial]).map(([key, value]) => [key,
    ['tpm', 'rpm', 'contextWindow', 'maxOutputTokens'].includes(key) ? optionalPositive(value)
      : ['apiBase', 'apiVersion', 'customLlmProvider'].includes(key) ? value || null : value,
  ]));
  const changed = Object.keys(changes).length > 0 || Boolean(apiKey);
  const numericValues = [tpm, rpm, contextWindow, maxOutputTokens].filter(Boolean).map(Number);
  const invalid = !initial.revision || !model.trim() || numericValues.some((value) => !Number.isInteger(value) || value < 1);
  const mutation = useMutation({mutationFn: () => api.updateModel(name, {expectedRevision: initial.revision, external: changes, ...(apiKey ? {apiKey} : {})}), onSuccess: async () => { await onUpdated(); onClose(); }});
  return <form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
    <div className="tag-list"><span className="tag">Model: {name}</span><span className="tag">External provider</span></div>
    <div className="form-grid"><Field label="Provider Model"><input value={model} onChange={(event) => setModel(event.target.value)} required /></Field><Field label="API Base"><input value={apiBase} onChange={(event) => setApiBase(event.target.value)} type="url" placeholder="Provider default" /></Field><Field label="Type"><select value={modelType} onChange={(event) => setModelType(event.target.value)}><option value="chat">Chat</option><option value="embedding">Embedding</option></select></Field><Field label="Provider"><input value={customLlmProvider} onChange={(event) => setCustomLlmProvider(event.target.value)} placeholder="Optional" /></Field><Field label="API Version"><input value={apiVersion} onChange={(event) => setApiVersion(event.target.value)} placeholder="Optional" /></Field><Field label="Context Size"><input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} placeholder="Provider default" /></Field><Field label="Max Output Tokens"><input type="number" min="1" value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} placeholder="Provider default" /></Field><Field label="Tokens per minute"><input type="number" min="1" value={tpm} onChange={(event) => setTpm(event.target.value)} placeholder="Unlimited" /></Field><Field label="Requests per minute"><input type="number" min="1" value={rpm} onChange={(event) => setRpm(event.target.value)} placeholder="Unlimited" /></Field><Field label="Replace API Key"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" placeholder="Leave blank to keep the current key" /></Field></div>
    <p className="muted">Saving reconciles the provider entry. A blank API key keeps the configured Secret unchanged.</p><ErrorNotice error={mutation.error} />
    <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!changed || invalid || mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Save changes'}</Button></div>
  </form>;
};

const EditModelDialog = ({activation, models, onClose, onUpdated}: {activation?: ModelActivation; models: ModelsPayload; onClose: () => void; onUpdated: () => Promise<void>}) => <Dialog open={Boolean(activation)} title={`Edit Model · ${activation?.metadata?.name ?? ''}`} description={activation?.spec?.type === 'local' ? 'Change runtime parameters without replacing the model source, engine, or hardware target.' : 'Change provider and runtime parameters without replacing the activation.'} onClose={onClose}>
  {activation?.spec?.type === 'local'
    ? <LocalModelEditForm activation={activation} models={models} onClose={onClose} onUpdated={onUpdated} />
    : activation ? <ExternalModelEditForm activation={activation} onClose={onClose} onUpdated={onUpdated} /> : null}
</Dialog>;

const OffloadingStatus = ({local, status}: {local: Record<string, unknown>; status?: Record<string, unknown>}) => {
  if (!local.cpuOffloading) return null;
  const usage = status?.memoryUsage as {ramMi?: number; vramMi?: number; source?: string; sampledAt?: string} | undefined;
  const ramBudget = Number(status?.memoryRequiredMi ?? local.memoryRequiredMi ?? 0);
  const vramBudget = Number(status?.vramRequiredMi ?? local.vramMi ?? 0);
  const exceedsBudget = usage && ((ramBudget > 0 && Number(usage.ramMi) > ramBudget) || (vramBudget > 0 && Number(usage.vramMi) > vramBudget));
  return <div className="stack compact">
    <div className="tag-list"><span className="tag">CPU offloading enabled</span><span className="tag">Host RAM reserved: {formatMi(Number(status?.memoryRequiredMi ?? local.memoryRequiredMi))}</span></div>
    {usage ? <p className="muted">Engine-reported buffers: {formatMi(usage.ramMi)} RAM · {formatMi(usage.vramMi)} VRAM. Source: {usage.source}. These are not reservations or total process memory.</p> : <p className="muted">Actual RAM / VRAM split is not currently reported. The values above are reservations, not measured usage.</p>}
    {exceedsBudget && <p className="notice notice-warn">The engine reports more memory than the planned budget. Increase the allocation or reduce model size/context; the Ollama layer split is not a byte-exact VRAM limit.</p>}
  </div>;
};

const FreeTokenStatus = ({status}: {status?: Record<string, unknown>}) => {
  // `freeTokenStats` is normalized by the operator from the version-pinned
  // FreeToken `/v1/stats` schema. Do not reach into the raw response here:
  // that keeps a future upstream schema change from silently changing the UI.
  const stats = asRecord(status?.freeTokenStats);
  const numeric = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const decodeTokensPerSecond = numeric(stats.decodeTokensPerSecond);
  const prefillTokensPerSecond = numeric(stats.prefillTokensPerSecond);
  const tokensPerSecond = numeric(stats.tokensPerSecond) || decodeTokensPerSecond || prefillTokensPerSecond;
  const vramMi = numeric(stats.vramMi);
  const cacheBudgetMi = numeric(stats.cacheBudgetMi);
  const activeRequests = numeric(stats.activeRequests);
  const p95LatencyMs = numeric(stats.p95LatencyMs);
  if (tokensPerSecond <= 0 && vramMi <= 0 && cacheBudgetMi <= 0 && activeRequests <= 0 && p95LatencyMs <= 0) return null;
  return <div className="stack compact">
    <div className="tag-list">
      {tokensPerSecond > 0 && <span className="tag">{tokensPerSecond.toFixed(1)} tokens/s</span>}
      {decodeTokensPerSecond > 0 && prefillTokensPerSecond > 0 && <span className="tag">Decode {decodeTokensPerSecond.toFixed(1)} · Prefill {prefillTokensPerSecond.toFixed(1)}</span>}
      {activeRequests > 0 && <span className="tag">{activeRequests} active request{activeRequests === 1 ? '' : 's'}</span>}
      {p95LatencyMs > 0 && <span className="tag">p95 {Math.round(p95LatencyMs)} ms</span>}
    </div>
    {(vramMi > 0 || cacheBudgetMi > 0) && <p className="muted" title={`${String(stats.source ?? 'FreeToken /v1/stats')}${stats.sampledAt ? ` · ${String(stats.sampledAt)}` : ''}`}>FreeToken runtime: {vramMi > 0 ? `${formatMi(vramMi)} VRAM in use` : 'VRAM unavailable'}{cacheBudgetMi > 0 ? ` · ${formatMi(cacheBudgetMi)} cache budget` : ''}.</p>}
  </div>;
};

const ModelLogsDialog = ({name, onClose}: {name: string; onClose: () => void}) => {
  const query = useQuery({
    queryKey: ['model-logs', name],
    queryFn: () => api.modelLogs(name),
    enabled: Boolean(name),
    refetchInterval: name ? 5_000 : false,
  });
  const copyValue = query.data?.pods.flatMap((pod) => pod.containers.flatMap((container) => container.logs.map((log) => [
    `# ${pod.name} · ${container.name} · ${log.previous ? 'previous' : 'current'}`,
    log.text || log.error || 'No output returned.',
  ].join('\n')))).join('\n\n') ?? '';
  return <Dialog open={Boolean(name)} title={`Runtime logs · ${name}`} description={`Latest ${query.data?.tailLines ?? 300} lines per container. Output may contain model input or other sensitive data.`} onClose={onClose}>
    <div className="stack compact">
      <div className="model-log-toolbar">
        <span className="muted">{query.data ? `Updated ${new Date(query.data.generatedAt).toLocaleTimeString()}` : 'Loading current output…'}</span>
        <div className="actions">{copyValue && <CopyButton value={copyValue} label="Copy all" />}<Button type="button" onClick={() => query.refetch()} disabled={query.isFetching}>{query.isFetching ? 'Refreshing…' : 'Refresh'}</Button></div>
      </div>
      <ErrorNotice error={query.error} />
      {query.isPending && <Loading />}
      {query.data && !query.data.pods.length && <Empty>No runtime Pod exists for this model yet.</Empty>}
      {query.data?.pods.map((pod) => <details className="model-log-pod" key={pod.name} open>
        <summary><strong>{pod.name}</strong><span className="tag">{pod.phase}</span>{pod.node && <span className="tag">Node: {pod.node}</span>}{pod.deleting && <span className="tag">Terminating</span>}</summary>
        <div className="stack compact">
          {pod.containers.map((container) => <section className="model-log-container" key={`${container.kind}:${container.name}`}>
            <header><strong>{container.name}</strong><div className="tag-list"><span className="tag">{container.kind === 'init' ? 'Init container' : 'Container'}</span><span className="tag">{container.state}{container.reason ? ` · ${container.reason}` : ''}</span>{container.restartCount > 0 && <span className="tag">Restarts: {container.restartCount}</span>}</div></header>
            {container.logs.map((log) => <div className="model-log-stream" key={log.previous ? 'previous' : 'current'}>
              <div className="model-log-stream-title"><strong>{log.previous ? 'Previous run' : 'Current run'}</strong>{log.truncated && <span className="tag">Output limited</span>}</div>
              <pre aria-label={`${pod.name} ${container.name} ${log.previous ? 'previous' : 'current'} logs`}>{log.text || log.error || 'No output returned.'}</pre>
            </div>)}
          </section>)}
          {!pod.containers.length && <Empty>This Pod has no declared containers yet.</Empty>}
          {Boolean(pod.omittedContainers) && <p className="muted">{pod.omittedContainers} additional container(s) omitted.</p>}
        </div>
      </details>)}
      {Boolean(query.data?.omittedPods) && <p className="muted">{query.data?.omittedPods} older Pod(s) omitted.</p>}
    </div>
  </Dialog>;
};

export const ModelsPage = ({session}: {session: Session}) => {
  const queryClient = useQueryClient(); const query = useQuery({queryKey: ['models'], queryFn: () => api.models(), refetchInterval: 15_000});
  const [createOpen, setCreateOpen] = useState(false); const [location, setLocation] = useState<'local' | 'external'>('local');
  const [removeTarget, setRemoveTarget] = useState(''); const [editTarget, setEditTarget] = useState(''); const [logsTarget, setLogsTarget] = useState(''); const [runtimeConfirm, setRuntimeConfirm] = useState(false);
  const mutable = canMutateRuntime(session); const admin = canAdminister(session); const refresh = async () => { await queryClient.invalidateQueries({queryKey: ['models']}); };
  const removeMutation = useMutation({mutationFn: (name: string) => api.removeModel(name), onSuccess: async () => { setRemoveTarget(''); await refresh(); }});
  const lifecycleMutation = useMutation({
    mutationFn: ({name, action, expectedRevision}: {name: string; action: ModelLifecycleAction; expectedRevision: string}) => api.request<{activation?: ModelActivation}>(
      `/api/models/${encodeURIComponent(name)}/${action}`,
      {method: 'POST', body: JSON.stringify({expectedRevision})},
    ),
    retry: false,
    onMutate: () => queryClient.cancelQueries({queryKey: ['models']}),
    onSuccess: async (result, {name}) => {
      // Use the server-confirmed desired state immediately. The reconciler's
      // status may still describe the previous run until its next inspection.
      if (result?.activation?.metadata?.name === name) {
        const updated = result.activation;
        queryClient.setQueryData<ModelsPayload>(['models'], (current) => current && ({
          ...current, activations: current.activations.map((item) => item.metadata?.name === name ? updated : item),
        }));
      }
      await refresh();
    },
  });
  const runtimeMutation = useMutation({mutationFn: () => api.removeLocalRuntime(), onSuccess: async () => { setRuntimeConfirm(false); await refresh(); }});
  if (query.error) return <ErrorNotice error={query.error} />; if (query.isPending || !query.data) return <Loading />;

  const activations = query.data.activations; const activationNames = new Set(activations.map((item) => item.metadata?.name).filter(Boolean));
  const editActivation = activations.find((item) => item.metadata?.name === editTarget);
  const registered = (query.data.models ?? []).filter((item) => !activationNames.has(item.id));
  const localModels = activations.filter((activation) => activation.spec?.type === 'local' && (activation.spec?.enabled !== false || activation.metadata?.deletionTimestamp || activation.status?.phase === 'Removing'));
  const runtimeModules = query.data.modules as Record<string, {enabled?: boolean; autoEnabled?: boolean}> | undefined;
  const showRuntimeRemoval = mutable && localModels.length === 0 && ['gpu', 'kubeai', 'freetoken'].some((id) => runtimeModules?.[id]?.enabled && runtimeModules[id]?.autoEnabled);

  return <div className="stack">
    <div className="section-title"><div><h2>Models</h2><p>Local inference and external OpenAI-compatible providers.</p></div></div>
    <ComputeMemory memory={query.data.computeMemory} />
    <div className="section-title"><div><h2>Installed Models</h2><p>{activations.length + registered.length} model{activations.length + registered.length === 1 ? '' : 's'}</p></div>{mutable && <Button variant="primary" onClick={() => setCreateOpen(true)}>Create</Button>}</div>
    <div className="stack compact">{activations.map((activation) => {
      const local = activation.spec?.local as Record<string, unknown> | undefined; const external = activation.spec?.external as Record<string, unknown> | undefined;
      const phase = activation.metadata?.deletionTimestamp ? 'Removing' : activation.status?.phase ?? (activation.spec?.enabled === false ? 'Disabled' : 'Requested');
      const target = String(activation.status?.computeTarget ?? local?.computeTarget ?? (local ? 'nvidia-gpu' : 'external'));
      const isCpu = target === 'cpu';
      const engine = local?.realtime ? 'vLLM-Omni' : String(activation.status?.engine ?? local?.engine ?? 'VLLM');
      const activationName = String(activation.metadata?.name ?? '');
      const phaseName = String(phase).toLowerCase();
      const stopped = activation.spec?.enabled === false;
      const stopping = stopped && !['disabled', 'stopped'].includes(phaseName);
      const lifecycleControls = mutable && Boolean(local || external) && !activation.metadata?.deletionTimestamp;
      const lifecycleBusy = lifecycleMutation.isPending || removeMutation.isPending || runtimeMutation.isPending;
      const pendingAction = lifecycleMutation.isPending && lifecycleMutation.variables?.name === activationName ? lifecycleMutation.variables.action : undefined;
      const lifecycleDisabled = lifecycleBusy || stopping || phaseName === 'removing' || !modelEditRevision(activation);
      const lifecycleHint = stopping ? 'Waiting for this model to finish stopping.'
        : external ? 'Start or stop this provider route in Magic Stick. The remote provider itself is not shut down.'
        : stopped ? 'Start the model with its saved settings.'
        : isFreeTokenEngine(engine) ? 'Stop the model and release its runtime resources. Saved settings are kept; temporary model downloads are cleared and may need to be downloaded again.'
        : 'Stop the model and release its runtime resources. Saved settings are kept.';
      const runLifecycle = (action: ModelLifecycleAction) => lifecycleMutation.mutate({
        name: activationName,
        action,
        expectedRevision: modelEditRevision(activation),
      });
      const freeToken = isFreeTokenEngine(engine) ? asRecord(local?.freetoken) : {};
      const freeTokenAdvanced = asRecord(freeToken.advanced);
      const freeTokenContext = local?.contextWindow ?? freeTokenAdvanced.contextWindow;
      const freeTokenMaxRequests = local?.maxNumSeqs ?? freeTokenAdvanced.maxNumSeqs;
      const freeTokenGpuCount = boundedInteger(freeToken.gpuCount, 1);
      return <Panel key={activation.metadata?.name} title={activation.metadata?.name ?? 'unnamed'} meta={`${activation.spec?.type ?? (local ? 'local' : 'external')} · ${String(local?.modelType ?? external?.modelType ?? 'chat')}`} actions={<StatusBadge phase={phase} />}>
        <div className="tag-list">{local && <><span className="tag">Compute: {target}</span><span className="tag">Engine: {engine}</span>{(activation.status?.artifact || local.artifact) && <span className="tag">Artifact: {String(activation.status?.artifact ?? local.artifact)}</span>}{(activation.status?.format || local.format) && <span className="tag">Format: {String(activation.status?.format ?? local.format)}</span>}{(activation.status?.quantization || local.quantization) && <span className="tag">Quantization: {quantizationText(activation.status?.quantization ?? local.quantization)}</span>}{isFreeTokenEngine(engine) ? <><span className="tag">GPU node: {freeTokenNodeName(freeToken.gpuDevice) || 'pending'}</span><span className="tag">GPUs: {freeTokenGpuCount}</span><span className="tag">GPU memory: {freeToken.gpuMemoryMi ? `${formatMi(parseMemoryMi(freeToken.gpuMemoryMi))} total` : 'default'}</span><span className="tag">System RAM: {freeToken.systemMemoryMi ? formatMi(parseMemoryMi(freeToken.systemMemoryMi)) : 'default'}</span><span className="tag">Strategy: {freeTokenStrategyLabels[String(freeToken.memoryStrategy) as FreeTokenMemoryStrategy] ?? String(freeToken.memoryStrategy ?? 'auto')}</span><span className="tag">Context: {String(freeTokenContext ?? 'default')}</span><span className="tag">Max requests: {String(freeTokenMaxRequests ?? 'default')}</span></> : local.realtime ? <><span className="tag">Profile: vLLM-Omni Realtime</span><span className="tag">Compute node: {String(asRecord(local.realtime).gpuNode ?? 'pending')}</span>{!isCpu && <span className="tag">GPUs: {String(asRecord(local.realtime).gpuCount ?? 1)}</span>}<span className="tag">Context: {String(local.contextWindow ?? 8192)}</span><span className="tag">System RAM: {formatMi(Number(asRecord(local.realtime).systemMemoryMi ?? 16384))}</span></> : <><span className="tag">KV requested: {String(activation.status?.requestedKvCacheType ?? local.kvCacheType ?? (String(local.engine ?? 'VLLM') === 'OLlama' ? 'f16' : 'auto'))}</span><span className="tag">KV active: {String(activation.status?.effectiveKvCacheType || 'pending confirmation')}</span><span className="tag">{isCpu ? 'RAM' : 'VRAM'}: {isCpu ? formatMi(Number(activation.status?.memoryRequiredMi ?? local.memoryRequiredMi)) : activation.status?.vramRequiredMi ? formatMi(Number(activation.status.vramRequiredMi)) : String(local.vram ?? 'default')}</span><span className="tag">Context: {String(local.contextWindow ?? 'default')}</span><span className="tag">Max seqs: {String(local.maxNumSeqs ?? 'default')}</span></>}<span className="tag">Target: {String(activation.spec?.targetNamespace ?? 'ai')}</span></>}{external && <><span className="tag">Provider: {String(external.model ?? 'external')}</span><span className="tag">Context: {String(external.contextWindow ?? 'default')}</span></>}</div>
        <ProgressBar phase={phase} enabled={activation.spec?.enabled !== false} message={activation.status?.message} />
        {activation.status?.gpuSharing && <div className="tag-list"><span className="tag" title={activation.status.gpuSharing.mode === 'exclusive' ? 'Exclusive GPU allocation.' : `Shared GPU access; no isolated GPU memory limit.${activation.status.gpuSharing.claimName ? ` Claim: ${activation.status.gpuSharing.claimName}` : ''}`}>GPU allocation: {activation.status.gpuSharing.mode === 'dra-shared' ? 'Shared · DRA' : activation.status.gpuSharing.mode === 'time-slicing' ? 'Shared · Time-slicing' : 'Exclusive'}</span><span className="tag">GPU node: {activation.status.gpuSharing.node}{activation.status.gpuSharing.device ? ` · ${activation.status.gpuSharing.device}` : ''}</span></div>}
        {local && (isFreeTokenEngine(engine) ? <FreeTokenStatus status={activation.status} /> : <OffloadingStatus local={local} status={activation.status} />)}
        <p className="muted">{String(activation.status?.message ?? activation.status?.modelRef ?? 'Waiting for catalog registration.')}</p>
        <div className="actions">
          {mutable && <Button type="button" disabled={lifecycleBusy || stopping || phaseName === 'removing'} onClick={() => setEditTarget(activationName)} aria-label={`Edit ${activationName || 'model'}`}>Edit</Button>}
          {lifecycleControls && <>
            {!stopped && local && (isFreeTokenEngine(engine) || Boolean(local.realtime)) && <Button type="button" disabled={lifecycleDisabled} onClick={() => runLifecycle('restart')} aria-label={`Restart ${activationName}`}>{pendingAction === 'restart' ? 'Restarting…' : 'Restart'}</Button>}
            <Button type="button" variant={stopped ? 'default' : 'ghost'} disabled={lifecycleDisabled} title={lifecycleHint}
              onClick={() => runLifecycle(stopped ? 'start' : 'stop')} aria-label={`${stopped ? 'Start' : 'Stop'} ${activationName}`}>
              {pendingAction === 'start' ? 'Starting…' : pendingAction === 'stop' || stopping ? 'Stopping…' : stopped ? 'Start' : 'Stop'}
            </Button>
          </>}
          {admin && local && <Button type="button" onClick={() => setLogsTarget(activationName)} aria-label={`View logs for ${activationName || 'model'}`}>Logs</Button>}
          {mutable && <Button variant="danger" disabled={lifecycleBusy || phaseName === 'removing'} onClick={() => setRemoveTarget(activationName)}>{phaseName === 'removing' ? 'Removing' : 'Remove'}</Button>}
        </div>
      </Panel>;
    })}
    {registered.length > 0 && <Panel title="Registered Models" meta={`${registered.length} catalog entr${registered.length === 1 ? 'y' : 'ies'}`}>{registered.map((model) => <article className="list-row" key={model.id ?? model.name}><div><strong>{model.id ?? model.name ?? 'unnamed'}</strong><p>{model.modelRef ?? 'catalog'} · {model.provider ?? model.source ?? 'registered'}</p></div><StatusBadge phase="Registered" /></article>)}</Panel>}
    {!activations.length && !registered.length && <Empty>No models registered yet.</Empty>}</div>
    {showRuntimeRemoval && <Button variant="danger" disabled={lifecycleMutation.isPending || runtimeMutation.isPending} onClick={() => setRuntimeConfirm(true)}>Remove Local Inference Runtime</Button>}
    <ErrorNotice error={removeMutation.error ?? lifecycleMutation.error ?? runtimeMutation.error} />
    <Dialog open={createOpen} title="Create Model" description="Choose local inference or an external model provider." onClose={() => setCreateOpen(false)}><div className="stack"><Field label="Location"><select value={location} onChange={(event) => setLocation(event.target.value as typeof location)}><option value="local">Local</option><option value="external">External</option></select></Field>{location === 'local' ? <LocalModelForm models={query.data} onClose={() => setCreateOpen(false)} onCreated={refresh} /> : <ExternalModelForm onClose={() => setCreateOpen(false)} onCreated={refresh} />}</div></Dialog>
    <EditModelDialog key={editTarget} activation={editActivation} models={query.data} onClose={() => setEditTarget('')} onUpdated={refresh} />
    <ModelLogsDialog name={logsTarget} onClose={() => setLogsTarget('')} />
    <ConfirmDialog key={removeTarget} open={Boolean(removeTarget)} title="Remove model" description={`Remove ${removeTarget}? The model runtime and generated catalog entry will be reconciled away.`} confirmLabel="Remove" busy={removeMutation.isPending} error={removeMutation.error} onClose={() => setRemoveTarget('')} onConfirm={() => removeMutation.mutate(removeTarget)} />
    <ConfirmDialog key={String(runtimeConfirm)} open={runtimeConfirm} title="Remove local inference runtime" description="Remove automatically installed local inference runtime modules after the last local model has gone? Manually managed modules are preserved." confirmLabel="Remove Runtime" busy={runtimeMutation.isPending} error={runtimeMutation.error} onClose={() => setRuntimeConfirm(false)} onConfirm={() => runtimeMutation.mutate()} />
  </div>;
};
