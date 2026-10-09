import type {ReactNode} from 'react';
import type {MemoryCalculation} from '@magicstick/dashboard-contracts';
import {InfoPopover} from './InfoPopover';

/** Non-modal explanation, portalled so a scrolling model dialog cannot clip it. */
export function MemoryInfo({label, value, calculation, roundedMi, budgetDevices = 1}: {
  label: string; value: ReactNode; calculation?: MemoryCalculation; roundedMi?: number; budgetDevices?: number;
}) {
  const explanation = calculation ?? {formula: 'Calculation details are unavailable from this API response.', notes: ['This value is an estimate, not measured memory usage.']};
  return <span className="memory-value">{value}
    <InfoPopover label={label} dialogLabel={`${label} calculation`}>
      <p className="memory-info-caption">{budgetDevices > 1 ? 'Formula per GPU' : 'Formula'}</p><p className="memory-info-formula">{explanation.formula}</p>
      {explanation.substitution && <><p className="memory-info-caption">With your values</p><p className="memory-info-formula memory-info-result">{explanation.substitution}</p></>}
      {explanation.notes?.map((note, index) => <p className="memory-info-note" key={index}>{note}</p>)}
      {roundedMi !== undefined && <p className="memory-info-note">{budgetDevices > 1 ? 'Total UI budget' : 'UI budget'}: {budgetDevices > 1 && `${budgetDevices} × `}max(100, ceil({roundedMi.toLocaleString('en-US')} ÷ 100) × 100) = {(budgetDevices * Math.max(100, Math.ceil(roundedMi / 100) * 100)).toLocaleString('en-US')} MiB. Reservation budgets round up to 100 MiB per device; compact GiB labels are display rounding only.</p>}
      <p className="memory-info-note">1 MiB = 1,048,576 bytes · 1 GiB = 1,024 MiB.</p>
    </InfoPopover>
  </span>;
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
