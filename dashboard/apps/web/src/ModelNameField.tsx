import {useId, useState} from 'react';
import {Field} from './components';

export const ModelNameField = ({value, onChange, error, disabled = false}: {
  value: string; onChange: (value: string) => void; error?: string; disabled?: boolean;
}) => {
  const id = useId();
  const [touched, setTouched] = useState(false);
  const showError = !disabled && Boolean(error) && (touched || value.length > 0);
  return <div className="stack compact">
    <Field label="Name"><input value={value} disabled={disabled} required
      aria-invalid={showError || undefined} aria-describedby={disabled ? undefined : `${id}-help${showError ? ` ${id}-error` : ''}`}
      onBlur={() => setTouched(true)} onChange={(event) => onChange(event.target.value)} /></Field>
    {!disabled && <small id={`${id}-help`} className="muted">1–63 lowercase letters, numbers or hyphens; start and end with a letter or number.</small>}
    {showError && <p id={`${id}-error`} className="notice notice-error" role="alert">{error}</p>}
  </div>;
};
