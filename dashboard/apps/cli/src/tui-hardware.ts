// System → Hardware and System → Computer power (apps/web/src/pages/HardwarePage.tsx,
// GpuSharingControls.tsx, HostManagement.tsx, HostGpuMemory.tsx, SharedMemoryOverview.tsx).
import {canAdminister, gpuCompatibilityParameters} from '@magicstick/dashboard-core';
import type {
  GpuCompatibility, GpuCompatibilityNode, GpuSharingState, HardwareGpuDevice, HostAction, HostGpuMemory,
  HostGpuMemorySettings, HostOperationRequest, ManagedHost, SharedMemoryInventory,
} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {AreaModule, TuiContext} from './tui-context';
import type {DialogItem} from './tui-dialogs';
import type {PageState, PageView} from './tui-state';
import {badge, button, fit, gap, joinSpans, panel, prose, span, toggle, wrapText, type Row, type Span} from './tui-screen';
import {blank, facts, heading, plural, sectionLabel, statusBadge, tags, terminalHostPhases, text} from './tui-widgets';

// ---------------------------------------------------------------------------------------------
// Shared rules (the same as the browser components)

/** HostGpuMemory.tsx treats RolledBack as still running; the other host panels treat it as finished. */
const MEMORY_TERMINAL = new Set(['Succeeded', 'PreparedUnverified', 'Failed', 'Rejected', 'Interrupted']);
const activeOperation = (host: ManagedHost) => Boolean(host.operation && !terminalHostPhases.has(host.operation.phase));
const known = (value?: number | null): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const positive = (value?: number): value is number => value !== undefined && Number.isFinite(value) && value > 0;
/** SharedMemoryOverview.tsx formatting: unknown is "Not reported", never zero. */
const layoutMemory = (value?: number | null) => !known(value) ? 'Not reported'
  : value < 1024 ? `${Math.round(value)} MiB` : `${Number((value / 1024).toFixed(1))} GiB`;
/** HostGpuMemory.tsx formatting. */
const hostMemory = (value?: number) => value === undefined ? 'Unknown'
  : value < 1024 ? `${value.toLocaleString('en-US')} MiB` : `${Number((value / 1024).toFixed(1)).toLocaleString('en-US')} GiB`;
const stage = (ready?: boolean | null) => ready === true ? 'Ready' : ready === false ? 'Not ready' : 'Not verified';
const vendorName = (vendor: string) => vendor === 'amd' ? 'AMD' : vendor === 'nvidia' ? 'NVIDIA' : vendor === 'intel' ? 'Intel' : 'GPU';
const engineName = (engine: Engine) => engine === 'OLlama' ? 'Ollama' : 'vLLM';
const ENGINES = ['OLlama', 'VLLM'] as const;
type Engine = (typeof ENGINES)[number];

/** A checkbox on the page; long labels continue on the following rows. */
const checkRows = (id: string, label: string, checked: boolean, width: number, disabled?: string): Row[] => {
  const [first = '', ...rest] = wrapText(label, Math.max(10, width - 4));
  return [
    [{text: `[${checked ? 'x' : ' '}] ${first}`, style: disabled ? {tone: 'dim'} : undefined, action: {id, label: checked ? 'Clear' : 'Select', ...(disabled ? {disabled} : {})}}],
    ...rest.map((line) => [gap(4), span(line, disabled ? 'dim' : undefined)]),
  ];
};
const indent = (rows: Row[], size = 2): Row[] => rows.map((row) => row.length ? [gap(size), ...row] : row);
const notice = (width: number, value: string, tone: 'warn' | 'bad' | 'dim' = 'warn'): Row[] => prose(width, `${tone === 'dim' ? '' : '! '}${value}`, tone);

/** The browser's useHostAction / host operation payload: exact computer, boot and plan identity. */
const hostPayload = (host: ManagedHost, action: HostAction, requestId: string, extra: Partial<HostOperationRequest> = {}): HostOperationRequest => ({
  action, nodeName: host.name, nodeUid: host.nodeUid, bootId: host.bootId, requestId, confirmation: host.name,
  acknowledgeDisruption: true, allowExperimental: false, experimentMode: false, ...extra,
});

const operationRows = (host: ManagedHost, actions: HostAction[], width: number): Row[] => {
  const operation = host.operation;
  if (!operation || !actions.includes(operation.action)) return [];
  const power = ['RebootScheduled', 'PoweroffScheduled'].includes(operation.phase);
  return [
    fit(width, [span(`${operation.action} · ${operation.phase}`, undefined, true)], [statusBadge(operation.phase)]),
    ...prose(width, operation.message || 'Waiting for the local host worker.', 'dim'),
    ...(power ? [
      ...prose(width, 'The connection will be interrupted. A shutdown needs local power-on or separately configured remote power management to return. This page never repeats a power request automatically.', 'dim'),
      ...notice(width, 'All workloads on this computer will be interrupted.'),
    ] : []),
  ];
};

// ---------------------------------------------------------------------------------------------
// GPU nodes, built exactly like HardwarePage.tsx

export interface HardwareNodeEntry {
  node: GpuCompatibilityNode;
  /** Identity used in action ids: the node UID, or its name while the UID is not reported. */
  key: string;
  compatibility?: GpuCompatibility;
  devices: HardwareGpuDevice[];
  host?: ManagedHost;
}

export const hardwareNodes = (snapshot: DashboardSnapshot): HardwareNodeEntry[] => {
  const operators = Object.entries(snapshot.status.hardwareOperators ?? {});
  const compatibility = snapshot.status.hardwareOperators?.['amd-gpu']?.compatibility;
  const nodes: GpuCompatibilityNode[] = [...(compatibility?.nodes ?? [])];
  const devices = operators.flatMap(([, operator]) => operator.devices ?? []);
  const hosts = snapshot.hosts?.nodes ?? [];
  for (const device of devices) {
    if (!nodes.some((node) => node.nodeUid === device.nodeUid)) nodes.push({node: device.node, nodeUid: device.nodeUid});
  }
  for (const host of hosts) {
    if (!nodes.some((node) => node.nodeUid ? node.nodeUid === host.nodeUid : node.node === host.name)) nodes.push({node: host.name, nodeUid: host.nodeUid});
  }
  return nodes.map((node) => {
    const nodeCompatibility = compatibility?.nodes.some((item) => node.nodeUid ? item.nodeUid === node.nodeUid : item.node === node.node) ? compatibility : undefined;
    const nodeDevices = devices.filter((device) => device.nodeUid === node.nodeUid);
    // During a rolling upgrade show existing evidence, but do not claim an
    // exact-device test is available until physical PCI inventory arrives.
    if (!nodeDevices.length) {
      if (nodeCompatibility) nodeDevices.push({id: `${node.nodeUid}/legacy-amd`, node: node.node, nodeUid: node.nodeUid ?? '', vendor: 'amd', name: 'AMD GPU', pciAddress: '', pciId: node.pciDevices?.join(', ') ?? '', architecture: node.detectedArchitecture, hostDriverReady: node.hostDriverReady, resourceRegistered: node.resourceRegistered, memoryArchitecture: node.memoryArchitecture, memory: node, validation: node.validation, validationAvailable: false, validationReason: 'Waiting for fresh physical GPU inventory from the host.'});
      if (snapshot.gpuSharing?.providers.some((state) => state.nodeUid === node.nodeUid && state.provider === 'nvidia')) nodeDevices.push({id: `${node.nodeUid}/legacy-nvidia`, node: node.node, nodeUid: node.nodeUid ?? '', vendor: 'nvidia', name: 'NVIDIA GPU', pciAddress: '', pciId: '', validationAvailable: false, validationReason: 'Waiting for fresh physical GPU inventory from the host.'});
    }
    const host = hosts.find((item) => node.nodeUid ? node.nodeUid === item.nodeUid : node.node === item.name);
    return {node, key: node.nodeUid || node.node, compatibility: nodeCompatibility, devices: nodeDevices, host};
  });
};

/** Which device shows the AMD memory controls and the provider's sharing form (HardwareNode in HardwarePage.tsx). */
const deviceRoles = (entry: HardwareNodeEntry, device: HardwareGpuDevice) => {
  const singleProviderDevice = entry.devices.filter((item) => item.vendor === device.vendor).length === 1;
  const host = entry.host;
  const ownsMemory = device.vendor === 'amd' && Boolean(host) && (host!.gpuMemory?.pciAddress === device.pciAddress
    || !host!.gpuMemory?.pciAddress && singleProviderDevice && device.memoryArchitecture === 'unified');
  const ownsSharing = singleProviderDevice || device.vendor === 'nvidia' && entry.devices.find((item) => item.vendor === 'nvidia')?.id === device.id;
  return {singleProviderDevice, ownsMemory, ownsSharing};
};

/** GpuSharingControls.tsx: the provider state belonging to this physical device. */
const sharingState = (snapshot: DashboardSnapshot, entry: HardwareNodeEntry, device: HardwareGpuDevice, ownsSharing: boolean): GpuSharingState | undefined =>
  (snapshot.gpuSharing?.providers ?? []).filter((state) => entry.node.nodeUid && state.nodeUid === entry.node.nodeUid)
    .find((state) => state.provider === device.vendor && ownsSharing && (!state.device?.pciAddress || state.device.pciAddress === device.pciAddress));

const findEntry = (snapshot: DashboardSnapshot, key: string) => hardwareNodes(snapshot).find((entry) => entry.key === key);
const findDevice = (snapshot: DashboardSnapshot, target: string) => {
  const [key = '', id = ''] = target.split('|');
  const entry = findEntry(snapshot, key);
  const device = entry?.devices.find((item) => item.id === id);
  return entry && device ? {entry, device} : undefined;
};

// ---------------------------------------------------------------------------------------------
// Host preparation (HostPreparation in HostManagement.tsx)

const preparationState = (ui: Record<string, string>, host: ManagedHost) => {
  // The choices reset when the computer, its boot or its plan change, like the browser's keyed component.
  const planKey = `${host.bootId}:${host.plan?.id ?? ''}`;
  const experiment = Boolean(host.plan?.experiment) && ui[`hw.experiment.${host.nodeUid}`] === planKey;
  const plan = experiment ? host.plan?.experiment ?? undefined : host.plan ?? undefined;
  const ackKey = `${planKey}:${experiment ? 'experiment' : 'plan'}`;
  const acknowledged = ui[`hw.ack.${host.nodeUid}`] === ackKey;
  const actionable = Boolean(plan && ['available', 'ready'].includes(plan.state));
  return {planKey, experiment, plan, ackKey, acknowledged, actionable};
};

const nodeFacts = (node: GpuCompatibilityNode): Array<[string, string]> => [
  ['Profile', `${node.profileId || 'Upstream rules'}${node.profileVersion ? ` · ${node.profileVersion}` : ''}`],
  ['Upstream operator recognition', node.upstreamSupported === true ? 'Recognized' : node.upstreamSupported === false ? 'Not recognized' : 'Not verified'],
];

const preparationRows = (snapshot: DashboardSnapshot, state: PageState, entry: HardwareNodeEntry, width: number): Row[] => {
  const host = entry.host!;
  const admin = canAdminister(snapshot.session);
  const stale = Boolean(snapshot.errors?.hosts);
  const {experiment, plan, acknowledged, actionable} = preparationState(state.ui, host);
  const blocked = stale ? 'Host information is stale. Refresh before preparing hardware.'
    : !host.available ? 'This computer is unavailable.'
      : activeOperation(host) ? 'Another host operation is in progress.'
        : !acknowledged ? 'Accept the experimental profile and its limitations first.' : undefined;
  return [
    ...facts(width, [
      ...nodeFacts(entry.node),
      ['Running kernel', host.kernel],
      ['Planned kernel', plan ? plan.rebootRequired ? plan.targetKernel : 'Unchanged' : 'Not reported'],
      ['Kernel / driver plan', plan ? `${plan.profileId || 'No additional profile'}${plan.profileVersion ? ` · ${plan.profileVersion}` : ''}` : 'Not reported'],
    ]),
    blank,
    fit(width, [span('Host preparation', undefined, true)], [statusBadge(host.available ? plan?.state ?? 'Unknown' : 'Unavailable')]),
    ...prose(width, experiment ? 'Automatic preparation remains blocked. You are reviewing a one-off experimental override below.' : host.plan?.message || host.message, 'dim'),
    ...prose(width, "Prepares this computer's kernel and driver, then activates the matching AMD runtime profile and waits for Kubernetes GPU registration. No engine tests run automatically.", 'dim'),
    ...(admin && host.plan?.experiment ? checkRows(`hwui:experiment:${entry.key}`, 'Experiment mode — test an unreviewed hardware combination', experiment, width) : []),
    ...(plan ? [
      ...(Object.keys(plan.packages).length ? [fit(width, [span('Exact package changes', undefined, true)]), ...Object.entries(plan.packages).map(([name, version]) => fit(width, [span(`  ${name} = ${version}`)]))] : []),
      ...(experiment ? [
        ...notice(width, 'Unreviewed hardware experiment'),
        ...prose(width, plan.message, 'warn'),
        ...(plan.engineValidationAvailable === false ? prose(width, 'Engine validation is unavailable for this multi-AMD layout. Host preparation alone will not make the GPUs available to models.', 'warn') : []),
      ] : []),
      ...(admin && actionable ? [
        ...checkRows(`hwui:ack:${entry.key}`, `I accept the experimental profile${experiment ? ', the unreviewed GPU combination and local recovery risk' : ' and its limitations'}.`, acknowledged, width),
        fit(width, [], [button(`host:prepare:${entry.key}`, experiment ? 'Review hardware experiment' : 'Review hardware preparation', 'primary', blocked)]),
      ] : []),
    ] : []),
    ...(stale ? notice(width, 'Host information is stale. Refresh before preparing hardware.') : []),
    ...operationRows(host, ['prepare-gpu'], width),
    ...(state.ui[`hw.prepAccepted.${host.nodeUid}`] ? prose(width, 'Preparation requested. Progress continues on the computer even if this page is closed.', 'good') : []),
  ];
};

const prepareHardware = (ctx: TuiContext, key: string) => {
  const host = findEntry(ctx.snapshot(), key)?.host;
  if (!host) return ctx.missing();
  const {plan, acknowledged, actionable, experiment} = preparationState(ctx.view.ui, host);
  if (!plan || !actionable) return ctx.message('Hardware preparation unavailable', host.plan?.message || host.message || 'No actionable preparation plan is reported for this computer.');
  if (ctx.snapshot().errors?.hosts) return ctx.message('Host information is stale', 'Refresh before preparing hardware.');
  if (!host.available || activeOperation(host)) return ctx.message('Computer busy or unavailable', !host.available ? 'This computer is unavailable.' : 'Another host operation is in progress.');
  if (!acknowledged) return ctx.message('Acknowledgement required', 'Accept the experimental profile and its limitations first.');
  const label = plan.experimentMode ? 'Start hardware experiment' : 'Prepare hardware';
  const requestId = ctx.requestId();
  const description = `${plan.experimentMode ? 'This GPU combination is unreviewed. Other GPUs or network access may fail. Have local console access and the previous kernel available. ' : ''}Apply only the displayed host profile to ${host.name}. ${plan.rebootRequired ? 'This authorizes package preparation and one orderly restart after preparation.' : 'No package change or restart is planned.'} ${plan.engineValidationAvailable === false ? 'The runtime profile is unavailable for this multi-AMD layout; preparing the host does not enable these GPUs.' : 'Then enable the experimental AMD runtime profile and wait for Kubernetes GPU registration. Engine tests are optional and are not started automatically. Package and power changes apply only to the selected computer.'} Interruptions are possible; this is not general support certification.`;
  ctx.confirm({title: label, description, confirmLabel: label, expected: host.name, danger: true, onConfirm: () => ctx.perform(label, async () => {
    const live = findEntry(ctx.snapshot(), key)?.host;
    if (!live || live.bootId !== host.bootId || preparationState(ctx.view.ui, live).plan?.id !== plan.id) throw new Error('The computer or its preparation plan changed. Review the current plan again.');
    await ctx.api.requestHostOperation(hostPayload(host, 'prepare-gpu', requestId, {
      allowExperimental: plan.experimental === true, experimentMode: plan.experimentMode === true, planId: plan.id,
    }));
    ctx.view.ui[`hw.prepAccepted.${host.nodeUid}`] = requestId;
    return {lines: [`${label} was requested for ${host.name}${experiment ? ' (experiment mode)' : ''}.`, 'Preparation requested. Progress continues on the computer even if this page is closed. A request is not confirmation that the preparation succeeded.']};
  })});
};

// ---------------------------------------------------------------------------------------------
// Physical memory layout and device facts

const layoutInfo = (pool: SharedMemoryInventory): string[] => {
  const {installedMemoryMi: installed, firmwareReservedMi: fixed, physicalMemoryMi: linux} = pool;
  const remainder = known(installed) && known(fixed) && known(linux) ? installed - fixed - linux : null;
  const fixedAllocations = pool.gpuAllocationMode === 'firmware-reserved';
  const dynamicAllocations = pool.gpuAllocationMode === 'shared-gtt';
  const reported = pool.gpuCapacitySource === 'kfd-topology' && (fixedAllocations || dynamicAllocations);
  return [
    'One GPU, not two deployment targets. Firmware reservation and the dynamic ceiling are not automatically combined into one model capacity. Dynamic GPU memory is part of Linux-visible RAM.',
    'Installed RAM is reported by firmware (SMBIOS). Fixed GPU memory is carved out by firmware and unavailable to Linux. The dynamic GPU ceiling is within Linux RAM · not reserved or protected.',
    ...(remainder !== null && remainder >= 0 ? [`Installed RAM = fixed GPU reservation + Linux-visible RAM + ${layoutMemory(remainder)} other firmware/platform memory. The last value is the difference, not an additional GPU pool.`] : []),
    ...(remainder !== null && remainder < 0 ? ['Firmware and driver totals do not reconcile; no combined capacity is inferred.'] : []),
    reported ? `Driver capacity: KFD topology · ${fixedAllocations ? 'firmware-reserved pool' : 'dynamic Linux RAM'}.` : 'Allocation domain not confirmed.',
    `${reported ? fixedAllocations
      ? 'Model planning uses the firmware-reserved GPU pool. Only the host runtime request is charged to Linux RAM; GPU weights are not charged twice.'
      : 'Model planning uses dynamic Linux RAM and is limited by both the GPU ceiling and remaining RAM budgets.'
      : 'Model capacity stays unknown until matching driver evidence is available. RAM requests remain conservative.'} Driver capacity is not a successful engine allocation test.`,
    `The dynamic ceiling and Kubernetes requests do not protect memory from other processes. No protected dynamic reserve is promised. GPU memory accounting: ${pool.memoryAccountingVerified ? 'verified' : 'not yet verified; no capacity guarantee'}.`,
  ];
};

const memoryLayoutRows = (entry: HardwareNodeEntry, device: HardwareGpuDevice, width: number): Row[] => {
  if (device.memoryArchitecture === 'unified' && device.memory) {
    const pool = device.memory;
    const reported = pool.gpuCapacitySource === 'kfd-topology' && (pool.gpuAllocationMode === 'firmware-reserved' || pool.gpuAllocationMode === 'shared-gtt');
    return [
      fit(width, [span(`Physical memory layout · ${pool.node}`, undefined, true)], [button(`hardware:layout-info:${entry.key}|${device.id}`, 'Info')]),
      ...tags(width, ['One GPU · unified physical RAM', `Accounting ${pool.memoryAccountingVerified ? 'verified' : 'unverified'}`]),
      ...facts(width, [
        ['Installed RAM', layoutMemory(pool.installedMemoryMi)],
        ['Fixed GPU reservation', layoutMemory(pool.firmwareReservedMi)],
        ['Linux-visible RAM', layoutMemory(pool.physicalMemoryMi)],
        ['Dynamic GPU ceiling', layoutMemory(pool.gpuAccessibleMi)],
        ['Driver-reported GPU capacity', layoutMemory(reported ? pool.gpuCapacityMi : null)],
      ]),
    ];
  }
  return [
    fit(width, [span('Physical memory layout', undefined, true)]),
    ...facts(width, [['Dedicated GPU memory', device.memoryTotalMi == null ? 'Not reported' : device.memoryTotalMi < 1024 ? `${device.memoryTotalMi} MiB` : `${Number((device.memoryTotalMi / 1024).toFixed(1))} GiB`]]),
    ...prose(width, "Dedicated memory belongs to this physical GPU. It is not added to another GPU's memory or the Strix Halo shared-memory ceiling.", 'dim'),
  ];
};

const deviceFactRows = (device: HardwareGpuDevice, width: number): Row[] => facts(width, [
  ['Architecture', device.architecture || 'Not verified'],
  ['Host driver', `${stage(device.hostDriverReady)}${device.hostDriver ? ` · ${device.hostDriver}` : ''}`],
  ['Kubernetes GPU resource', stage(device.resourceRegistered)],
  ['Detected GPU device', `${device.pciId || 'Not reported'}${device.pciAddress ? ` · ${device.pciAddress}` : ''}`],
]);

// ---------------------------------------------------------------------------------------------
// GPU sharing (SharingForm in GpuSharingControls.tsx)

const sharingInfo = (state: GpuSharingState, backend: 'dra' | 'device-plugin'): string[] => {
  const vendor = vendorName(state.provider);
  return [
    'Several model pods can share one physical GPU. This does not partition GPU memory or guarantee throughput. Model memory budgets and CPU offloading settings remain separate.',
    `${vendor} uses ${backend === 'dra' ? 'DRA' : 'Time-slicing'}. Changes apply only to this provider. Managed ${vendor} model pods may restart; model settings and downloads remain. AMD supports one GPU; NVIDIA supports multiple whole GPUs on one node.`,
    ...(state.provider === 'nvidia' ? ['DRA enables exact card selection for ordinary vLLM and Ollama models. Device-plugin mode automatically assigns a card from the node pool. Stop Realtime and other NVIDIA workloads before switching to DRA. The driver and toolkit remain installed; allocation backends never run together.'] : []),
    ...(state.reason ? [state.reason] : []),
    ...(state.message ? [state.message] : []),
  ];
};

const sharingTags = (state: GpuSharingState, backend: 'dra' | 'device-plugin') => [
  `${backend === 'dra' ? 'DRA' : 'Time-slicing'} ${backend === 'dra' ? 'sharing configuration' : 'configuration'}`,
  ...(state.managed && state.mode === 'shared' ? [`${state.activeModels} active · up to ${state.maxModels} models per GPU`] : []),
  ...(state.device?.pciAddress ? [`GPU: ${state.device.pciAddress}`] : []),
];

const sharingRows = (snapshot: DashboardSnapshot, entry: HardwareNodeEntry, device: HardwareGpuDevice, state: GpuSharingState, width: number): Row[] => {
  const admin = canAdminister(snapshot.session);
  const backend = state.backend === 'dra' ? 'dra' : 'device-plugin';
  return [
    fit(width, [span('GPU sharing', undefined, true), gap(2), statusBadge(state.phase)], joinSpans([
      button(`hardware:sharing-info:${entry.key}|${device.id}`, 'Info'),
      ...(admin ? [button(`gpu:sharing:${entry.key}|${device.id}`, 'Configure sharing')] : []),
    ])),
    ...facts(width, [
      ...(state.provider === 'nvidia' ? [['Allocation backend', backend === 'dra' ? 'DRA · select individual cards' : 'Device plugin · automatic card assignment'] as [string, string]] : []),
      ['Allocation mode', state.mode === 'shared' ? `Shared · up to ${state.maxModels} models per GPU` : 'Exclusive · one model per GPU'],
    ]),
    ...tags(width, sharingTags(state, backend)),
    ...(state.reason ? prose(width, state.reason, 'dim') : []),
    ...(state.message ? prose(width, state.message, 'dim') : []),
  ];
};

const configureSharing = (ctx: TuiContext, target: string) => {
  const found = findDevice(ctx.snapshot(), target);
  if (!found) return ctx.missing();
  const state = sharingState(ctx.snapshot(), found.entry, found.device, deviceRoles(found.entry, found.device).ownsSharing);
  if (!state) return ctx.message('GPU sharing unavailable', 'The GPU sharing state of this device has not been reported yet.');
  const vendor = vendorName(state.provider);
  const draft = {
    mode: state.mode as GpuSharingState['mode'],
    maxModels: String(state.maxModels),
    allocationBackend: (state.backend === 'dra' ? 'dra' : 'device-plugin') as 'dra' | 'device-plugin',
  };
  const shared = () => draft.mode === 'shared';
  const maxModels = () => Number(draft.maxModels);
  const changed = () => draft.mode !== state.mode || shared() && maxModels() !== state.maxModels
    || state.provider === 'nvidia' && draft.allocationBackend !== (state.backend === 'dra' ? 'dra' : 'device-plugin');
  ctx.dialog({
    title: `${vendor} GPU sharing`,
    description: `${found.device.name} · ${found.device.pciAddress || 'PCI address not reported'} on ${found.entry.node.node}.`,
    items: (): DialogItem[] => [
      ...(state.provider === 'nvidia' ? [{kind: 'choice' as const, id: 'backend', label: 'NVIDIA GPU allocation backend', value: draft.allocationBackend, choices: [
        {value: 'device-plugin', label: 'Device plugin · automatic card assignment'},
        {value: 'dra', label: 'DRA · select individual cards (Kubernetes 1.36+)', disabled: state.draAvailable ? undefined : 'Dynamic resource allocation is not available on this cluster.'},
      ], onChange: (value: string) => { draft.allocationBackend = value as typeof draft.allocationBackend; }}] : []),
      {kind: 'choice', id: 'mode', label: `${vendor} allocation mode`, value: draft.mode, choices: [
        {value: 'exclusive', label: 'Exclusive · one model per GPU'},
        {value: 'shared', label: 'Shared · multiple models', disabled: state.available ? undefined : state.reason || 'Shared mode is not available for this GPU.'},
      ], onChange: (value) => { draft.mode = value as typeof draft.mode; }},
      ...(shared() ? [{kind: 'number' as const, id: 'maxModels', label: `${vendor} maximum simultaneous models`, value: draft.maxModels, step: 1, min: 2, max: 16,
        hint: 'Slots per physical GPU, shared by all model engines.', onChange: (value: string) => { draft.maxModels = value; }}] : []),
      {kind: 'note', text: 'Slots per physical GPU are shared by all model engines.'},
      ...sharingTags(state, draft.allocationBackend).map((value): DialogItem => ({kind: 'note', text: `[${value}]`})),
      ...sharingInfo(state, draft.allocationBackend).map((value): DialogItem => ({kind: 'note', text: value})),
    ],
    submit: {
      label: `apply ${vendor} sharing`,
      disabled: () => !changed() ? 'No changes to apply.'
        : shared() && !state.available ? state.reason || 'Shared mode is not available for this GPU.'
          : shared() && (!Number.isInteger(maxModels()) || maxModels() < 2 || maxModels() > 16) ? 'Enter 2 to 16 simultaneous models.' : undefined,
      run: () => ctx.confirm({
        title: `Change ${vendor} GPU allocation`, back: true,
        description: `Managed ${vendor} model pods may restart. Model settings and cached downloads remain. Other GPU providers are unchanged. Shared mode has no isolated GPU memory or guaranteed performance per model.`,
        confirmLabel: `Apply and restart ${vendor} models`,
        onConfirm: () => ctx.perform(`Change ${vendor} GPU allocation`, async () => {
          await ctx.api.configureGpuSharing({
            provider: state.provider, mode: draft.mode,
            maxModels: shared() ? maxModels() : Math.max(2, Math.min(16, Math.trunc(maxModels()) || 2)),
            nodeName: state.nodeName, nodeUid: state.nodeUid, expectedRevision: state.expectedRevision,
            ...(state.provider === 'nvidia' ? {allocationBackend: draft.allocationBackend} : {}),
            acknowledgeSharing: shared(), acknowledgeRestart: true,
          });
          return {lines: [`${vendor} GPU allocation change requested: ${draft.mode === 'shared' ? `shared, up to ${maxModels()} models per GPU` : 'exclusive, one model per GPU'}.`, `Managed ${vendor} model pods may restart while the change is applied.`]};
        }),
      }),
    },
  });
};

// ---------------------------------------------------------------------------------------------
// AMD runtime profile (ProfileControls in HardwarePage.tsx)

const PROFILE_INFO = [
  "Host preparation already activates the matching profile. This manual override changes the cluster's AMD ModuleActivation only; it installs no kernel or driver and does not start engine tests.",
  'Switching back to upstream rules removes the custom profile; existing models may lose GPU eligibility.',
];
const profileLabel = (compatibility: GpuCompatibility, id?: string) => {
  const profile = compatibility.profiles.find((item) => item.id === id);
  return profile ? `${profile.displayName} · ${profile.version}${profile.experimental ? ' · Experimental' : ''}` : id || 'upstream rules';
};

const profileRows = (snapshot: DashboardSnapshot, entry: HardwareNodeEntry, compatibility: GpuCompatibility, width: number): Row[] => {
  const admin = canAdminister(snapshot.session);
  return [
    fit(width, [span('AMD runtime profile', undefined, true)], joinSpans([
      button(`hardware:profile-info:${entry.key}`, 'Info'),
      ...(admin ? [button(`gpu:profile:${entry.key}`, 'Change profile')] : []),
    ])),
    ...facts(width, [['Current profile', profileLabel(compatibility, compatibility.selectedProfile)],
      ...(compatibility.allowExperimental ? [['Experimental profile', 'accepted'] as [string, string]] : [])]),
    ...(admin ? [] : prose(width, 'Administrator access is required to change profiles or run validation.', 'dim')),
  ];
};

const changeProfile = (ctx: TuiContext, key: string) => {
  const entry = findEntry(ctx.snapshot(), key);
  const compatibility = entry?.compatibility;
  if (!compatibility) return ctx.message('Hardware catalog unavailable', 'The server has not reported GPU compatibility profiles yet. Refresh after the controller update.');
  const draft = {profileId: compatibility.selectedProfile ?? '', acknowledged: compatibility.allowExperimental === true};
  const selected = () => compatibility.profiles.find((profile) => profile.id === draft.profileId);
  const changed = () => draft.profileId !== (compatibility.selectedProfile ?? '') || draft.acknowledged !== (compatibility.allowExperimental === true);
  ctx.dialog({
    title: 'AMD runtime profile',
    description: 'Selection affects matching nodes only and does not certify inference.',
    items: (): DialogItem[] => [
      {kind: 'choice', id: 'profile', label: 'AMD compatibility profile', value: draft.profileId, choices: [
        {value: '', label: 'Upstream operator rules only'},
        ...compatibility.profiles.map((profile) => ({value: profile.id, label: `${profile.displayName} · ${profile.version}${profile.experimental ? ' · Experimental' : ''}`})),
      ], onChange: (value) => { draft.profileId = value; draft.acknowledged = false; }},
      ...(selected()?.experimental ? [{kind: 'check' as const, id: 'acknowledge', label: 'I accept the experimental hardware profile and its limitations.', checked: draft.acknowledged,
        onChange: (checked: boolean) => { draft.acknowledged = checked; }}] : []),
      ...PROFILE_INFO.map((value): DialogItem => ({kind: 'note', text: value})),
      ...(selected() ? [{kind: 'note' as const, text: `${selected()!.description ?? ''} Profile selection applies only to matching hardware; it does not certify other cards.`.trim()}] : []),
    ],
    submit: {
      label: 'save hardware profile',
      disabled: () => selected()?.experimental && !draft.acknowledged ? 'Accept the experimental hardware profile first.' : !changed() ? 'No changes to save.' : undefined,
      run: () => {
        const parameters = gpuCompatibilityParameters(draft.profileId, compatibility.profiles, draft.acknowledged);
        return ctx.perform('Save hardware profile', async () => {
          await ctx.api.enableModule('amd-gpu', parameters);
          return {lines: [`AMD runtime profile: ${profileLabel(compatibility, draft.profileId)}.`, 'Hardware configuration saved. GPU use requires host readiness and GPU registration. Optional engine tests run only when requested manually.']};
        });
      },
    },
  });
};

// ---------------------------------------------------------------------------------------------
// Shared GPU memory (MemoryControls in HostGpuMemory.tsx)

const SHARED_MEMORY_INFO = 'CPU and GPU use the same physical RAM. Firmware-reserved GPU memory is unavailable to Linux; dynamic GPU memory is borrowed from Linux RAM only when needed. These are not additional independent pools.';

const memoryModel = (memory: HostGpuMemory) => {
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
  const initialLimit = complete ? snap(memory.currentDynamicLimitMi!, memory.currentCarveoutIndex!) : 0;
  const currentLimitExceedsAllowance = complete && memory.currentDynamicLimitMi! > projectedRam(memory.currentCarveoutIndex!) - reserve;
  return {options, step, minimum, reserve, complete, projectedRam, maximumFor, snap, initialLimit, currentLimitExceedsAllowance};
};

const memoryBlocked = (snapshot: DashboardSnapshot, ui: Record<string, string>, host: ManagedHost, memory: HostGpuMemory) => {
  const model = memoryModel(memory);
  const busy = Boolean(host.operation && !MEMORY_TERMINAL.has(host.operation.phase));
  const accepted = ui[`hw.memAccepted.${host.nodeUid}`];
  const awaitingObservation = Boolean(accepted && host.operation?.requestId !== accepted);
  return snapshot.errors?.hosts || !host.available ? 'Host information is unavailable or stale. Wait for a fresh report before making changes.'
    : !model.complete ? 'Complete firmware and memory information is not available. Configuration is disabled.'
      : !memory.supported ? 'Memory configuration is not supported on this computer.'
        : busy ? 'Another host operation is in progress. Memory configuration is locked.'
          : awaitingObservation ? 'The last memory request has not been observed by the host yet.' : undefined;
};

const memoryFacts = (memory: HostGpuMemory, reserve: number): Array<[string, string]> => [
  ['Current fixed GPU reservation', hostMemory(memory.currentCarveoutMi)],
  ['Current dynamic GPU ceiling (TTM)', hostMemory(memory.currentDynamicLimitMi)],
  ['Currently visible Linux RAM', hostMemory(memory.systemMemoryMi)],
  ['CPU/OS safety allowance', hostMemory(reserve)],
];

const memoryRows = (snapshot: DashboardSnapshot, state: PageState, entry: HardwareNodeEntry, width: number): Row[] => {
  const host = entry.host!;
  const memory = host.gpuMemory;
  const header = (status?: Span) => fit(width, [span('Shared GPU memory', undefined, true), ...(status ? [gap(2), status] : [])],
    [button(`hardware:memory-info:${entry.key}`, 'Info')]);
  if (!memory?.supported) return [header(statusBadge('Unavailable')), ...operationRows(host, ['configure-gpu-memory'], width)];
  const model = memoryModel(memory);
  const admin = canAdminister(snapshot.session);
  const busy = Boolean(host.operation && !MEMORY_TERMINAL.has(host.operation.phase));
  const blocked = memoryBlocked(snapshot, state.ui, host, memory);
  const accepted = state.ui[`hw.memAccepted.${host.nodeUid}`];
  return [
    header(),
    ...facts(width, memoryFacts(memory, model.reserve)),
    ...(!model.complete ? notice(width, 'Complete firmware and memory information is not available. Configuration is disabled.') : []),
    ...(snapshot.errors?.hosts || !host.available ? notice(width, 'Host information is unavailable or stale. Wait for a fresh report before making changes.') : []),
    ...(busy ? prose(width, 'Another host operation is in progress. Memory configuration is locked.', 'dim') : []),
    ...(admin && model.complete && model.initialLimit !== memory.currentDynamicLimitMi ? prose(width, model.currentLimitExceedsAllowance
      ? `Draft limited to ${hostMemory(model.initialLimit)}: the active dynamic limit exceeds the maximum allowed with the current fixed reservation and ${hostMemory(model.reserve)} CPU/OS allowance. Review this draft to apply the correction; the active limit stays unchanged until the confirmed operation completes.`
      : `Draft rounded to ${hostMemory(model.initialLimit)}: the current kernel limit does not match a selectable step. Choose a change to apply; nothing is applied automatically.`, 'dim') : []),
    ...(admin && model.complete ? [fit(width, [], [button(`host:memory:${entry.key}`, 'Configure memory', 'primary', blocked)])] : []),
    ...(accepted ? prose(width, 'Memory configuration requested. Follow the host operation status; a request is not confirmation of a successful restart or applied memory layout.', 'good') : []),
    ...operationRows(host, ['configure-gpu-memory'], width),
  ];
};

const configureMemory = (ctx: TuiContext, key: string) => {
  const host = findEntry(ctx.snapshot(), key)?.host;
  const memory = host?.gpuMemory;
  if (!host || !memory?.supported) return ctx.missing();
  const model = memoryModel(memory);
  const blockedNow = memoryBlocked(ctx.snapshot(), ctx.view.ui, host, memory);
  if (blockedNow) return ctx.message('Memory configuration unavailable', blockedNow);
  const draft = {carveoutIndex: memory.currentCarveoutIndex ?? -1, dynamic: String(model.initialLimit)};
  let dirty = false;
  let feedback = '';
  const limit = () => Number(draft.dynamic);
  const selected = () => model.options.find((option) => option.index === draft.carveoutIndex);
  const maximum = () => model.maximumFor(draft.carveoutIndex);
  const valid = () => Boolean(selected() && draft.dynamic.trim() !== '' && Number.isInteger(limit()) && limit() >= model.minimum && limit() <= maximum() && limit() % model.step === 0);
  const changed = () => draft.carveoutIndex !== memory.currentCarveoutIndex || limit() !== memory.currentDynamicLimitMi;
  /** Re-checks against the latest polled host: a changed boot, plan or busy host invalidates the review. */
  const live = () => {
    const current = findEntry(ctx.snapshot(), key)?.host;
    if (!current || current.bootId !== host.bootId || current.gpuMemory?.id !== memory.id
      || memoryBlocked(ctx.snapshot(), ctx.view.ui, current, current.gpuMemory)) throw new Error('Host state changed. Review the current memory configuration again.');
    return current;
  };
  ctx.dialog({
    title: `Shared GPU memory · ${host.name}`,
    description: 'Changes remain a local draft until confirmed. Only settings reported by this computer\'s firmware are offered.',
    items: (): DialogItem[] => [
      {kind: 'facts', rows: memoryFacts(memory, model.reserve)},
      {kind: 'note', text: `The dynamic ceiling must leave at least ${hostMemory(model.reserve)} outside GPU dynamic allocations. CPU processes still compete for the shared pool; this does not guarantee available memory or reserve RAM for a model.`},
      {kind: 'blank'},
      {kind: 'choice', id: 'fixed', label: 'Fixed GPU reservation (firmware)', value: String(draft.carveoutIndex),
        disabled: model.options.length < 2 ? 'This firmware reports only one fixed reservation setting.' : undefined,
        choices: model.options.map((option) => ({value: String(option.index), label: `${option.label} · ${hostMemory(option.sizeMi)}`})),
        onChange: (value) => {
          const option = model.options.find((item) => item.index === Number(value));
          if (!option) return;
          const previous = Number.isFinite(limit()) ? limit() : model.minimum;
          const dynamicLimitMi = model.snap(previous, option.index);
          draft.carveoutIndex = option.index;
          draft.dynamic = String(dynamicLimitMi);
          dirty = true;
          delete ctx.view.ui[`hw.memAccepted.${host.nodeUid}`];
          feedback = dynamicLimitMi !== previous
            ? `The dynamic GPU limit was adjusted to ${hostMemory(dynamicLimitMi)} to retain the ${hostMemory(model.reserve)} CPU/OS safety allowance. Review both values.` : '';
        }},
      {kind: 'number', id: 'dynamic', label: 'Dynamic GPU memory limit (MiB)', value: draft.dynamic, step: model.step, min: model.minimum, max: Math.max(model.minimum, maximum()),
        disabled: maximum() < model.minimum ? 'No dynamic limit fits with this fixed reservation and the CPU/OS safety allowance.' : undefined,
        onChange: (value) => { draft.dynamic = value; dirty = true; feedback = ''; delete ctx.view.ui[`hw.memAccepted.${host.nodeUid}`]; }},
      {kind: 'note', text: `Upper bound for on-demand GPU use of shared RAM, not reserved RAM. Steps of ${hostMemory(model.step)}; ${hostMemory(model.minimum)} to ${hostMemory(Math.max(0, maximum()))} for this draft.`},
      {kind: 'facts', rows: [
        ['Planned fixed reservation', `${hostMemory(selected()?.sizeMi)}${selected() ? ` (${selected()!.label})` : ''}`],
        ['Planned dynamic ceiling', Number.isFinite(limit()) && draft.dynamic.trim() ? hostMemory(limit()) : 'Not set'],
        ['Projected Linux RAM after fixed reservation', hostMemory(model.projectedRam(draft.carveoutIndex))],
        ['Minimum Linux RAM outside the dynamic ceiling', Number.isFinite(limit()) ? hostMemory(model.projectedRam(draft.carveoutIndex) - limit()) : 'Unknown'],
      ]},
      ...(!valid() ? [{kind: 'note' as const, tone: 'warn' as const, text: limit() % model.step !== 0 && Number.isFinite(limit())
        ? `Choose a dynamic limit in steps of ${hostMemory(model.step)}.`
        : 'This combination does not leave enough Linux RAM for the required CPU/OS safety allowance. Choose a smaller fixed reservation or dynamic limit.'}] : []),
      ...(feedback ? [{kind: 'note' as const, tone: 'warn' as const, text: feedback}] : []),
      {kind: 'note', text: SHARED_MEMORY_INFO},
    ],
    submit: {
      label: 'review memory configuration',
      disabled: () => memoryBlocked(ctx.snapshot(), ctx.view.ui, findEntry(ctx.snapshot(), key)?.host ?? host, findEntry(ctx.snapshot(), key)?.host?.gpuMemory ?? memory)
        ?? (!(dirty || model.currentLimitExceedsAllowance) ? 'Change the fixed reservation or the dynamic limit first.'
          : !changed() ? 'The draft matches the active configuration.'
            : !valid() ? 'This combination does not leave enough Linux RAM for the required CPU/OS safety allowance.' : undefined),
      run: () => {
        live();
        const settings: HostGpuMemorySettings = {carveoutIndex: draft.carveoutIndex, dynamicLimitMi: limit()};
        const requestId = ctx.requestId();
        const plannedFixed = model.options.find((option) => option.index === settings.carveoutIndex);
        const firmwareChanges = settings.carveoutIndex !== memory.currentCarveoutIndex;
        ctx.confirm({
          title: 'Configure GPU shared memory', back: true, danger: true, expected: host.name, confirmLabel: 'Apply memory configuration',
          description: `${host.name}: fixed GPU reservation ${hostMemory(memory.currentCarveoutMi)} → ${hostMemory(plannedFixed?.sizeMi)}; dynamic GPU ceiling ${hostMemory(memory.currentDynamicLimitMi)} → ${hostMemory(settings.dynamicLimitMi)}. ${firmwareChanges ? 'A firmware reservation change may require up to two restarts: first to apply the firmware setting, then to activate and verify the dynamic limit.' : 'Changing only the dynamic limit requires one restart.'} All workloads on this computer will be interrupted. This is experimental; startup and model success are not guaranteed. Keep local console access and a recovery path. No workload migration is performed. The dynamic limit is a ceiling, not a reservation or guaranteed free memory.`,
          onConfirm: () => ctx.perform('Configure GPU shared memory', async () => {
            live();
            await ctx.api.requestHostOperation(hostPayload(host, 'configure-gpu-memory', requestId, {allowExperimental: true, planId: memory.id, gpuMemory: settings}));
            ctx.view.ui[`hw.memAccepted.${host.nodeUid}`] = requestId;
            return {lines: [`Memory configuration requested for ${host.name}.`, 'Follow the host operation status; a request is not confirmation of a successful restart or applied memory layout.']};
          }),
        });
      },
    },
  });
};

// ---------------------------------------------------------------------------------------------
// Engine validation (DeviceEngineValidation in HardwarePage.tsx)

const validationBlocked = (entry: HardwareNodeEntry, devices: HardwareGpuDevice[], engine: Engine) => {
  if (!devices.length) return 'Select at least one GPU.';
  if (!entry.node.nodeUid) return 'The node identity has not been reported yet.';
  const unavailable = devices.find((device) => !device.validationAvailable);
  if (unavailable) return `${unavailable.name}: ${unavailable.validationReason || 'validation is not available for this GPU.'}`;
  const running = devices.find((device) => ['queued', 'running'].includes(device.validation?.[engine]?.state ?? ''));
  if (running) return `${running.name}: ${engineName(engine)} verification is already ${running.validation?.[engine]?.state}.`;
  return undefined;
};

const validationRows = (snapshot: DashboardSnapshot, state: PageState, entry: HardwareNodeEntry, width: number): Row[] => {
  const admin = canAdminister(snapshot.session);
  const open = state.expanded[`hw:val:${entry.key}`] ?? false;
  const devices = entry.devices;
  return [
    sectionLabel(width, 'Engine validation', 'Optional'),
    ...prose(width, 'Manual diagnostics only. Choose every GPU on this node or one physical device. Tests run sequentially and may wait for active models. Results never disable an otherwise ready GPU.', 'dim'),
    ...ENGINES.flatMap((engine) => [
      fit(width, [span(engineName(engine), undefined, true)], admin ? [button(`gpu:verify-${engine}:${entry.key}`, `Verify ${engineName(engine)}`, 'ghost',
        !devices.length ? 'No physical GPU inventory reported yet.' : !entry.node.nodeUid ? 'The node identity has not been reported yet.' : undefined)] : []),
      ...devices.map((device) => {
        const validation = device.validation?.[engine];
        return fit(width, [gap(2), span(`${device.name} · ${device.pciAddress || 'PCI address unknown'}`)], joinSpans([
          validation?.state === 'passed' ? badge('GPU smoke passed', 'good') : statusBadge(validation?.state ?? 'unverified'),
          ...(validation?.runtimeReady !== undefined ? [badge(validation.runtimeReady ? 'Runtime Ready' : 'Runtime pending', validation.runtimeReady ? 'good' : 'warn')] : []),
        ], 2));
      }),
    ]),
    ...(devices.length ? [fit(width, [toggle(`expand:hw:val:${entry.key}`, open ? 'Hide validation details' : 'Show validation details', open)])] : []),
    ...(open ? ENGINES.flatMap((engine) => devices.flatMap((device) => {
      const validation = device.validation?.[engine];
      return [
        fit(width, [gap(2), span(`${engineName(engine)} · ${device.name} · ${device.pciAddress || 'PCI address unknown'}`, undefined, true)]),
        ...indent(prose(width - 4, validation?.message || 'No local GPU test recorded. Validation is optional.', 'dim'), 4),
        ...(device.validationReason ? indent(prose(width - 4, device.validationReason, 'dim'), 4) : []),
        ...(validation?.image ? indent(prose(width - 4, `Image: ${validation.image}`, 'dim'), 4) : []),
        ...(validation?.validatedAt ? indent(prose(width - 4, `Validated: ${validation.validatedAt}`, 'dim'), 4) : []),
        ...(validation?.runtimeMessage ? indent(prose(width - 4, validation.runtimeMessage, 'dim'), 4) : []),
      ];
    })) : []),
  ];
};

const verifyEngine = (ctx: TuiContext, engine: Engine, key: string) => {
  const entry = findEntry(ctx.snapshot(), key);
  if (!entry) return ctx.missing();
  if (!entry.devices.length) return ctx.message('No GPU to verify', 'No physical GPU inventory reported yet.');
  const draft = {selection: 'all'};
  const liveEntry = () => findEntry(ctx.snapshot(), key);
  const selected = () => (liveEntry()?.devices ?? []).filter((device) => draft.selection === 'all' || device.id === draft.selection);
  const name = engineName(engine);
  ctx.dialog({
    title: `Verify ${name}`,
    description: 'Manual diagnostics only. Tests run sequentially and may wait for active models. Results never disable an otherwise ready GPU.',
    items: (): DialogItem[] => [
      {kind: 'choice', id: 'selection', label: 'GPUs to verify', value: draft.selection, choices: [
        {value: 'all', label: `All GPUs on ${entry.node.node}`},
        ...entry.devices.map((device) => ({value: device.id, label: `${device.name} · ${device.pciAddress || 'PCI address unknown'}`})),
      ], onChange: (value) => { draft.selection = value; }},
      {kind: 'note', tone: 'normal', text: `Verify ${selected().map((device) => `${device.name} (${device.pciAddress})`).join(', ') || 'no GPU'} on ${entry.node.node} using the saved configuration. Unsaved profile changes are not applied. Test images may be downloaded and GPU resources used. Tests are sequential and may wait for active models. Other engines and nodes are not requested. Results are optional smoke checks, not model-size or quality guarantees.`},
      ...selected().filter((device) => device.validationReason).map((device): DialogItem => ({kind: 'note', text: `${device.name}: ${device.validationReason}`})),
    ],
    submit: {
      label: 'run verification',
      disabled: () => {
        const current = liveEntry();
        return current ? validationBlocked(current, selected(), engine) : 'This node is no longer reported.';
      },
      run: () => {
        const current = liveEntry()!;
        const devices = [...selected()];
        return ctx.perform(`Verify ${name}`, async () => {
          await ctx.api.requestGpuValidation({nodeName: current.node.node, nodeUid: current.node.nodeUid ?? '', engine,
            deviceIds: devices.map((device) => device.id), requestId: `dashboard-${Date.now()}-${crypto.randomUUID()}`, acknowledgeResourceUse: true});
          return {lines: [`${name} verification was requested for ${devices.map((device) => device.name).join(', ')} on ${current.node.node}.`, 'Results appear under Engine validation when the tests finish. A request is not a passed test.']};
        });
      },
    },
  });
};

// ---------------------------------------------------------------------------------------------
// The Hardware section

const deviceRows = (snapshot: DashboardSnapshot, state: PageState, entry: HardwareNodeEntry, device: HardwareGpuDevice, width: number): Row[] => {
  const roles = deviceRoles(entry, device);
  const sharing = sharingState(snapshot, entry, device, roles.ownsSharing);
  const open = state.expanded[`hw:dev:${device.id}`] ?? false;
  const inner = width - 2;
  const title = `GPU Configuration ${vendorName(device.vendor)} · ${device.name} · ${device.pciAddress || 'PCI address not reported'}`;
  return [
    fit(width, [toggle(`expand:hw:dev:${device.id}`, title, open)], sharing ? [statusBadge(sharing.phase)] : []),
    ...(open ? indent([
      ...memoryLayoutRows(entry, device, inner),
      blank,
      ...deviceFactRows(device, inner),
      ...(sharing ? [blank, ...sharingRows(snapshot, entry, device, sharing, inner)] : []),
      ...(device.vendor === 'amd' && entry.compatibility && roles.singleProviderDevice ? [blank, ...profileRows(snapshot, entry, entry.compatibility, inner)] : []),
      ...(roles.ownsMemory ? [blank, ...memoryRows(snapshot, state, entry, inner)] : []),
    ]) : []),
  ];
};

const nodeRows = (snapshot: DashboardSnapshot, state: PageState, entry: HardwareNodeEntry, width: number): Row[] => {
  const inner = width - 4;
  return panel(width, {title: `Node: ${entry.node.node}`, meta: plural(entry.devices.length, 'GPU')}, [
    ...(entry.node.message ? prose(inner, entry.node.message, 'dim') : []),
    ...(entry.host ? preparationRows(snapshot, state, entry, inner) : facts(inner, nodeFacts(entry.node))),
    blank,
    sectionLabel(inner, 'GPUs', plural(entry.devices.length, 'device')),
    ...entry.devices.flatMap((device) => deviceRows(snapshot, state, entry, device, inner)),
    ...(entry.devices.length ? [] : [text(inner, 'No physical GPU inventory reported yet.', 'dim')]),
    blank,
    ...validationRows(snapshot, state, entry, inner),
  ]);
};

export const hardwareSection = (snapshot: DashboardSnapshot, state: PageState, width: number): PageView => {
  const inner = width - 4;
  const operators = Object.entries(snapshot.status.hardwareOperators ?? {});
  const nodes = hardwareNodes(snapshot);
  const hostsError = snapshot.errors?.hosts;
  const sharingError = snapshot.errors?.gpuSharing;
  const hostsLoading = !snapshot.hosts && !hostsError;
  const rows: Row[] = [
    ...heading(width, 'Hardware', 'GPUs are available when hardware and driver checks pass and Kubernetes registers the resource. Engine validation is optional.',
      [button('hardware:refresh', 'Refresh hardware')]),
    ...panel(width, {title: 'GPU operators', meta: plural(operators.length, 'operator')}, operators.length ? operators.flatMap(([id, operator]) => [
      fit(inner, [span(operator.displayName ?? id, undefined, true)], [statusBadge(operator.phase)]),
      ...indent(prose(inner - 2, `${operator.detectedNodes?.length ?? 0} nodes · ${operator.allocatableResources ?? 0} GPU resources · ${operator.operatorVersion ?? 'Version unknown'}`, 'dim')),
      ...(operator.message ? indent(prose(inner - 2, operator.message, 'dim')) : []),
    ]) : [text(inner, 'No hardware operator status reported.', 'dim')]),
    blank,
    sectionLabel(width, 'GPU nodes', plural(nodes.length, 'node')),
    ...(hostsError ? prose(width, `Computer information could not be loaded: ${hostsError}`, 'bad') : []),
    ...(sharingError ? prose(width, `GPU sharing state could not be loaded: ${sharingError}`, 'bad') : []),
    ...(hostsLoading ? prose(width, 'Loading computer information…', 'dim') : []),
    ...nodes.flatMap((entry) => nodeRows(snapshot, state, entry, width)),
    ...(!nodes.length && !hostsLoading ? [text(width, 'No GPU nodes reported.', 'dim')] : []),
  ];
  return {hotkeys: [], rows};
};

// ---------------------------------------------------------------------------------------------
// Computer power (HostPowerPanel in HostManagement.tsx)

const powerHost = (snapshot: DashboardSnapshot, ui: Record<string, string>) => {
  const hosts = snapshot.hosts?.nodes ?? [];
  return hosts.find((item) => item.name === ui['power.host']) ?? hosts[0];
};

export const powerSection = (snapshot: DashboardSnapshot, state: PageState, width: number): PageView => {
  const inner = width - 4;
  const error = snapshot.errors?.hosts;
  const accepted = Boolean(state.ui['power.accepted']);
  const hosts = snapshot.hosts?.nodes ?? [];
  const host = powerHost(snapshot, state.ui);
  const loading = !snapshot.hosts && !error;
  const blocked = (item: ManagedHost) => error ? 'Host information is unavailable. Refresh and try again.'
    : !item.available ? 'This computer is unavailable.'
      : activeOperation(item) ? 'Another host operation is in progress.' : undefined;
  const body: Row[] = [
    ...prose(inner, 'Administrator actions for the selected physical computer, not just the dashboard or a container. Each action requires confirmation of the exact computer name.', 'dim'),
    blank,
    ...(loading ? prose(inner, 'Loading computer information…', 'dim') : [
      ...(error ? accepted
        ? notice(inner, 'The request was accepted, but the computer is currently unreachable. Completion cannot be confirmed. No request will be repeated automatically.')
        : prose(inner, `Computer information could not be loaded: ${error}`, 'bad') : []),
      ...(hosts.length > 1 ? [fit(inner, [span('Computer  ', 'dim'), span(host?.name ?? '—', undefined, true)], [button('host:power-select:', 'Change computer')])] : []),
      ...(host ? [
        fit(inner, [span(host.name, undefined, true), gap(2), statusBadge(host.available ? 'Available' : 'Unavailable')], joinSpans([
          button(`host:reboot:${host.nodeUid}`, 'Restart computer', 'ghost', blocked(host)),
          button(`host:poweroff:${host.nodeUid}`, 'Shut down computer', 'danger', blocked(host)),
        ])),
        ...prose(inner, `Kernel: ${host.kernel}${host.message ? ` · ${host.message}` : ''}`, 'dim'),
        ...operationRows(host, ['reboot', 'poweroff'], inner),
      ] : error ? [] : [text(inner, 'No manageable computers reported yet.', 'dim')]),
      ...(accepted && !error ? prose(inner, 'Request accepted. Waiting for the local host worker; this is not confirmation that the computer has restarted or powered off.', 'good') : []),
    ]),
  ];
  return {hotkeys: [], rows: panel(width, {title: 'Computer power'}, body)};
};

const powerAction = (ctx: TuiContext, action: 'reboot' | 'poweroff', nodeUid: string) => {
  const host = (ctx.snapshot().hosts?.nodes ?? []).find((item) => item.nodeUid === nodeUid);
  if (!host) return ctx.missing();
  if (ctx.snapshot().errors?.hosts) return ctx.message('Computer unreachable', 'Host information is unavailable. Refresh and try again.');
  if (!host.available || activeOperation(host)) return ctx.message('Computer busy or unavailable', !host.available ? 'This computer is unavailable.' : 'Another host operation is in progress.');
  const label = action === 'reboot' ? 'Restart computer' : 'Shut down computer';
  const requestId = ctx.requestId();
  ctx.confirm({
    title: label, confirmLabel: label, expected: host.name, danger: true,
    description: `${host.name}: ${action === 'reboot' ? 'Restart' : 'Power off'} this computer in about one minute after the local worker accepts the request. All services and workloads on this computer will be interrupted. ${action === 'poweroff' ? 'You must turn the computer back on locally or use separately configured remote power management. ' : ''}Save your work. There is no automatic migration of workloads.`,
    onConfirm: () => ctx.perform(label, async () => {
      const live = (ctx.snapshot().hosts?.nodes ?? []).find((item) => item.nodeUid === nodeUid);
      if (!live || live.bootId !== host.bootId) throw new Error('The computer restarted or changed in the meantime. Review it again.');
      delete ctx.view.ui['power.accepted'];
      await ctx.api.requestHostOperation(hostPayload(host, action, requestId));
      ctx.view.ui['power.accepted'] = requestId;
      return {lines: [`${label} was requested for ${host.name}.`, 'Request accepted. Waiting for the local host worker; this is not confirmation that the computer has restarted or powered off.']};
    }),
  });
};

// ---------------------------------------------------------------------------------------------
// Actions

const infoMessage = (ctx: TuiContext, verb: string, target: string) => {
  const snapshot = ctx.snapshot();
  if (verb === 'layout-info') {
    const found = findDevice(snapshot, target);
    if (!found?.device.memory) return ctx.missing();
    return ctx.message(`Physical memory layout · ${found.device.memory.node}`, layoutInfo(found.device.memory));
  }
  if (verb === 'sharing-info') {
    const found = findDevice(snapshot, target);
    const state = found && sharingState(snapshot, found.entry, found.device, deviceRoles(found.entry, found.device).ownsSharing);
    if (!state) return ctx.missing();
    return ctx.message(`${vendorName(state.provider)} GPU sharing`, sharingInfo(state, state.backend === 'dra' ? 'dra' : 'device-plugin'));
  }
  if (verb === 'profile-info') {
    const compatibility = findEntry(snapshot, target)?.compatibility;
    const selected = compatibility?.profiles.find((profile) => profile.id === compatibility.selectedProfile);
    return ctx.message('AMD runtime profile', [...PROFILE_INFO,
      ...(selected ? [`${selected.description ?? ''} Profile selection applies only to matching hardware; it does not certify other cards.`.trim()] : []),
      ...(canAdminister(snapshot.session) ? [] : ['Administrator access is required to change profiles or run validation.'])]);
  }
  if (verb === 'memory-info') {
    const host = findEntry(snapshot, target)?.host;
    const memory = host?.gpuMemory;
    return ctx.message(`Shared GPU memory${host ? ` · ${host.name}` : ''}`, [SHARED_MEMORY_INFO,
      ...(memory?.supported ? [`The dynamic ceiling must leave at least ${hostMemory(memoryModel(memory).reserve)} outside GPU dynamic allocations. CPU processes still compete for the shared pool; this does not guarantee available memory or reserve RAM for a model.`] : []),
      ...(memory?.message ? [memory.message] : [])]);
  }
};

const toggleCheck = (ctx: TuiContext, verb: string, key: string) => {
  const host = findEntry(ctx.snapshot(), key)?.host;
  if (!host) return ctx.missing();
  const prep = preparationState(ctx.view.ui, host);
  if (verb === 'experiment') {
    if (!host.plan?.experiment) return ctx.missing();
    if (prep.experiment) delete ctx.view.ui[`hw.experiment.${host.nodeUid}`];
    else ctx.view.ui[`hw.experiment.${host.nodeUid}`] = prep.planKey;
    // As in the browser, switching the plan clears the acknowledgement.
    delete ctx.view.ui[`hw.ack.${host.nodeUid}`];
  } else if (verb === 'ack') {
    if (prep.acknowledged) delete ctx.view.ui[`hw.ack.${host.nodeUid}`];
    else ctx.view.ui[`hw.ack.${host.nodeUid}`] = prep.ackKey;
  }
  ctx.draw();
};

const selectPowerHost = (ctx: TuiContext) => {
  const hosts = ctx.snapshot().hosts?.nodes ?? [];
  const current = powerHost(ctx.snapshot(), ctx.view.ui);
  ctx.menu('Computer', 'Choose the physical computer for power actions.', hosts.map((host) => ({
    label: host.name, hint: host.available ? 'available' : 'unavailable',
    action: () => {
      ctx.view.ui['power.host'] = host.name;
      ctx.close();
    },
  })), Math.max(0, hosts.findIndex((host) => host === current)));
};

export const hardwareModule: AreaModule = {
  // Viewers may refresh and read explanations; every change is administrator-only, as in the browser.
  scopes: {hardware: 'any', hwui: 'admin', host: 'admin', gpu: 'admin'},
  readOnly: ({scope, verb}) => scope === 'hardware' || scope === 'hwui' || (scope === 'host' && verb === 'power-select'),
  handle: (ctx, {scope, verb, target}) => {
    if (scope === 'hardware') {
      if (verb === 'refresh') return ctx.refresh();
      return infoMessage(ctx, verb, target);
    }
    if (scope === 'hwui') return toggleCheck(ctx, verb, target);
    if (scope === 'host') {
      if (verb === 'prepare') return prepareHardware(ctx, target);
      if (verb === 'memory') return configureMemory(ctx, target);
      if (verb === 'reboot' || verb === 'poweroff') return powerAction(ctx, verb, target);
      if (verb === 'power-select') return selectPowerHost(ctx);
      return;
    }
    if (verb === 'sharing') return configureSharing(ctx, target);
    if (verb === 'profile') return changeProfile(ctx, target);
    if (verb === 'verify-OLlama' || verb === 'verify-VLLM') return verifyEngine(ctx, verb.slice(7) as Engine, target);
  },
};
