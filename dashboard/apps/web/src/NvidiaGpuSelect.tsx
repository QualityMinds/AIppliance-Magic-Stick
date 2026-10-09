import type {ComputeMemoryDevice, NvidiaGpuSelection} from '@magicstick/dashboard-contracts';
import {Field} from './components';
import {formatMi} from '@magicstick/dashboard-core';

// Include installation identity: a replacement node must require a new choice,
// even if the same physical GPU UUID reappears in its inventory.
export const nvidiaCardKey = (selection: NvidiaGpuSelection) => `${selection.nodeUid}/${selection.uuid}`;

export const NvidiaGpuSelect = ({cards, value, onChange, ownKey, ownActive = false, allowAutomatic = false}: {
  cards: ComputeMemoryDevice[]; value: string; onChange: (value: string) => void; ownKey?: string; ownActive?: boolean; allowAutomatic?: boolean;
}) => <><Field label="NVIDIA card"><select value={value} aria-describedby="nvidia-card-help" onChange={(event) => onChange(event.target.value)}>
  {allowAutomatic && <option value="">Automatic NVIDIA assignment (device plugin)</option>}
  {!cards.some((card) => nvidiaCardKey(card.gpuDevice!) === value) && !(allowAutomatic && !value) && <option value={value} disabled>{value ? 'Selected card is no longer available' : 'Choose a card with a free slot'}</option>}
  {cards.map((card) => {
    const credit = ownActive && nvidiaCardKey(card.gpuDevice!) === ownKey ? 1 : 0;
    const free = Math.min(card.slots?.total ?? 0, (card.slots?.free ?? 0) + credit);
    return <option key={card.id} value={nvidiaCardKey(card.gpuDevice!)} disabled={free === 0}>
      {card.name} · {card.gpuDevice!.nodeName} · {free === 0 ? 'no free slots' : `${free}/${card.slots?.total} slots free`} · {formatMi(card.totalMi ?? 0)} VRAM
    </option>;
  })}
</select></Field><p id="nvidia-card-help" className="muted">{allowAutomatic ? 'Device-plugin allocation cannot bind individual cards. Choose automatic assignment to clear the saved DRA selection.' : 'DRA assigns this exact physical GPU. Slots and memory reservations apply only to the selected card. Shared slots do not isolate VRAM.'}</p></>;
