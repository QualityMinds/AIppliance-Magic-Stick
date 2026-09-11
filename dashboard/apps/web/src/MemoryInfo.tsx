import type {ReactNode} from 'react';
import type {MemoryCalculation} from '@magicstick/dashboard-contracts';
import {InfoPopover} from './InfoPopover';

/** Non-modal explanation, portalled so a scrolling model dialog cannot clip it. */
export function MemoryInfo({label, value, calculation, roundedMi}: {
  label: string; value: ReactNode; calculation?: MemoryCalculation; roundedMi?: number;
}) {
  const explanation = calculation ?? {formula: 'Calculation details are unavailable from this API response.', notes: ['This value is an estimate, not measured memory usage.']};
  return <span className="memory-value">{value}
    <InfoPopover label={label} dialogLabel={`${label} calculation`}>
      <p className="memory-info-caption">Formula</p><p className="memory-info-formula">{explanation.formula}</p>
      {explanation.substitution && <><p className="memory-info-caption">With your values</p><p className="memory-info-formula memory-info-result">{explanation.substitution}</p></>}
      {explanation.notes?.map((note, index) => <p className="memory-info-note" key={index}>{note}</p>)}
      {roundedMi !== undefined && <p className="memory-info-note">UI budget: max(100, ceil({roundedMi.toLocaleString('en-US')} ÷ 100) × 100) = {Math.max(100, Math.ceil(roundedMi / 100) * 100).toLocaleString('en-US')} MiB. Reservation budgets round up to 100 MiB; compact GiB labels are display rounding only.</p>}
      <p className="memory-info-note">1 MiB = 1,048,576 bytes · 1 GiB = 1,024 MiB.</p>
    </InfoPopover>
  </span>;
}

export const unreservedCalculation = (availableMi?: number | null): MemoryCalculation => ({
  formula: 'device/node capacity − existing reservations; slider maximum = floor(unreserved MiB ÷ 100) × 100',
  substitution: availableMi !== null && availableMi !== undefined ? `floor(${availableMi.toLocaleString('en-US')} ÷ 100) × 100 = ${(Math.floor(availableMi / 100) * 100).toLocaleString('en-US')} MiB` : 'Unreserved capacity is unknown.',
  notes: ['Unreserved capacity is not the same as currently unused memory. Other workloads can consume RAM/VRAM. Capacity is per eligible device/node, not a sum across nodes.'],
});
