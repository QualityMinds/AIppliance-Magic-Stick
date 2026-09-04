import {useEffect, useState, type ButtonHTMLAttributes, type PropsWithChildren, type ReactNode} from 'react';
import {phaseTone, progressForPhase, type ResourceLink} from '@magicstick/dashboard-core';

export const StatusBadge = ({phase = 'Unknown'}: {phase?: string}) => (
  <span className={`status status-${phaseTone(phase)}`}>{phase}</span>
);

export const Panel = ({title, meta, actions, children, className = ''}: PropsWithChildren<{
  title?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}>) => (
  <section className={`panel ${className}`.trim()}>
    {(title || meta || actions) && (
      <header className="panel-header">
        <div>
          {title && <h2>{title}</h2>}
          {meta && <p className="muted panel-meta">{meta}</p>}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </header>
    )}
    {children}
  </section>
);

export const Button = ({variant = 'default', ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
}) => <button {...props} className={`button button-${variant} ${props.className ?? ''}`.trim()} />;

export const CopyButton = ({value, label = 'Copy', copiedLabel = 'Copied'}: {value: string; label?: string; copiedLabel?: string}) => {
  const [copied, setCopied] = useState(false);
  return <Button type="button" variant="ghost" onClick={async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }}>{copied ? copiedLabel : label}</Button>;
};

export const Empty = ({children}: PropsWithChildren) => <div className="empty">{children}</div>;

export const ErrorNotice = ({error}: {error: unknown}) => {
  if (!error) return null;
  return <div className="notice notice-error" role="alert">{error instanceof Error ? error.message : String(error)}</div>;
};

export const Loading = () => <div className="loading" aria-live="polite">Loading current appliance state…</div>;

export const ProgressBar = ({phase, enabled = true, message}: {phase?: string; enabled?: boolean; message?: string}) => {
  const progress = progressForPhase(phase, enabled, message);
  return <div className={`progress progress-${progress.tone}`} aria-label={`${progress.label}: ${progress.value}%`}>
    <div className="progress-label"><span>{progress.label}</span><span>{progress.value}%</span></div>
    <div className="progress-track"><span style={{width: `${progress.value}%`}} /></div>
  </div>;
};

export const ResourceLinks = ({links}: {links: ResourceLink[]}) => links.length ? <div className="resource-links">
  {links.map((link) => <div className="resource-link" key={link.url}>
    <span className={`scope scope-${link.scope}`}>{link.scope}</span>
    <a href={link.url} target="_blank" rel="noreferrer">{link.label}</a>
    <CopyButton value={link.url} />
  </div>)}
</div> : null;

export const Field = ({label, hint, children}: PropsWithChildren<{label: string; hint?: string}>) => (
  <label className="field">
    <span>{label}</span>
    {children}
    {hint && <small>{hint}</small>}
  </label>
);

export const Dialog = ({open, title, description, children, onClose}: PropsWithChildren<{
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
}>) => {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="panel-header">
          <div><h2>{title}</h2>{description && <p className="muted panel-meta">{description}</p>}</div>
          <Button variant="ghost" onClick={onClose} aria-label="Close dialog">Close</Button>
        </header>
        {children}
      </section>
    </div>
  );
};

export const ConfirmDialog = ({open, title, description, confirmLabel = 'Confirm', valueLabel, expectedValue, busy, error, onClose, onConfirm}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  valueLabel?: string;
  expectedValue?: string;
  busy?: boolean;
  error?: unknown;
  onClose: () => void;
  onConfirm: () => void;
}) => {
  const [confirmation, setConfirmation] = useState('');
  useEffect(() => { if (!open) setConfirmation(''); }, [open]);
  const valid = expectedValue === undefined || confirmation === expectedValue;
  return <Dialog open={open} title={title} description={description} onClose={onClose}>
    <div className="stack compact">
      {expectedValue !== undefined && <Field label={valueLabel ?? `Type ${expectedValue} to confirm`}><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></Field>}
      <ErrorNotice error={error} />
      <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="button" variant="danger" disabled={!valid || busy} onClick={onConfirm}>{confirmLabel}</Button></div>
    </div>
  </Dialog>;
};
