import type {SharedMemoryInventory} from '@magicstick/dashboard-contracts';

const known = (value?: number | null): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const memory = (value?: number | null) => !known(value) ? 'Not reported'
  : value < 1024 ? `${Math.round(value)} MiB` : `${Number((value / 1024).toFixed(1))} GiB`;

export const SharedMemoryOverview = ({pool}: {pool: SharedMemoryInventory}) => {
  const {installedMemoryMi: installed, firmwareReservedMi: fixed, physicalMemoryMi: linux} = pool;
  const remainder = known(installed) && known(fixed) && known(linux) ? installed - fixed - linux : null;
  const fixedAllocations = pool.gpuAllocationMode === 'firmware-reserved';
  const dynamicAllocations = pool.gpuAllocationMode === 'shared-gtt';
  const reported = pool.gpuCapacitySource === 'kfd-topology' && (fixedAllocations || dynamicAllocations);
  return <section className="operator-card shared-memory-overview stack compact" aria-label={`Physical memory layout on ${pool.node}`}>
    <header><strong>Physical memory layout · {pool.node}</strong><span className="tag">One GPU · unified physical RAM</span></header>
    <dl className="facts">
      <div><dt>Installed RAM</dt><dd>{memory(installed)}</dd><small className="muted">Reported by firmware (SMBIOS)</small></div>
      <div><dt>Fixed GPU reservation</dt><dd>{memory(fixed)}</dd><small className="muted">Firmware carve-out · unavailable to Linux</small></div>
      <div><dt>Linux-visible RAM</dt><dd>{memory(linux)}</dd><small className="muted">Shared by CPU and dynamic GPU allocations</small></div>
      <div><dt>Dynamic GPU ceiling</dt><dd>{memory(pool.gpuAccessibleMi)}</dd><small className="muted">Within Linux RAM · not reserved or protected</small></div>
      <div><dt>Driver-reported GPU capacity</dt><dd>{memory(reported ? pool.gpuCapacityMi : null)}</dd><small className="muted">{reported ? `KFD topology · ${fixedAllocations ? 'firmware-reserved pool' : 'dynamic Linux RAM'}` : 'Allocation domain not confirmed'}</small></div>
    </dl>
    <p>One GPU, not two deployment targets. Firmware reservation and the dynamic ceiling are not automatically combined into one model capacity. Dynamic GPU memory is part of Linux-visible RAM.</p>
    <details><summary>Allocation and accounting details</summary>
    {remainder !== null && remainder >= 0 && <p className="muted">Installed RAM = fixed GPU reservation + Linux-visible RAM + {memory(remainder)} other firmware/platform memory. The last value is the difference, not an additional GPU pool.</p>}
    {remainder !== null && remainder < 0 && <p className="muted">Firmware and driver totals do not reconcile; no combined capacity is inferred.</p>}
    <p className="muted">{reported ? fixedAllocations
      ? 'Model planning uses the firmware-reserved GPU pool. Only the host runtime request is charged to Linux RAM; GPU weights are not charged twice.'
      : 'Model planning uses dynamic Linux RAM and is limited by both the GPU ceiling and remaining RAM budgets.'
      : 'Model capacity stays unknown until matching driver evidence is available. RAM requests remain conservative.'} Driver capacity is not a successful engine allocation test.</p>
    <p className="muted">The dynamic ceiling and Kubernetes requests do not protect memory from other processes.</p>
    </details>
    <p className="muted">No protected dynamic reserve is promised. GPU memory accounting: {pool.memoryAccountingVerified ? 'verified' : 'not yet verified; no capacity guarantee'}.</p>
  </section>;
};
