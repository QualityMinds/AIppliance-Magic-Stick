// Memory presentation of the Models area: compute memory readings and slot pools
// (apps/web/src/ComputeMemory.tsx, GpuSlots.tsx), the estimate, breakdown and system RAM
// panels of the model form (ModelMemorySettings.tsx) and the calculation explanations (MemoryInfo.tsx).
import {formatBytes, formatMi} from '@magicstick/dashboard-core';
import type {
  ComputeMemoryDevice, GpuSlots, MemoryCalculation, MemoryEstimate, ModelsPayload, SharedMemoryPool,
} from '@magicstick/dashboard-contracts';
import type {TuiContext} from './tui-context';
import type {DialogItem} from './tui-dialogs';
import {fit, gap, prose, span, type Row} from './tui-screen';

export const roundMemory = (value: number) => Math.max(100, Math.ceil(value / 100) * 100);
export const quantizationText = (value: unknown) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  const item = value as {label?: string; method?: string; bits?: number};
  return item.label ?? [item.method, item.bits ? `${item.bits}-bit` : ''].filter(Boolean).join(' ');
};

const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const amount = (value?: number | null) => known(value) ? value : null;
const capacity = (value?: number | null) => known(value) && value > 0 ? value : null;
const within = (value: number | null, maximum: number | null) => value !== null && maximum !== null ? Math.min(value, maximum) : null;
/** Unknown or stale telemetry stays "not reported", never zero. */
export const reported = (value?: number | null) => known(value) ? formatMi(value) : 'Not reported';

// ---------------------------------------------------------------- slots

export const targetSlots = (target: {engineAvailability?: Record<string, {slots?: GpuSlots}>; slots?: GpuSlots} | undefined, engine: string) =>
  target?.engineAvailability?.[engine]?.slots ?? target?.slots;
export const slotsFull = (target: Parameters<typeof targetSlots>[0], engine: string) => targetSlots(target, engine)?.free === 0;

/** Presentation groups only: the API remains the authority for slot counts. */
export const sharedSlotPools = (devices: ComputeMemoryDevice[]) => {
  const groups = new Map<string, {key: string; name: string; slots: GpuSlots; deviceIds: string[]}>();
  for (const device of devices) {
    const slots = device.slots;
    if (device.kind !== 'gpu' || !slots || slots.scope === 'device' || !slots.scope) continue;
    const node = slots.node ?? (device.nodes?.length === 1 ? device.nodes[0] : undefined);
    // An unidentified node pool cannot be safely merged with another node.
    if (slots.scope === 'node' && !node) continue;
    const target = device.computeTarget ?? device.vendor ?? device.id;
    const key = JSON.stringify([target, slots.scope, slots.scope === 'node' ? node : '']);
    const group = groups.get(key);
    if (group) group.deviceIds.push(device.id);
    else groups.set(key, {key, name: `${device.vendor ? `${device.vendor.toUpperCase()} GPU` : target} pool${node ? ` · ${node}` : ''}`, slots, deviceIds: [device.id]});
  }
  return [...groups.values()].filter((group) => group.deviceIds.length > 1);
};

const slotLegend = (slots: GpuSlots) =>
  `${slots.scope === 'node' ? 'Node slots' : slots.scope === 'target' ? 'Target slots' : 'Slots'}: ${slots.free} / ${slots.total} free`;
const slotNotes = (slots: GpuSlots) => [
  `${slots.used} occupied, ${slots.free} free, ${slots.total} total. Slots are shared by Ollama and vLLM, independently of RAM or VRAM. Starting models reserve slots too. A managed model and its pod are counted only once; other GPU workloads also consume slots. Deleting a model releases its slot after its pod stops.`,
  ...(slots.scope !== 'device' ? ['This is a shared scheduling pool, not a confirmed assignment to an individual GPU. Models without a confirmed node are counted conservatively in node views.'] : []),
  ...(slots.queued ? [`${slots.queued} additional slot requests are waiting.`] : []),
];

// ---------------------------------------------------------------- gauges

type Reading = {id: string; label: string; valueMi: number | null; totalMi: number | null};
type Group = {label: string; totalMi: number | null; readings: Reading[]};

/** The browser gauge's readings: free and unreserved per allocation domain, never mixing domains. */
export const gaugeReadings = (device: ComputeMemoryDevice, pool?: SharedMemoryPool) => {
  const cpu = device.kind === 'cpu' || device.computeTarget === 'cpu';
  const sharedGpu = device.memoryArchitecture === 'unified' && !cpu;
  const total = capacity(device.totalMi);
  const free = device.metricsAvailable === false ? null : amount(device.freeMi);
  const unreserved = amount(device.unreservedMi);
  const reading = (id: string, label: string, valueMi: number | null, totalMi: number | null): Reading => ({id, label, valueMi, totalMi});
  if (!sharedGpu) {
    const freeTotal = cpu && device.memoryArchitecture === 'unified' ? capacity(device.sharedMemoryMi) ?? total : total;
    const readings = [reading('free', 'Free', free, freeTotal), reading('unreserved', 'Unreserved', unreserved, freeTotal)];
    return {sharedGpu, groups: [{label: cpu ? 'RAM' : 'VRAM', totalMi: freeTotal, readings}] as Group[],
      primary: free !== null ? free : unreserved, primaryLabel: free !== null ? 'actually free' : unreserved !== null ? 'unreserved budget' : 'not reported'};
  }
  const mode = device.gpuAllocationMode && pool?.gpuAllocationMode && device.gpuAllocationMode !== pool.gpuAllocationMode
    ? 'unknown' : device.gpuAllocationMode ?? pool?.gpuAllocationMode ?? 'unknown';
  const fixed = mode === 'firmware-reserved';
  const dynamic = mode === 'shared-gtt';
  const dedicatedTotal = amount(pool?.firmwareReservedMi) ?? (fixed ? total : null);
  const sharedTotal = within(capacity(pool?.gpuAccessibleMi), capacity(pool?.physicalMemoryMi));
  const dedicatedFree = within(amount(pool?.dedicatedFreeMi) ?? (fixed ? free : null), dedicatedTotal);
  const dedicatedBudget = fixed ? within(unreserved ?? amount(pool?.gpuUnreservedMi), dedicatedTotal) : null;
  const sharedFree = within(amount(pool?.sharedFreeMi), sharedTotal);
  const linuxBudget = amount(pool?.unreservedMi);
  const dynamicBudget = amount(pool?.gpuUnreservedMi) ?? (dynamic ? unreserved : null);
  const sharedBudget = fixed ? within(linuxBudget, sharedTotal)
    : dynamic && linuxBudget !== null && dynamicBudget !== null ? within(Math.min(linuxBudget, dynamicBudget), sharedTotal) : null;
  const groups: Group[] = [
    {label: 'Dedicated', totalMi: dedicatedTotal, readings: [reading('dedicated-free', 'Free', dedicatedFree, dedicatedTotal), reading('dedicated-unreserved', 'Unreserved', dedicatedBudget, dedicatedTotal)]},
    {label: 'Shared', totalMi: sharedTotal, readings: [reading('shared-free', 'Free', sharedFree, sharedTotal), reading('shared-unreserved', 'Unreserved', sharedBudget, sharedTotal)]},
  ];
  const activeFree = fixed ? dedicatedFree : dynamic ? sharedFree : null;
  const activeBudget = fixed ? dedicatedBudget : dynamic ? sharedBudget : null;
  return {sharedGpu, groups, primary: activeFree ?? activeBudget,
    primaryLabel: activeFree !== null ? `${fixed ? 'dedicated' : 'shared'} free` : activeBudget !== null ? `${fixed ? 'dedicated' : 'shared'} unreserved` : 'not reported'};
};

const meter = (value: number | null, total: number | null, size = 16) => {
  if (value === null || total === null || total <= 0) return '╌'.repeat(size);
  const filled = Math.round(Math.min(1, value / total) * size);
  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)}`;
};

const gaugeDetails = (device: ComputeMemoryDevice, pool: SharedMemoryPool | undefined, sharedGpu: boolean) => [
  'Free means currently available memory; unreserved means remaining planning budget, not measured free memory. A dashed bar and "Not reported" mean not reported, not zero.',
  ...(sharedGpu ? [
    'One GPU, not two deployment targets. Dedicated and shared readings have separate scales and are not added into one model capacity.',
    `Installed RAM ${reported(pool?.installedMemoryMi)} · Fixed GPU reservation ${reported(pool?.firmwareReservedMi)} · Linux-visible RAM ${reported(pool?.physicalMemoryMi)} · Dynamic GPU ceiling ${reported(pool?.gpuAccessibleMi)} · Driver-reported model capacity ${reported(device.gpuCapacityMi)}.`,
    'Dedicated free requires live GPU metrics. Linux available RAM is never reported as free dedicated VRAM. Dedicated unreserved is the planning capacity minus GPU model reservations, only when the driver confirms that allocation domain.',
    'Shared free = min(Linux MemAvailable, dynamic GPU ceiling − driver-reported GTT usage), never below zero. GPU allocations are already reflected in MemAvailable and are not subtracted from it again. Shared unreserved = min(remaining Linux RAM budget after system headroom and model requests, dynamic ceiling); when models use the shared pool, its remaining GPU budget also applies.',
    `Host counters refresh every 30 seconds. Missing or older-than-90-second samples are not reported as free memory.${pool?.memorySampledAt ? ` Sample: ${pool.memorySampledAt}.` : ''}`,
    'Shared RAM is also used by the CPU. Neither its ceiling nor Kubernetes requests protect it against other processes. These readings do not change hardware configuration or the model\'s allocation domain.',
  ] : [`Unreserved shows remaining planning capacity, Free the current availability. ${device.memoryArchitecture === 'unified' ? 'Both use Linux-visible RAM as their scale. Unreserved memory excludes system headroom and includes host runtime requests. Firmware-reserved GPU memory is outside this RAM.' : 'Both use the reported device capacity.'}`]),
  ...(device.memoryArchitecture === 'unified' ? [device.accountingVerified ? 'GPU memory accounting verified.' : 'GPU memory accounting not yet verified; driver capacity is not an engine allocation guarantee.'] : []),
  ...[...new Set([device.message, device.warning].filter(Boolean) as string[])],
  ...(device.metricsSource ? [`Metrics source: ${device.metricsSource}.`] : []),
  ...(device.slots && device.kind === 'gpu' ? slotNotes(device.slots) : []),
];

/**
 * The compute memory panel body: slot pools, the physical layout of shared-memory nodes,
 * then one block per device with its free and unreserved readings. Details expand per device.
 */
export const computeMemoryRows = (memory: ModelsPayload['computeMemory'], width: number, expanded: Record<string, boolean>): Row[] => {
  const devices: ComputeMemoryDevice[] = memory?.devices?.length ? memory.devices : [{id: 'cpu-unavailable', name: 'CPU', kind: 'cpu'}];
  const pools = sharedSlotPools(devices);
  const pooled = new Set(pools.flatMap((pool) => pool.deviceIds));
  const rows: Row[] = [];
  for (const pool of pools) {
    rows.push(fit(width, [span(pool.name, undefined, true)], [span(slotLegend(pool.slots), 'accent')]));
    rows.push(...prose(width - 2, 'Kubernetes assigns a card from this pool. These slots are counted once, not separately on every card.', 'dim').map((row) => [gap(2), ...row]));
  }
  for (const pool of memory?.sharedPools ?? []) {
    rows.push(...[
      `${pool.node}: installed RAM ${formatMi(pool.installedMemoryMi)} / fixed GPU reservation ${formatMi(pool.firmwareReservedMi)}`,
      `  Linux RAM ${formatMi(pool.physicalMemoryMi)} / dynamic GPU ceiling ${formatMi(pool.gpuAccessibleMi)} (within Linux RAM, not extra)`,
      `  One GPU: driver capacity ${formatMi(pool.gpuCapacityMi)} / allocation ${pool.gpuAllocationMode ?? 'unknown'} / source ${pool.gpuCapacitySource ?? 'unavailable'}`,
      '  Dynamic memory is not a protected reservation. Firmware and dynamic limits are not added.',
    ].flatMap((line) => prose(width, line)));
  }
  for (const original of devices) {
    const device = pooled.has(original.id) ? {...original, slots: undefined} : original;
    const pool = memory?.sharedPools?.find((item) => item.id === device.sharedPoolId);
    const gauge = gaugeReadings(device, pool);
    const name = device.name ?? device.id;
    const key = `memory:${device.id}`;
    const open = expanded[key] ?? false;
    rows.push(fit(width, [span(`${name}: ${formatMi(device.freeMi)} ${device.gpuAllocationMode === 'shared-gtt' ? 'shared RAM available' : 'free'} / ${formatMi(device.unreservedMi)} unreserved / ${formatMi(device.totalMi)} ${device.memoryArchitecture === 'unified' ? 'budgetable' : 'total'}`, undefined, true)],
      [span(`${gauge.primary === null ? '—' : formatMi(gauge.primary)} ${gauge.primaryLabel}`, gauge.primary === null ? 'dim' : 'accent')]));
    for (const group of gauge.groups) {
      for (const reading of group.readings) {
        rows.push([gap(2), span(`${group.label} ${reading.label}`.padEnd(22), 'dim'), span(meter(reading.valueMi, reading.totalMi), reading.valueMi === null ? 'dim' : 'accent'),
          span(`  ${reading.valueMi === null ? 'Not reported' : formatMi(reading.valueMi)}${group.totalMi !== null ? ` of ${formatMi(group.totalMi)}` : ''}`)]);
      }
    }
    if (device.kind === 'gpu' && device.slots) rows.push([gap(2), span(slotLegend(device.slots), 'accent')]);
    if (device.memoryArchitecture === 'unified') rows.push(...prose(width - 2, `Only host runtime and dynamic GPU allocations are charged to Linux RAM; GPU accounting ${device.accountingVerified ? 'verified.' : 'not verified.'}`, 'dim').map((row) => [gap(2), ...row]));
    rows.push([gap(2), {text: `${open ? '▼' : '►'} Memory details`, action: {id: `expand:${key}`, label: open ? 'Collapse' : 'Expand'}}]);
    if (open) rows.push(...gaugeDetails(device, pool, gauge.sharedGpu).flatMap((line) => prose(width - 4, line, 'dim').map((row) => [gap(4), ...row])));
  }
  return rows;
};

// ---------------------------------------------------------------- calculation explanations

export interface CalculationEntry {
  label: string;
  value: string;
  calculation?: MemoryCalculation | null;
  roundedMi?: number;
  perDeviceMi?: number;
  budgetDevices?: number;
}

export const unreservedCalculation = (availableMi?: number | null, budgetDevices = 1): MemoryCalculation => budgetDevices > 1 ? ({
  formula: 'total group budget = selected GPU count × floor(smallest selected GPU unreserved MiB ÷ 100) × 100',
  substitution: availableMi !== null && availableMi !== undefined ? `${budgetDevices} × floor(${availableMi.toLocaleString('en-US')} ÷ 100) × 100 = ${(budgetDevices * Math.floor(availableMi / 100) * 100).toLocaleString('en-US')} MiB` : 'Unreserved capacity is unknown for at least one selected GPU.',
  notes: ['The total budget is divided equally across the selected GPUs. The least unreserved card bounds every share; this is not a sum of unequal capacities or memory across nodes.', 'Unreserved capacity subtracts existing reservations, not current usage. Other workloads can still consume VRAM.'],
}) : ({
  formula: 'device/node capacity − existing reservations; slider maximum = floor(unreserved MiB ÷ 100) × 100',
  substitution: availableMi !== null && availableMi !== undefined ? `floor(${availableMi.toLocaleString('en-US')} ÷ 100) × 100 = ${(Math.floor(availableMi / 100) * 100).toLocaleString('en-US')} MiB` : 'Unreserved capacity is unknown.',
  notes: ['Unreserved capacity is not the same as currently unused memory. Other workloads can consume RAM/VRAM. Capacity is per eligible device/node, not a sum across nodes.'],
});

/** The browser's per-value calculation popovers, as one scrollable list. */
export const showCalculations = (ctx: TuiContext, title: string, entries: CalculationEntry[]) => ctx.viewer({
  title,
  description: 'How each value is calculated. These are estimates, not measured memory usage.',
  lines: () => [
    ...entries.flatMap((entry) => {
      const explanation = entry.calculation ?? {formula: 'Calculation details are unavailable from this API response.', notes: ['This value is an estimate, not measured memory usage.']};
      const devices = entry.budgetDevices ?? 1;
      return [
        {text: `${entry.label}: ${entry.value}`, bold: true},
        {text: `${devices > 1 ? 'Formula per GPU' : 'Formula'}: ${explanation.formula}`},
        ...(explanation.substitution ? [{text: `With your values: ${explanation.substitution}`, tone: 'accent' as const}] : []),
        ...(explanation.notes ?? []).map((text) => ({text, tone: 'dim' as const})),
        ...(devices > 1 && entry.perDeviceMi !== undefined ? [{text: `Total for ${devices} GPUs: ${devices} × ${entry.perDeviceMi.toLocaleString('en-US')} MiB = ${(devices * entry.perDeviceMi).toLocaleString('en-US')} MiB.`, tone: 'dim' as const}] : []),
        ...(entry.roundedMi !== undefined ? [{text: `${devices > 1 ? 'Total UI budget' : 'UI budget'}: ${devices > 1 ? `${devices} × ` : ''}max(100, ceil(${entry.roundedMi.toLocaleString('en-US')} ÷ 100) × 100) = ${(devices * Math.max(100, Math.ceil(entry.roundedMi / 100) * 100)).toLocaleString('en-US')} MiB. Reservation budgets round up to 100 MiB per device; compact GiB labels are display rounding only.`, tone: 'dim' as const}] : []),
        {text: ''},
      ];
    }),
    {text: '1 MiB = 1,048,576 bytes · 1 GiB = 1,024 MiB.', tone: 'dim'},
  ],
}, true);

// ---------------------------------------------------------------- estimate panels

/** A text version of the browser's capacity scale: selected fill, unreserved area and markers. */
export const capacityScale = (selectedMi: number, minimum: number, recommended: number, maximum: number, capacityKnown: boolean, size = 50) => {
  const scale = Math.max(100, maximum, minimum, recommended, selectedMi);
  const position = (value: number) => Math.min(size - 1, Math.max(0, Math.round(value / scale * size) - 1));
  const cells: string[] = Array.from({length: size}, (_, index) => {
    const value = (index + 1) / size * scale;
    return value <= selectedMi + scale / size / 2 ? '█' : capacityKnown && value <= maximum ? '░' : '·';
  });
  cells[position(minimum)] = 'm';
  cells[position(recommended)] = 'R';
  if (capacityKnown) cells[position(maximum)] = '|';
  return `[${cells.join('')}]`;
};

export interface BreakdownMetric {
  label: string;
  key: string;
  mi?: number;
  multiplier?: number;
  value?: string;
}

/** The browser's "Breakdown" details: what the estimate consists of. */
export const breakdownMetrics = (estimate: MemoryEstimate, budgetDevices = 1) => {
  const offloading = estimate.offloading;
  const runtime = estimate.runtimeDetails ?? {};
  const kvBudgetMi = Number(estimate.kvCacheMi ?? 0);
  const hasTheoreticalKv = estimate.theoreticalKvCacheMi !== null && estimate.theoreticalKvCacheMi !== undefined;
  const baseKvMi = Number(hasTheoreticalKv ? estimate.theoreticalKvCacheMi : kvBudgetMi);
  const hybridSafetyMi = Number(estimate.hybridAllocatorSafetyMi ?? Math.max(0, kvBudgetMi - baseKvMi));
  const attentionKvMi = Number(runtime.attentionKvCacheMi ?? 0);
  const recurrentStateMi = Number(runtime.recurrentStateMi ?? 0);
  const auxiliaryCacheMi = Number(runtime.auxiliaryCacheMi ?? 0);
  const kvSavingsMi = Number(estimate.kvCacheSavingsMi ?? 0);
  const detailedCache = attentionKvMi > 0 || recurrentStateMi > 0 || auxiliaryCacheMi > 0;
  const runtimeParts = [
    {label: 'Compile / warm-up', key: 'compileReserveMi', value: Number(runtime.compileReserveMi ?? 0)},
    {label: 'Multimodal processor cache', key: 'multimodalReserveMi', value: Number(runtime.multimodalReserveMi ?? 0)},
    {label: 'Quantization working copy', key: 'unpackReserveMi', value: Number(runtime.unpackReserveMi ?? 0)},
    {label: 'Engine runtime reserve', key: 'engineRuntimeReserveMi', value: Number(runtime.engineRuntimeReserveMi ?? 0)},
    {label: 'Uneven GPU placement allowance', key: 'partitionReserveMi', value: Number(runtime.partitionReserveMi ?? 0)},
  ].filter((item) => item.value > 0);
  const explainedRuntimeMi = runtimeParts.reduce((total, item) => total + item.value, 0);
  const otherRuntimeMi = Math.max(0, Number(estimate.reserveMi ?? 0) - explainedRuntimeMi);
  const gpuMetric = (label: string, key: string, mi?: number | null): BreakdownMetric => ({label, key,
    mi: typeof mi === 'number' && Number.isFinite(mi) ? mi : undefined, value: formatMi(mi), multiplier: budgetDevices});
  const hostMetric = (label: string, key: string, mi?: number | null): BreakdownMetric => ({label, key,
    mi: typeof mi === 'number' && Number.isFinite(mi) ? mi : undefined, value: formatMi(mi), multiplier: 1});
  const cards: BreakdownMetric[] = offloading ? [
    gpuMetric('Weights · GPU', 'weightsOnGpuMi', offloading.weightsOnGpuMi),
    gpuMetric('Weights · RAM', 'weightsOnCpuMi', offloading.weightsOnCpuMi),
    gpuMetric('KV budget · GPU', 'kvOnGpuMi', offloading.kvOnGpuMi),
    gpuMetric('KV upper bound · RAM', 'kvOnCpuMi', offloading.kvOnCpuMi),
    gpuMetric('GPU runtime reserve', 'reserveMi', estimate.reserveMi),
    gpuMetric('GPU recommended headroom', 'recommendedReserveMi', estimate.recommendedReserveMi),
    ...(!estimate.systemMemory ? [
      hostMetric('Host runtime reserve', 'hostRuntimeMi', offloading.hostRuntimeMi),
      hostMetric('RAM startup headroom', 'ramHeadroomMi', offloading.ramRecommendedMi - offloading.ramMinimumMi),
    ] : []),
    {label: 'Download (disk / network)', key: 'downloadBytes', value: formatBytes(estimate.downloadBytes)},
  ] : [
    gpuMetric('Weights', 'weightsMi', estimate.weightsMi),
    ...(detailedCache ? [
      gpuMetric('Attention KV cache', 'attentionKvCacheMi', attentionKvMi),
      ...(recurrentStateMi > 0 ? [gpuMetric('Recurrent state cache', 'recurrentStateMi', recurrentStateMi)] : []),
      ...(auxiliaryCacheMi > 0 ? [gpuMetric('Auxiliary attention caches', 'auxiliaryCacheMi', auxiliaryCacheMi)] : []),
    ] : [gpuMetric(hasTheoreticalKv ? 'Theoretical KV cache' : 'Estimated KV cache', hasTheoreticalKv ? 'theoreticalKvCacheMi' : 'kvCacheMi', baseKvMi)]),
    ...(hybridSafetyMi > 0 ? [gpuMetric('Hybrid allocator safety', 'hybridAllocatorSafetyMi', hybridSafetyMi)] : []),
    ...(kvSavingsMi > 0 ? [gpuMetric('KV cache saving vs F16', 'kvCacheSavingsMi', kvSavingsMi)] : []),
    ...runtimeParts.map((item) => gpuMetric(item.label, item.key, item.value)),
    ...(otherRuntimeMi > 0 ? [gpuMetric('Other runtime reserve', 'otherRuntimeMi', otherRuntimeMi)] : []),
    ...(Number(estimate.recommendedReserveMi ?? 0) > 0 ? [gpuMetric('Recommended headroom', 'recommendedReserveMi', estimate.recommendedReserveMi)] : []),
    {label: 'Download (disk / network)', key: 'downloadBytes', value: formatBytes(estimate.downloadBytes)},
  ];
  const calculations: Record<string, MemoryCalculation> = {...estimate.calculations, otherRuntimeMi: {
    formula: 'total runtime reserve − runtime components itemized above',
    substitution: `${Number(estimate.reserveMi ?? 0)} − ${explainedRuntimeMi} = ${otherRuntimeMi} MiB`,
    notes: ['This is the unitemized remainder, not another reserve added to the total.'],
  }};
  const notes = [
    ...(budgetDevices > 1 ? [`Breakdown totals cover all ${budgetDevices} selected GPUs, matching the total VRAM reservation above. Host RAM and download size remain separate.`] : []),
    ...(offloading ? ['Planning estimates, not measured usage. Host RAM includes offloaded weights and runtime. Ollama uses GPU-first auto-fit; its displayed weight/cache split is proportional and the exact placement is confirmed only after loading. vLLM weight offloading does not offload KV cache.'] : []),
    ...(hybridSafetyMi > 0 ? [`Configured KV budget: ${formatMi(kvBudgetMi * budgetDevices)} = ${formatMi(baseKvMi * budgetDevices)} theoretical cache + ${formatMi(hybridSafetyMi * budgetDevices)} compatibility safety for the hybrid vLLM allocator.`] : []),
    ...(!offloading ? ['Minimum includes weights, the complete KV budget, and runtime components. Recommended adds the separate headroom shown above. Download size is not added to memory.'] : []),
    ...(estimate.warnings ?? []).map((warning) => budgetDevices > 1 && warning.startsWith('Multi-GPU figures are per card;')
      ? warning.replace('Multi-GPU figures are per card;', 'The displayed totals combine per-GPU estimates;') : warning),
  ];
  const metricValue = (item: BreakdownMetric) => item.mi !== undefined ? formatMi(item.mi * (item.multiplier ?? 1)) : item.value ?? '—';
  return {cards, calculations, notes, metricValue};
};

export const breakdownItems = (ctx: TuiContext, id: string, estimate: MemoryEstimate, budgetDevices: number, open: boolean, onToggle: (open: boolean) => void): DialogItem[] => {
  const breakdown = breakdownMetrics(estimate, budgetDevices);
  return [
    {kind: 'toggle', id: `${id}:breakdown`, label: 'Breakdown', open, onChange: onToggle},
    ...(open ? [
      {kind: 'facts', rows: breakdown.cards.map((item) => [item.label, breakdown.metricValue(item)] as [string, string])} as DialogItem,
      ...breakdown.notes.map((text): DialogItem => ({kind: 'note', text})),
      {kind: 'buttons', items: [{id: `${id}:breakdown-info`, label: 'Calculation details', onPress: () => showCalculations(ctx, 'Memory breakdown', breakdown.cards.map((item) => ({
        label: item.label, value: breakdown.metricValue(item), calculation: breakdown.calculations[item.key], perDeviceMi: item.mi, budgetDevices: item.multiplier ?? 1,
      })))}]} as DialogItem,
    ] : []),
  ];
};

export interface EstimatePanelInput {
  id: string;
  estimate?: MemoryEstimate;
  availableMi: number;
  capacityKnown: boolean;
  selectedMi: number;
  onSelected: (value: number) => void;
  hideBreakdown?: boolean;
  preserveSelectedMi?: number;
  budgetDevices: number;
  breakdownOpen: boolean;
  onBreakdown: (open: boolean) => void;
}

/** The browser's reservation panel: minimum/recommended/100% markers, budget input and shortcut buttons. */
export const estimatePanelItems = (ctx: TuiContext, input: EstimatePanelInput): DialogItem[] => {
  const {estimate, availableMi, capacityKnown, selectedMi, onSelected, budgetDevices} = input;
  if (!estimate) return [{kind: 'note', text: 'Choose a model reference to calculate memory.'}];
  const minimum = roundMemory(estimate.minimumMi);
  const recommended = roundMemory(estimate.recommendedMi);
  const maximum = Math.max(0, Math.floor(availableMi / 100) * 100);
  const total = (value: number) => value * budgetDevices;
  const cpu = estimate.computeTarget === 'cpu';
  const label = budgetDevices > 1 ? 'Total VRAM budget (MiB)' : cpu ? 'RAM budget (MiB)' : 'VRAM budget (MiB)';
  return [
    {kind: 'heading', text: `${budgetDevices > 1 ? 'Total VRAM' : cpu ? 'RAM' : 'VRAM'} reservation`, meta: `${estimate.confidence ?? 'estimated'} confidence`},
    {kind: 'facts', rows: [
      ['Minimum', formatMi(total(minimum))], ['Recommended', formatMi(total(recommended))],
      ['100% unreserved', capacityKnown ? formatMi(total(maximum)) : 'Unknown'],
    ]},
    {kind: 'note', tone: 'accent', text: capacityScale(selectedMi, minimum, recommended, maximum, capacityKnown)},
    {kind: 'note', text: `█ selected · ░ unreserved · · beyond unreserved capacity · m minimum · R recommended${capacityKnown ? ' · | 100%' : ''}. Selected: ${formatMi(total(selectedMi))} · ${!capacityKnown ? 'Capacity unknown' : maximum > 0 ? `${Math.round(selectedMi / maximum * 100)}% of unreserved memory` : `< ${total(100)} MiB unreserved`}`},
    {kind: 'number', id: `${input.id}:budget`, label, value: String(total(selectedMi)), step: total(100), min: total(100),
      ...(capacityKnown && maximum >= 100 ? {max: total(maximum)} : {}), decimals: budgetDevices > 1,
      onChange: (value) => onSelected(Number(value || 0) / budgetDevices)},
    {kind: 'buttons', items: [
      {id: `${input.id}:minimum`, label: 'Minimum', onPress: () => onSelected(capacityKnown && maximum >= 100 ? Math.min(maximum, minimum) : minimum)},
      {id: `${input.id}:recommended`, label: 'Recommended', tone: 'primary', onPress: () => onSelected(capacityKnown && maximum >= 100 ? Math.min(maximum, recommended) : recommended)},
      {id: `${input.id}:maximum`, label: '100%', disabled: !capacityKnown || maximum < 100 ? 'Unreserved capacity is unknown or below 100 MiB.' : undefined, onPress: () => onSelected(maximum)},
      {id: `${input.id}:info`, label: 'Calculation details', onPress: () => showCalculations(ctx, 'Memory reservation', [
        {label: 'Minimum', value: formatMi(total(minimum)), calculation: estimate.calculations?.minimumMi, roundedMi: estimate.minimumMi, budgetDevices},
        {label: 'Recommended', value: formatMi(total(recommended)), calculation: estimate.calculations?.recommendedMi, roundedMi: estimate.recommendedMi, budgetDevices},
        {label: '100% unreserved', value: capacityKnown ? formatMi(total(maximum)) : 'Unknown', calculation: unreservedCalculation(capacityKnown ? availableMi : null, budgetDevices)},
      ])},
    ]},
    ...(capacityKnown && (minimum > maximum || recommended > maximum)
      ? [{kind: 'note', tone: 'warn', text: `${minimum > maximum ? 'Minimum and recommended' : 'Recommended'} memory extends into the grey area beyond currently unreserved capacity.`} as DialogItem] : []),
    ...(!input.hideBreakdown ? breakdownItems(ctx, input.id, estimate, budgetDevices, input.breakdownOpen, input.onBreakdown) : []),
  ];
};

export interface SystemMemoryInput {
  id: string;
  estimate?: MemoryEstimate;
  selectedMi: number;
  onSelected?: (value: number) => void;
  preserveSelectedMi?: number;
  breakdownOpen: boolean;
  onBreakdown: (open: boolean) => void;
}

/** The browser's system RAM planning panel; editable when the model has its own host budget. */
export const systemMemoryItems = (ctx: TuiContext, input: SystemMemoryInput): DialogItem[] => {
  const memory = input.estimate?.systemMemory;
  if (!memory) return [];
  const display = (mi?: number | null) => typeof mi === 'number' ? formatMi(mi) : 'Unknown';
  const maximum = typeof memory.maximumMi === 'number' ? Math.floor(memory.maximumMi / 100) * 100 : null;
  const recommended = memory.recommendedMi;
  const {onSelected, selectedMi} = input;
  const startup = memory.startupMinimumMi === null || memory.startupUpperMi === null ? 'Unknown' : `${display(memory.startupMinimumMi)} – ${display(memory.startupUpperMi)}`;
  return [
    {kind: 'heading', text: onSelected ? 'System RAM reservation' : 'System RAM estimate', meta: `Estimated · ${memory.scope === 'per-copy' ? 'per model copy' : 'one model Pod'}`},
    {kind: 'facts', rows: [['While serving', display(memory.runningMinimumMi)], ['At startup · estimated range', startup], ['Conservative recommended budget', display(recommended)]]},
    {kind: 'note', text: 'Loading can use more RAM than serving. The upper range includes reclaimable file cache; it is not another permanent model copy or measured memory use.'},
    ...(memory.replicaCount > 1 ? [{kind: 'note', tone: 'normal', text: `${memory.replicaCount} independent copies · recommended total host RAM: ${display(memory.totalRecommendedMi)}. VRAM remains separate.`} as DialogItem] : []),
    ...(onSelected ? [
      {kind: 'note', text: `Unreserved RAM on the selected GPU node: ${display(maximum)}. Saved budgets are retained until you change them.`} as DialogItem,
      {kind: 'number', id: `${input.id}:host`, label: 'Host RAM budget (MiB)', value: String(selectedMi), step: 100, min: 100, ...(maximum !== null && maximum >= 100 ? {max: maximum} : {}),
        onChange: (value: string) => onSelected(Number(value || 0))} as DialogItem,
      {kind: 'buttons', items: [{id: `${input.id}:host-recommended`, label: 'Use recommended RAM allocation', disabled: recommended === null ? 'No RAM recommendation is available.' : undefined,
        onPress: () => recommended !== null && onSelected(roundMemory(maximum !== null && maximum >= 100 ? Math.min(maximum, recommended) : recommended))}]} as DialogItem,
      ...(memory.minimumMi !== null && selectedMi < memory.minimumMi ? [{kind: 'note', tone: 'warn', text: 'The selected RAM is below the estimated startup minimum. The runtime may fail or restart.'} as DialogItem] : []),
      ...(recommended !== null && maximum !== null && recommended > maximum ? [{kind: 'note', tone: 'warn', text: "The conservative RAM recommendation exceeds this node's unreserved capacity. A smaller budget does not prove that the model will load."} as DialogItem] : []),
    ] : [{kind: 'note', text: 'Advisory host estimate; the current single-GPU resource profile determines its RAM budget. This is separate from CPU-offloading and GPU memory.'} as DialogItem]),
    {kind: 'toggle', id: `${input.id}:ram-breakdown`, label: 'RAM breakdown', open: input.breakdownOpen, onChange: input.onBreakdown},
    ...(input.breakdownOpen ? [
      {kind: 'facts', rows: [
        ['CPU-resident weights', display(memory.weightsOnCpuMi)], ['CPU-resident cache', display(memory.cacheOnCpuMi)],
        ['Host runtime', display(memory.hostRuntimeMi)], ['Multimodal processor caches', display(memory.multimodalCacheMi)],
        ['Prompt / token buffers', display(memory.promptBuffersMi)], ['Startup transfer buffers', display(memory.loadingBuffersMi)],
        ['Reclaimable file-cache upper bound', display(memory.fileCacheUpperMi)],
      ]} as DialogItem,
      {kind: 'note', text: 'Do not sum both startup bounds. Lower-bound transfer buffers and upper-bound file cache are alternative loading envelopes.'} as DialogItem,
      ...(memory.warnings ?? []).map((text): DialogItem => ({kind: 'note', text})),
      {kind: 'buttons', items: [{id: `${input.id}:ram-info`, label: 'Calculation details', onPress: () => showCalculations(ctx, 'System RAM', [
        {label: 'Serving RAM', value: display(memory.runningMinimumMi), calculation: memory.calculations?.runningMinimumMi},
        {label: 'Startup RAM range', value: startup, calculation: memory.calculations?.startupUpperMi},
        {label: 'Recommended system RAM', value: display(recommended), calculation: memory.calculations?.recommendedMi},
      ])}]} as DialogItem,
    ] : []),
  ];
};
