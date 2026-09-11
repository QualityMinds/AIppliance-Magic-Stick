import type {SharedMemoryInventory} from '@magicstick/dashboard-contracts';
import {InfoPopover} from './InfoPopover';

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
    <header><div className="inline-info"><strong>Physical memory layout · {pool.node}</strong><InfoPopover label={`Physical memory layout on ${pool.node}`}>
      <p className="memory-info-note">One GPU, not two deployment targets. Firmware reservation and the dynamic ceiling are not automatically combined into one model capacity. Dynamic GPU memory is part of Linux-visible RAM.</p>
      <p className="memory-info-note">Installed RAM is reported by firmware (SMBIOS). Fixed GPU memory is carved out by firmware and unavailable to Linux. The dynamic GPU ceiling is within Linux RAM · not reserved or protected.</p>
      {remainder !== null && remainder >= 0 && <p className="memory-info-note">Installed RAM = fixed GPU reservation + Linux-visible RAM + {memory(remainder)} other firmware/platform memory. The last value is the difference, not an additional GPU pool.</p>}
      {remainder !== null && remainder < 0 && <p className="memory-info-note">Firmware and driver totals do not reconcile; no combined capacity is inferred.</p>}
      <p className="memory-info-note">{reported ? `Driver capacity: KFD topology · ${fixedAllocations ? 'firmware-reserved pool' : 'dynamic Linux RAM'}.` : 'Allocation domain not confirmed.'}</p>
      <p className="memory-info-note">{reported ? fixedAllocations
        ? 'Model planning uses the firmware-reserved GPU pool. Only the host runtime request is charged to Linux RAM; GPU weights are not charged twice.'
        : 'Model planning uses dynamic Linux RAM and is limited by both the GPU ceiling and remaining RAM budgets.'
        : 'Model capacity stays unknown until matching driver evidence is available. RAM requests remain conservative.'} Driver capacity is not a successful engine allocation test.</p>
      <p className="memory-info-note">The dynamic ceiling and Kubernetes requests do not protect memory from other processes. No protected dynamic reserve is promised. GPU memory accounting: {pool.memoryAccountingVerified ? 'verified' : 'not yet verified; no capacity guarantee'}.</p>
    </InfoPopover></div><span className="tag">One GPU · unified physical RAM</span></header>
    <dl className="facts">
      <div><dt>Installed RAM</dt><dd>{memory(installed)}</dd></div>
      <div><dt>Fixed GPU reservation</dt><dd>{memory(fixed)}</dd></div>
      <div><dt>Linux-visible RAM</dt><dd>{memory(linux)}</dd></div>
      <div><dt>Dynamic GPU ceiling</dt><dd>{memory(pool.gpuAccessibleMi)}</dd></div>
      <div><dt>Driver-reported GPU capacity</dt><dd>{memory(reported ? pool.gpuCapacityMi : null)}</dd></div>
    </dl>
    <span className="tag">Accounting {pool.memoryAccountingVerified ? 'verified' : 'unverified'}</span>
  </section>;
};
