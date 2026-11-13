import {useEffect, useRef, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {consoleAccessLabel} from '@magicstick/dashboard-core';
import {CONSOLE_ACCESS_LEVELS, type ConsoleAccessLevel} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ErrorNotice, Field, Loading, Panel} from '../components';
import {InfoPopover} from '../InfoPopover';

/** Access of the appliance's attached monitor and keyboard without a login. */
export const ConsoleAccessSettings = () => {
  const queryClient = useQueryClient();
  const query = useQuery({queryKey: ['console-access'], queryFn: () => api.consoleAccess()});
  const [draft, setDraft] = useState<ConsoleAccessLevel>('off');
  const baseline = useRef<ConsoleAccessLevel | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!query.data) return;
    const previous = baseline.current, next = query.data.accessLevel;
    // A refetch updates a pristine selection but never an unsaved choice.
    setDraft((current) => previous === null || current === previous ? next : current);
    baseline.current = next;
  }, [query.data]);
  const mutation = useMutation({
    mutationFn: () => api.updateConsoleAccess(draft),
    onSuccess: async (result) => {
      setMessage(`Local console sign-in saved: ${consoleAccessLabel(result.accessLevel)}.`);
      await queryClient.invalidateQueries({queryKey: ['console-access']});
    },
  });
  if (query.error) return <ErrorNotice error={query.error} />;
  if (query.isPending) return <Loading />;
  const {available, accessLevel} = query.data;
  const saveable = available && draft !== accessLevel && !mutation.isPending;

  return (
    <div className="stack">
      <Panel title="Local console" actions={<InfoPopover label="About local console sign-in">
        <p>The monitor and keyboard attached to the appliance show the terminal dashboard. It signs in automatically, so the appliance can be operated without a network connection or a second device.</p>
        <p>With <strong>Off</strong>, the console asks for a user sign-in that is confirmed in a browser on another device. A user can always switch to their own account there.</p>
      </InfoPopover>}>
        {!available && <div className="notice" role="status">This appliance has not set up automatic console sign-in yet. It becomes available after the next platform update.</div>}
        <form className="form-grid" onSubmit={(event) => { event.preventDefault(); if (saveable) mutation.mutate(); }}>
          <Field label="Automatic sign-in">
            <select value={draft} disabled={!available} onChange={(event) => { setMessage(''); setDraft(event.target.value as ConsoleAccessLevel); }}>
              {CONSOLE_ACCESS_LEVELS.map((level) => <option key={level} value={level}>{consoleAccessLabel(level)}</option>)}
            </select>
          </Field>
          {available && draft !== 'off' && <div className="notice notice-warn full" role="note">
            Anyone with physical access to the attached keyboard gets {consoleAccessLabel(draft)} access without a password.
          </div>}
          <div className="form-actions full"><Button variant="primary" disabled={!saveable}>Save Local Console</Button></div>
        </form>
        <ErrorNotice error={mutation.error} />
        {message && <div className="notice notice-good">{message}</div>}
      </Panel>
    </div>
  );
};
