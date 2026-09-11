import {useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';

/** Hover/focus preview plus a click-to-pin panel, also usable on touch screens. */
export function InfoPopover({label, dialogLabel = label, children}: {
  label: string; dialogLabel?: string; children: ReactNode;
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
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const left = Math.max(12, Math.min(anchor.right - box.width, viewportWidth - box.width - 12));
      const below = anchor.bottom + 8;
      const top = below + box.height <= window.innerHeight - 12 ? below : Math.max(12, anchor.top - box.height - 8);
      setPosition({left, top});
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, children]);

  useEffect(() => { if (mode === 'pinned') overlay.current?.focus(); }, [mode]);
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

  return <>
    <button ref={trigger} type="button" className="memory-info-button" aria-label={`Explain ${label}`} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
      onMouseEnter={preview} onMouseLeave={dismissPreview}
      onFocus={() => { if (skipFocusPreview.current) skipFocusPreview.current = false; else preview(); }}
      onBlur={(event) => { if (!overlay.current?.contains(event.relatedTarget as Node)) dismissPreview(); }}
      onClick={() => { cancelDismiss(); if (mode === 'pinned') close(); else setMode('pinned'); }}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.7"/><circle cx="12" cy="7.5" r="1.1" fill="currentColor"/><path d="M10.5 11H12v6m-2 0h4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>
    </button>
    {open && createPortal(<section id={id} ref={overlay} tabIndex={-1} role="dialog" aria-label={dialogLabel} className="memory-info-overlay" style={position}
      onMouseEnter={cancelDismiss} onMouseLeave={dismissPreview}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) close(); }}>
      <header><strong>{label}</strong><button type="button" className="memory-info-close" aria-label="Close explanation" onClick={() => close(true)}>×</button></header>
      {children}
    </section>, document.body)}
  </>;
}
