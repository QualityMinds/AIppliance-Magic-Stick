import type {CSSProperties} from 'react';
import {formatMi} from '@magicstick/dashboard-core';
import type {ComputeMemoryDevice, ModelsPayload, SharedMemoryPool} from '@magicstick/dashboard-contracts';
import {InfoPopover} from './InfoPopover';

const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const amount = (value?: number | null) => known(value) ? value : null;
const capacity = (value?: number | null) => known(value) && value > 0 ? value : null;
const within = (value: number | null, maximum: number | null) => value !== null && maximum !== null ? Math.min(value, maximum) : null;
const display = (value?: number | null) => known(value) ? formatMi(value) : 'Not reported';

type Reading = {id: string; label: string; valueMi: number | null; totalMi: number | null; color: string};
type Group = {label: string; totalMi: number | null; readings: Reading[]};
const colors = {free: 'var(--cyan)', unreserved: 'var(--violet)', sharedFree: 'var(--green)', sharedUnreserved: '#70a8ff'};

function gaugeReadings(device: ComputeMemoryDevice, pool?: SharedMemoryPool) {
  const cpu = device.kind === 'cpu' || device.computeTarget === 'cpu';
  const sharedGpu = device.memoryArchitecture === 'unified' && !cpu;
  const total = capacity(device.totalMi);
  const free = device.metricsAvailable === false ? null : amount(device.freeMi);
  const unreserved = amount(device.unreservedMi);
  const reading = (id: string, label: string, valueMi: number | null, totalMi: number | null, color: string): Reading => ({id, label, valueMi, totalMi, color});

  if (!sharedGpu) {
    const freeTotal = cpu && device.memoryArchitecture === 'unified' ? capacity(device.sharedMemoryMi) ?? total : total;
    const readings = [reading('unreserved', 'Unreserved', unreserved, freeTotal, colors.unreserved), reading('free', 'Free', free, freeTotal, colors.free)];
    return {sharedGpu, readings, groups: [{label: cpu ? 'RAM' : 'VRAM', totalMi: freeTotal, readings: [...readings].reverse()}], primary: free !== null ? free : unreserved, primaryLabel: free !== null ? 'actually free' : unreserved !== null ? 'unreserved budget' : 'not reported'};
  }

  // Do not attribute a domain's counters to the other domain, or match another node.
  const mode = device.gpuAllocationMode && pool?.gpuAllocationMode && device.gpuAllocationMode !== pool.gpuAllocationMode
    ? 'unknown' : device.gpuAllocationMode ?? pool?.gpuAllocationMode ?? 'unknown';
  const fixed = mode === 'firmware-reserved';
  const dynamic = mode === 'shared-gtt';
  const dedicatedTotal = amount(pool?.firmwareReservedMi) ?? (fixed ? total : null);
  const sharedTotal = within(capacity(pool?.gpuAccessibleMi), capacity(pool?.physicalMemoryMi));
  const dedicatedFree = fixed ? within(free, dedicatedTotal) : null;
  const dedicatedBudget = fixed ? within(unreserved ?? amount(pool?.gpuUnreservedMi), dedicatedTotal) : null;
  const sharedFree = within(amount(pool?.freeMi), sharedTotal);
  const linuxBudget = amount(pool?.unreservedMi);
  const dynamicBudget = amount(pool?.gpuUnreservedMi) ?? (dynamic ? unreserved : null);
  const sharedBudget = fixed ? within(linuxBudget, sharedTotal)
    : dynamic && linuxBudget !== null && dynamicBudget !== null ? within(Math.min(linuxBudget, dynamicBudget), sharedTotal) : null;
  const readings = [
    reading('dedicated-unreserved', 'Unreserved', dedicatedBudget, dedicatedTotal, colors.unreserved),
    reading('dedicated-free', 'Free', dedicatedFree, dedicatedTotal, colors.free),
    reading('shared-unreserved', 'Unreserved', sharedBudget, sharedTotal, colors.sharedUnreserved),
    reading('shared-free', 'Free', sharedFree, sharedTotal, colors.sharedFree),
  ];
  const groups: Group[] = [
    {label: 'Dedicated', totalMi: dedicatedTotal, readings: [readings[1]!, readings[0]!]},
    {label: 'Shared', totalMi: sharedTotal, readings: [readings[3]!, readings[2]!]},
  ];
  const activeFree = fixed ? dedicatedFree : dynamic ? sharedFree : null;
  const activeBudget = fixed ? dedicatedBudget : dynamic ? sharedBudget : null;
  return {sharedGpu, readings, groups, primary: activeFree ?? activeBudget,
    primaryLabel: activeFree !== null ? `${fixed ? 'dedicated' : 'shared'} free` : activeBudget !== null ? `${fixed ? 'dedicated' : 'shared'} unreserved` : 'not reported'};
}

const MemoryValue = ({value}: {value: number | null}) => value === null ? <span aria-label="Not reported">—</span> : <>{formatMi(value)}</>;

function GaugeDetails({device, pool, sharedGpu}: {device: ComputeMemoryDevice; pool?: SharedMemoryPool; sharedGpu: boolean}) {
  return <>
    <p className="memory-info-note">Free means currently available memory; unreserved means remaining planning budget, not measured free memory. A dashed ring and — mean not reported, not zero.</p>
    {sharedGpu && <>
      <p className="memory-info-note">One GPU, not two deployment targets. Dedicated and shared rings have separate scales and are not added into one model capacity.</p>
      <dl className="gauge-info-facts">
        <div><dt>Installed RAM</dt><dd>{display(pool?.installedMemoryMi)}</dd></div>
        <div><dt>Fixed GPU reservation</dt><dd>{display(pool?.firmwareReservedMi)}</dd></div>
        <div><dt>Linux-visible RAM</dt><dd>{display(pool?.physicalMemoryMi)}</dd></div>
        <div><dt>Dynamic GPU ceiling</dt><dd>{display(pool?.gpuAccessibleMi)}</dd></div>
        <div><dt>Driver-reported model capacity</dt><dd>{display(device.gpuCapacityMi)}</dd></div>
      </dl>
      <p className="memory-info-note">Dedicated free requires live GPU metrics. Linux available RAM is never reported as free dedicated VRAM. Dedicated unreserved is the planning capacity minus GPU model reservations, only when the driver confirms that allocation domain.</p>
      <p className="memory-info-note">Shared free = min(currently available Linux RAM, dynamic GPU ceiling). Shared unreserved = min(remaining Linux RAM budget after system headroom and model requests, dynamic ceiling); when models use the shared pool, its remaining GPU budget also applies.</p>
      <p className="memory-info-note">Shared RAM is also used by the CPU. Neither its ceiling nor Kubernetes requests protect it against other processes. These four readings do not change hardware configuration or the model's allocation domain.</p>
    </>}
    {!sharedGpu && <p className="memory-info-note">The violet ring shows unreserved capacity, the cyan ring current availability. {device.memoryArchitecture === 'unified' ? 'Both rings use Linux-visible RAM as their scale. Unreserved memory excludes system headroom and includes host runtime requests. Firmware-reserved GPU memory is outside this RAM.' : 'Both rings use the reported device capacity.'}</p>}
    {device.memoryArchitecture === 'unified' && <p className="memory-info-note">{device.accountingVerified ? 'GPU memory accounting verified.' : 'GPU memory accounting not yet verified; driver capacity is not an engine allocation guarantee.'}</p>}
    {[...new Set([device.message, device.warning].filter(Boolean))].map((message) => <p key={message} className="memory-info-note">{message}</p>)}
    {device.metricsSource && <p className="memory-info-note">Metrics source: {device.metricsSource}.</p>}
  </>;
}

export function MemoryGauge({device, pool}: {device: ComputeMemoryDevice; pool?: SharedMemoryPool}) {
  const {readings, groups, primary, primaryLabel, sharedGpu} = gaugeReadings(device, pool);
  const name = device.name ?? device.id;
  return <article className={`memory-gauge${sharedGpu ? ' memory-gauge-shared' : ''}`} aria-label={`${name} memory`}>
    <div className="gauge-rings">
      <svg viewBox="0 0 256 140" aria-hidden="true">
        {readings.map((reading, index) => {
          const radius = 122 - index * 13;
          const path = `M ${128 - radius} 132 A ${radius} ${radius} 0 0 1 ${128 + radius} 132`;
          const measured = reading.valueMi !== null && reading.totalMi !== null && reading.totalMi > 0;
          const percent = measured ? Math.min(100, reading.valueMi! / reading.totalMi! * 100) : 0;
          return <g key={reading.id} data-ring={reading.id} data-known={measured} style={{color: reading.color}}>
            <path className={`gauge-track${measured ? '' : ' gauge-track-unknown'}`} d={path} pathLength="100" />
            {percent > 0 && <path className="gauge-progress" d={path} pathLength="100" strokeDasharray={`${percent} 100`} />}
          </g>;
        })}
      </svg>
      <div className="gauge-value"><strong><MemoryValue value={primary} /></strong><span>{primaryLabel}</span></div>
    </div>
    <header className="gauge-heading"><strong>{name}</strong><InfoPopover label={`${name} memory`}><GaugeDetails device={device} pool={pool} sharedGpu={sharedGpu} /></InfoPopover></header>
    <div className={`gauge-legend${sharedGpu ? ' gauge-legend-shared' : ''}`}>
      {groups.map((group) => <section className="gauge-legend-group" key={group.label} aria-label={`${group.label} memory`}>
        <div className="gauge-pool-title"><span>{group.label}</span><span><MemoryValue value={group.totalMi} /></span></div>
        <dl>{group.readings.map((reading) => <div key={reading.id} style={{'--ring-color': reading.color} as CSSProperties} data-reading={reading.id}>
          <dt><i aria-hidden="true" />{reading.label}</dt><dd><MemoryValue value={reading.valueMi} /></dd>
        </div>)}</dl>
      </section>)}
    </div>
  </article>;
}

export function ComputeMemory({memory}: {memory?: ModelsPayload['computeMemory']}) {
  const devices = memory?.devices?.length ? memory.devices : [{id: 'cpu-unavailable', name: 'CPU', kind: 'cpu'}];
  return <section className="compute-memory" aria-label="Compute memory"><p className="eyebrow">Compute Memory</p><div className="memory-grid">
    {devices.map((device) => <MemoryGauge key={device.id} device={device} pool={memory?.sharedPools?.find((pool) => pool.id === device.sharedPoolId)} />)}
  </div></section>;
}
