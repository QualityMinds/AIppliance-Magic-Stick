import {useRef, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {LicensePreview, LicenseVerification} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ErrorNotice, Field, Loading, Panel} from '../components';

const date = (value?: number) => value === undefined ? '—' : new Date(value * 1000).toLocaleString();
const ClaimDetails = ({value}: {value: LicenseVerification}) => <>
  <p className={value.valid ? 'notice notice-good' : 'notice'}>{value.message}</p>
  {value.claims && <dl className="license-details">
    <dt>License ID</dt><dd>{value.claims.licenseId}</dd>
    <dt>Customer</dt><dd>{value.claims.customer}</dd>
    <dt>Valid from</dt><dd>{date(value.claims.notBefore)}</dd>
    <dt>Expires</dt><dd>{date(value.claims.expiresAt)}</dd>
    <dt>Signing key</dt><dd>{value.keyId}</dd>
  </dl>}
</>;

export const LicensePage = () => {
  const cache = useQueryClient();
  const query = useQuery({queryKey: ['license'], queryFn: () => api.licenseStatus(), refetchInterval: 30_000});
  const [document, setDocument] = useState('');
  const [filename, setFilename] = useState('');
  const [preview, setPreview] = useState<LicensePreview>();
  const [error, setError] = useState<Error>();
  const [message, setMessage] = useState('');
  const selection = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const inspect = useMutation({mutationFn: async () => {
    const version = selection.current;
    const result = await api.inspectLicense(document);
    if (version === selection.current) setPreview(result);
  }, onError: () => setPreview(undefined)});
  const activate = useMutation({mutationFn: () => {
    if (!preview?.candidate.valid) throw new Error('Validate a license before activating it.');
    return api.importLicense(document, preview.current.revision);
  }, onSuccess: async (result) => {
    setPreview(undefined); setDocument(''); setFilename('');
    if (fileInput.current) fileInput.current.value = '';
    cache.setQueryData(['license'], result);
    setMessage('License saved. Enterprise features remain unavailable until implemented.');
    await cache.invalidateQueries({queryKey: ['license']});
  }, onError: () => setPreview(undefined)});
  const download = useMutation({mutationFn: async () => {
    const result = await api.exportLicense();
    const url = URL.createObjectURL(new Blob([result.content], {type: 'application/json'}));
    const link = window.document.createElement('a');
    link.href = url; link.download = result.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }});
  const busy = inspect.isPending || activate.isPending;
  const selectFile = async (file?: File) => {
    const version = ++selection.current;
    setPreview(undefined); setDocument(''); setFilename(''); setError(undefined); setMessage('');
    inspect.reset(); activate.reset();
    if (!file) return;
    if (file.size > 64 * 1024) { setError(new Error('License file exceeds 64 KiB.')); return; }
    try {
      const content = await file.text();
      if (version === selection.current) { setDocument(content); setFilename(file.name); }
    } catch { setError(new Error('Could not read the selected file.')); }
  };
  if (query.isPending) return <Loading />;
  if (query.error || !query.data) return <ErrorNotice error={query.error ?? new Error('License state unavailable.')} />;
  const status = query.data;
  return <div className="stack">
    <div className="section-title"><div><h2>License &amp; Enterprise</h2><p>Offline-verifiable licenses. Community stays available without a license.</p></div></div>
    <Panel title={status.valid ? 'Valid license' : 'License status'}>
      <ClaimDetails value={status} />
      <p className="muted">Installation ID: <code>{status.installationId}</code></p>
      <p className="muted">Checked: {date(status.checkedAt)}</p>
      <p className="muted">Trusted signing keys: {status.trustedKeyIds.join(', ') || 'None configured'}</p>
      {!status.trustedKeyIds.length && <p className="notice">Install the issuer’s public trust store before importing a license. Never upload a private signing key.</p>}
      <Button type="button" disabled={!status.hasDocument || download.isPending} onClick={() => download.mutate()}>Export license</Button>
      <ErrorNotice error={download.error} />
    </Panel>
    <Panel title="Import or replace license">
      <Field label="License file"><input ref={fileInput} type="file" accept=".json,.license,application/json" disabled={busy} onChange={(event) => void selectFile(event.target.files?.[0])} /></Field>
      <p className="muted">Maximum 64 KiB. Files are checked before storage. An invalid upload cannot replace the active license.</p>
      {filename && <p>Selected: {filename}</p>}
      <Button type="button" disabled={!document || busy} onClick={() => inspect.mutate()}>Validate license</Button>
      <ErrorNotice error={error ?? inspect.error ?? activate.error} />
      {preview && <div className="stack" aria-label="License preview">
        <h3>Import preview</h3><ClaimDetails value={preview.candidate} />
        {preview.candidate.claims && <>
          <p>Current license: {preview.current.claims?.licenseId ?? 'None'} → {preview.candidate.claims.licenseId}</p>
          <p>Entitlements: {preview.candidate.claims.features.join(', ') || 'None'}</p>
          <p>Replaces all previous entitlements. No missing Enterprise code will be activated.</p>
        </>}
        <Button variant="primary" type="button" disabled={!preview.candidate.valid || busy} onClick={() => activate.mutate()}>Activate license</Button>
      </div>}
      {message && <p role="status" className="notice notice-good">{message}</p>}
    </Panel>
    <Panel title="Enterprise capabilities">
      <p className="muted">Licensing foundation only. All seven business capabilities below are planned, not implemented.</p>
      <div className="table-wrap"><table><thead><tr><th>Capability</th><th>License entitlement</th><th>Implementation</th></tr></thead><tbody>
        {status.features.map((feature) => <tr key={feature.id}><td>{feature.name}</td><td>{feature.licensed ? 'Licensed' : 'Not licensed'}</td><td>{feature.implemented ? 'Implemented' : 'Not implemented'}</td></tr>)}
      </tbody></table></div>
    </Panel>
  </div>;
};
