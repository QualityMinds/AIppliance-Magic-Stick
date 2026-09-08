import {useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {MemoryCalculation} from '@magicstick/dashboard-contracts';

/** Non-modal explanation, portalled so a scrolling model dialog cannot clip it. */
export function MemoryInfo({label, value, calculation, roundedMi}: {
  label: string; value: ReactNode; calculation?: MemoryCalculation; roundedMi?: number;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const overlay = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const skipFocusPreview = useRef(false);
  const [mode, setMode] = useState<'closed' | 'preview' | 'pinned'>('closed');
  const [position, setPosition] = useState({left: 12, top: 12});
  const open = mode !== 'closed';
  const cancelDismiss = () => { clearTimeout(timer.current); };
  const preview = () => { cancelDismiss(); setMode((current) => current === 'closed' ? 'preview' : current); };
  const dismissPreview = () => {
    cancelDismiss();
    timer.current = setTimeout(() => setMode((current) => current === 'preview' ? 'closed' : current), 160);
  };
  const close = (restoreFocus = false) => {
    cancelDismiss(); setMode('closed');
    if (restoreFocus && document.activeElement !== trigger.current) {
      skipFocusPreview.current = true;
      trigger.current?.focus();
    }
  };

  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const box = overlay.current?.getBoundingClientRect();
      if (!anchor || !box) return;
      const left = Math.max(12, Math.min(anchor.right - box.width, window.innerWidth - box.width - 12));
      const below = anchor.bottom + 8;
      const top = below + box.height <= window.innerHeight - 12 ? below : Math.max(12, anchor.top - box.height - 8);
      setPosition({left, top});
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, calculation, roundedMi]);

  useEffect(() => {
    if (mode === 'pinned') overlay.current?.focus();
  }, [mode]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !overlay.current?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [open]);

  const explanation = calculation ?? {formula: 'Calculation details are unavailable from this API response.', notes: ['This value is an estimate, not measured memory usage.']};
  return <span className="memory-value">{value}
    <button ref={trigger} type="button" className="memory-info-button" aria-label={`Explain ${label}`} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
      onMouseEnter={preview} onMouseLeave={dismissPreview}
      onFocus={() => { if (skipFocusPreview.current) skipFocusPreview.current = false; else preview(); }}
      onBlur={(event) => { if (!overlay.current?.contains(event.relatedTarget as Node)) dismissPreview(); }}
      onClick={() => { cancelDismiss(); if (mode === 'pinned') close(); else setMode('pinned'); }}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.7"/><circle cx="12" cy="7.5" r="1.1" fill="currentColor"/><path d="M10.5 11H12v6m-2 0h4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>
    </button>
    {open && createPortal(<section id={id} ref={overlay} tabIndex={-1} role="dialog" aria-label={`${label} calculation`} className="memory-info-overlay" style={position}
      onMouseEnter={cancelDismiss} onMouseLeave={dismissPreview}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) close(); }}>
      <header><strong>{label}</strong><button type="button" className="memory-info-close" aria-label="Close explanation" onClick={() => close(true)}>×</button></header>
      <p className="memory-info-caption">Formula</p><p className="memory-info-formula">{explanation.formula}</p>
      {explanation.substitution && <><p className="memory-info-caption">With your values</p><p className="memory-info-formula memory-info-result">{explanation.substitution}</p></>}
      {explanation.notes?.map((note, index) => <p className="memory-info-note" key={index}>{note}</p>)}
      {roundedMi !== undefined && <p className="memory-info-note">UI budget: max(100, ceil({roundedMi.toLocaleString('en-US')} ÷ 100) × 100) = {Math.max(100, Math.ceil(roundedMi / 100) * 100).toLocaleString('en-US')} MiB. Reservation budgets round up to 100 MiB; compact GiB labels are display rounding only.</p>}
      <p className="memory-info-note">1 MiB = 1,048,576 bytes · 1 GiB = 1,024 MiB.</p>
    </section>, document.body)}
  </span>;
}

export const unreservedCalculation = (availableMi?: number | null): MemoryCalculation => ({
  formula: 'device/node capacity − existing reservations; slider maximum = floor(unreserved MiB ÷ 100) × 100',
  substitution: availableMi !== null && availableMi !== undefined ? `floor(${availableMi.toLocaleString('en-US')} ÷ 100) × 100 = ${(Math.floor(availableMi / 100) * 100).toLocaleString('en-US')} MiB` : 'Unreserved capacity is unknown.',
  notes: ['Unreserved capacity is not the same as currently unused memory. Other workloads can consume RAM/VRAM. Capacity is per eligible device/node, not a sum across nodes.'],
});
