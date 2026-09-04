import {useEffect, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {api} from '../api';
import {Button, ErrorNotice, Field, Loading, Panel} from '../components';

export const SettingsPage = () => {
  const queryClient = useQueryClient();
  const query = useQuery({queryKey: ['settings'], queryFn: () => api.settings()});
  const [publicDomain, setPublicDomain] = useState('');
  const [mdnsDomain, setMdnsDomain] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (query.data) {
      setPublicDomain(query.data.publicDomain);
      setMdnsDomain(query.data.mdnsDomain);
    }
  }, [query.data]);
  const mutation = useMutation({
    mutationFn: () => api.updateSettings({publicDomain, mdnsDomain}),
    onSuccess: async () => {
      setMessage('Domain settings saved.');
      await queryClient.invalidateQueries({queryKey: ['settings']});
    },
  });
  if (query.error) return <ErrorNotice error={query.error} />;
  if (query.isPending) return <Loading />;

  return (
    <div className="stack">
      <div className="section-title"><div><h2>Settings</h2><p>Appliance-wide domains used for the dashboard and generated routes.</p></div></div>
      <Panel title="Domains">
        <form className="form-grid" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
          <Field label="Public Domain"><input value={publicDomain} onChange={(event) => setPublicDomain(event.target.value)} placeholder="magicstick.example.com" /></Field>
          <Field label="mDNS Domain"><input value={mdnsDomain} onChange={(event) => setMdnsDomain(event.target.value)} placeholder="magicstick.local" required /></Field>
          <div className="form-actions full"><Button variant="primary" disabled={mutation.isPending}>Save Domains</Button></div>
        </form>
        <ErrorNotice error={mutation.error} />
        {message && <div className="notice notice-good">{message}</div>}
      </Panel>
    </div>
  );
};
