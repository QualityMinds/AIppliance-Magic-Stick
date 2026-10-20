import {useId} from 'react';
import type {ComputeMemoryDevice, NvidiaGpuSelection} from '@magicstick/dashboard-contracts';
import {Button} from './components';
import {formatMi} from '@magicstick/dashboard-core';
import {nvidiaCardMismatch, nvidiaPhysicalCapacityMi} from './NvidiaGpuSelection';
export {matchingNvidiaCards} from './NvidiaGpuSelection';

// Include installation identity: a replacement node must require a new choice,
// even if the same physical GPU UUID reappears in its inventory.
export const nvidiaCardKey = (selection: NvidiaGpuSelection) => `${selection.nodeUid}/${selection.uuid}`;

export const NvidiaGpuGroupSelect = ({cards, values, onChange, ownKeys = [], ownActive = false, allowAutomatic = false, maximum = 1, replicated = false}: {
  cards: ComputeMemoryDevice[]; values: string[]; onChange: (values: string[]) => void;
  ownKeys?: string[]; ownActive?: boolean; allowAutomatic?: boolean; maximum?: number; replicated?: boolean;
}) => {
  const helpId = useId();
  const primary = values.flatMap((key) => cards.filter((card) => nvidiaCardKey(card.gpuDevice!) === key))[0];
  const free = (card: ComputeMemoryDevice) => Math.min(card.slots?.total ?? 0,
    (card.slots?.free ?? 0) + (ownActive && ownKeys.includes(nvidiaCardKey(card.gpuDevice!)) ? 1 : 0));
  return <section className="stack compact">
    <fieldset className="stack compact gpu-card-selection" aria-describedby={helpId}><legend>NVIDIA GPUs</legend>
      {cards.map((card) => {
        const key = nvidiaCardKey(card.gpuDevice!); const selected = values.includes(key);
        const reason = nvidiaCardMismatch(primary ?? card, card) ?? (free(card) <= 0 ? 'No free slots' : values.length >= maximum && !selected ? 'Maximum GPU count reached' : '');
        return <label className="check-field" key={key}><input type="checkbox" checked={selected} disabled={!selected && !!reason}
          onChange={() => onChange(selected ? values.filter((value) => value !== key) : [...values, key])} />
          <span>{card.name} · {card.gpuDevice!.nodeName} · {reason || `${free(card)}/${card.slots?.total ?? 0} slots free`} · {formatMi(nvidiaPhysicalCapacityMi(card))} VRAM</span></label>;
      })}
      {values.filter((key) => !cards.some((card) => nvidiaCardKey(card.gpuDevice!) === key)).map((key) =>
        <label className="check-field" key={key}><input type="checkbox" checked onChange={() => onChange(values.filter((value) => value !== key))} />
          <span>Selected GPU {key} is no longer available. Uncheck it to choose a replacement.</span></label>)}
      {allowAutomatic && <Button type="button" disabled={!values.length} onClick={() => onChange([])}>Use device-plugin assignment</Button>}
      <p id={helpId} className="muted">Select the GPUs to use. Each checkbox selects one physical card; unavailable cards show the reason. Shared slots do not isolate VRAM.</p>
      <p className="muted">{values.length} GPU{values.length === 1 ? '' : 's'} selected. {replicated ? 'One complete model copy and one Pod per card, behind one API name.' : 'One model, one Pod.'} One slot per card; the entire group must be available. VRAM is budgeted per card; shared slots do not isolate memory.</p>
    </fieldset>
  </section>;
};
