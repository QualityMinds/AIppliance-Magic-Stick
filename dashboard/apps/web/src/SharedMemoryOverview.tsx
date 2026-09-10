import type {SharedMemoryInventory} from '@magicstick/dashboard-contracts';

const known = (value?: number | null): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const memory = (value?: number | null) => !known(value) ? 'Not reported'
  : value < 1024 ? `${Math.round(value)} MiB` : `${Number((value / 1024).toFixed(1))} GiB`;

export const SharedMemoryOverview = ({pool}: {pool: SharedMemoryInventory}) => {
  const {installedMemoryMi: installed, firmwareReservedMi: fixed, physicalMemoryMi: linux} = pool;
  const remainder = known(installed) && known(fixed) && known(linux) ? installed - fixed - linux : null;
  return <section className="operator-card shared-memory-overview stack compact" aria-label={`Physical memory layout on ${pool.node}`}>
    <header><strong>Physical memory layout · {pool.node}</strong><span className="tag">Shared CPU / GPU memory</span></header>
    <dl className="facts">
      <div><dt>Installed RAM</dt><dd>{memory(installed)}</dd><small className="muted">Reported by firmware (SMBIOS)</small></div>
      <div><dt>Fixed GPU reservation</dt><dd>{memory(fixed)}</dd><small className="muted">Firmware carve-out · unavailable to Linux</small></div>
      <div><dt>Linux-visible RAM</dt><dd>{memory(linux)}</dd><small className="muted">Shared by CPU and dynamic GPU allocations</small></div>
      <div><dt>Dynamic GPU ceiling</dt><dd>{memory(pool.gpuAccessibleMi)}</dd><small className="muted">Within Linux RAM · not additional memory</small></div>
    </dl>
    <p>These are not independent capacities. The dynamic GPU ceiling is part of Linux-visible RAM, not extra RAM and not a reservation.</p>
    {remainder !== null && remainder >= 0 && <p className="muted">Installed RAM = fixed GPU reservation + Linux-visible RAM + {memory(remainder)} other firmware/platform memory. The last value is the difference, not an additional GPU pool.</p>}
    {remainder !== null && remainder < 0 && <p className="muted">Firmware and driver totals do not reconcile; no combined capacity is inferred.</p>}
    <p className="muted">Model budgets use a conservative part of Linux RAM. The fixed GPU reservation is shown separately and is not added to that budget. Memory accounting: {pool.memoryAccountingVerified ? 'verified' : 'not yet verified; no capacity guarantee'}.</p>
  </section>;
};
