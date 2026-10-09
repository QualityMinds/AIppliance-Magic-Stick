import {useState} from 'react';
import type {ComputeMemoryDevice, NvidiaGpuSelection} from '@magicstick/dashboard-contracts';
import {Button, Field} from './components';
import {formatMi} from '@magicstick/dashboard-core';
import {matchingNvidiaCards} from './NvidiaGpuSelection';
export {matchingNvidiaCards} from './NvidiaGpuSelection';

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

export const NvidiaGpuGroupSelect = ({cards, values, onChange, ownKeys = [], ownActive = false, allowAutomatic = false, maximum = 1, replicated = false}: {
  cards: ComputeMemoryDevice[]; values: string[]; onChange: (values: string[]) => void;
  ownKeys?: string[]; ownActive?: boolean; allowAutomatic?: boolean; maximum?: number; replicated?: boolean;
}) => {
  const primary = cards.find((card) => nvidiaCardKey(card.gpuDevice!) === values[0]);
  const [autoCount, setAutoCount] = useState(Math.max(2, values.length));
  const free = (card: ComputeMemoryDevice) => (card.slots?.free ?? 0) + (ownActive && ownKeys.includes(nvidiaCardKey(card.gpuDevice!)) ? 1 : 0);
  const compatible = primary ? cards.filter((card) => matchingNvidiaCards(primary, card) && free(card) > 0) : [];
  const automatic = () => {
    if (!primary || autoCount > compatible.length || autoCount < 1 || autoCount > maximum) return;
    onChange([nvidiaCardKey(primary.gpuDevice!), ...compatible.map((card) => nvidiaCardKey(card.gpuDevice!)).filter((key) => key !== values[0]).slice(0, autoCount - 1)]);
  };
  return <section className="stack compact">
    <NvidiaGpuSelect cards={cards} value={values[0] ?? ''} onChange={(key) => onChange(key ? [key] : [])}
      ownKey={ownKeys.includes(values[0] ?? '') ? values[0] : undefined} ownActive={ownActive} allowAutomatic={allowAutomatic} />
    {maximum > 1 && primary && <fieldset className="stack compact"><legend>Additional GPUs for this model</legend>
      {cards.filter((card) => nvidiaCardKey(card.gpuDevice!) !== values[0]).map((card) => {
        const key = nvidiaCardKey(card.gpuDevice!); const selected = values.includes(key);
        const reason = !matchingNvidiaCards(primary, card) ? 'Requires matching cards on the same node' : free(card) <= 0 ? 'No free slots' : values.length >= maximum && !selected ? 'Maximum GPU count reached' : '';
        return <label className="check-field" key={key}><input type="checkbox" checked={selected} disabled={!selected && !!reason}
          onChange={() => onChange(selected ? values.filter((value) => value !== key) : [...values, key])} />
          {card.name} · {card.gpuDevice!.nodeName} · {reason || `${free(card)} slots free`} · {formatMi(card.totalMi)} VRAM</label>;
      })}
      {values.slice(1).filter((key) => !cards.some((card) => nvidiaCardKey(card.gpuDevice!) === key)).map((key) =>
        <p role="alert" key={key}>Selected GPU {key} is no longer available. <Button type="button" onClick={() => onChange(values.filter((value) => value !== key))}>Remove missing GPU</Button></p>)}
      <div className="form-grid"><Field label="Automatic GPU count"><input type="number" value={autoCount} onChange={(event) => setAutoCount(Number(event.target.value))} /></Field>
        <Button type="button" onClick={automatic} disabled={!Number.isInteger(autoCount) || autoCount < 1 || autoCount > maximum || autoCount > compatible.length}>Select matching GPUs</Button></div>
      <p className="muted">{values.length} GPU{values.length === 1 ? '' : 's'} selected. {replicated ? 'One complete model copy and one Pod per card, behind one API name.' : 'One model, one Pod.'} One slot per card; the entire group must be available. VRAM is budgeted per card; shared slots do not isolate memory.</p>
    </fieldset>}
  </section>;
};
