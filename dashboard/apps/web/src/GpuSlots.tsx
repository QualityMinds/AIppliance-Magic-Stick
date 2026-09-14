import type {ComputeTarget, GpuSlots} from '@magicstick/dashboard-contracts';
import {InfoPopover} from './InfoPopover';

export const targetSlots = (target: ComputeTarget | undefined, engine: string) =>
  target?.engineAvailability?.[engine]?.slots ?? target?.slots;
export const slotsFull = (target: ComputeTarget | undefined, engine: string) =>
  targetSlots(target, engine)?.free === 0;

export const SlotRing = ({slots}: {slots: GpuSlots}) => {
  // Larger node pools retain exact counts in the legend and group slots
  // proportionally into at most 32 readable segments.
  const segments = Math.min(32, Math.max(0, Math.trunc(slots.total)));
  if (!segments) return <path data-ring="slots" className="gauge-track gauge-track-unknown" d="M 6 132 A 122 122 0 0 1 250 132" />;
  const angle = Math.PI / segments;
  const gap = Math.min(.022, angle * .15);
  const point = (a: number) => `${128 - 122 * Math.cos(a)} ${132 - 122 * Math.sin(a)}`;
  const freeSegments = Math.floor(Math.max(0, Math.min(slots.total, slots.free)) / slots.total * segments);
  return <g data-ring="slots">{Array.from({length: segments}, (_, index) =>
    <path key={index} data-slot={index < freeSegments ? 'free' : 'used'} className="gauge-slot"
      d={`M ${point(index * angle + gap)} A 122 122 0 0 1 ${point((index + 1) * angle - gap)}`} />,
  )}</g>;
};

export const SlotLegend = ({slots, name}: {slots: GpuSlots; name: string}) => <div className="gauge-slot-legend" aria-label={`${name} model slots`}>
  <i aria-hidden="true" /><span>{slots.scope === 'node' ? 'Node slots' : slots.scope === 'target' ? 'Target slots' : 'Slots'}</span>
  <strong>{slots.free} / {slots.total} free</strong>
  <InfoPopover label={`${name} model slots`}>
    <p className="memory-info-note">{slots.used} occupied, {slots.free} free, {slots.total} total. Each segment represents a model slot (grouped proportionally above 32 slots). Gold is free; grey is occupied.</p>
    <p className="memory-info-note">Slots are shared by Ollama and vLLM, independently of RAM or VRAM. Starting models reserve slots too. A managed model and its pod are counted only once; other GPU workloads also consume slots. Deleting a model releases its slot after its pod stops.</p>
    {slots.scope !== 'device' && <p className="memory-info-note">This is a shared scheduling pool, not a confirmed assignment to an individual GPU. Models without a confirmed node are counted conservatively in node views.</p>}
    {!!slots.queued && <p className="memory-info-note">{slots.queued} additional slot requests are waiting.</p>}
  </InfoPopover>
</div>;
