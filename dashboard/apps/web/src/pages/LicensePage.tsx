import {useRef, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {LicenseDownload, LicensePreview, LicenseRequestInput, LicenseStatus, LicenseVerification} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ErrorNotice, Field, Loading, Panel} from '../components';
import {SoftwareLicenses} from '../SoftwareLicenses';
import {InfoPopover} from '../InfoPopover';

const date = (value?: number) => value === undefined ? '—' : new Date(value * 1000).toLocaleString();
const downloadJson = ({filename, content}: LicenseDownload) => {
  const url = URL.createObjectURL(new Blob([content], {type: 'application/json'}));
  const link = window.document.createElement('a');
  link.href = url; link.download = filename;
  window.document.body.appendChild(link);
  try { link.click(); } finally {
    link.remove();
    setTimeout(URL.revokeObjectURL.bind(URL, url), 1000);
  }
};

const LicenseRequestPanel = ({status}: {status: LicenseStatus}) => {
  const [customer, setCustomer] = useState(status.claims?.customer ?? '');
  const [edition, setEdition] = useState<'free-registered' | 'commercial'>(status.valid && status.claims?.edition === 'commercial' ? 'commercial' : 'free-registered');
  const [ttl, setTtl] = useState('30');
  const [unit, setUnit] = useState('days');
  const features = edition === 'commercial' ? ['commercial-production', 'federated-sso'] : ['federated-sso'];
  const ttlSeconds = Number(ttl) * (unit === 'hours' ? 3600 : 86400);
  const valid = Boolean(customer.trim()) && customer.trim().length <= 160 && !/[\u0000-\u001f\u007f]/u.test(customer)
    && Number.isSafeInteger(Number(ttl)) && Number(ttl) > 0 && Number.isSafeInteger(ttlSeconds) && features.length > 0;
  const request = useMutation({mutationFn: async (payload: LicenseRequestInput) => {
    downloadJson(await api.createLicenseRequest(payload));
  }});
  return <Panel title={<span className="inline-info">Request license <InfoPopover label="License request">
    <p>Download unsigned JSON for your license provider to review and sign. It is bound to this installation and does not change the active license.</p>
    <p>TTL starts when the file is generated, not when the signed license is imported. One day is 24 hours. Your provider approves the final modules and validity.</p>
    <p>A module needs both a valid entitlement and an installed implementation. Requesting an unimplemented module does not make it available.</p>
  </InfoPopover></span>}>
    <form className="stack" onSubmit={(event) => {
      event.preventDefault();
      if (valid && !request.isPending) request.mutate({customer: customer.trim(), edition, features, ttlSeconds});
    }}>
      <div className="form-grid three">
        <Field label="Requested edition"><select value={edition} disabled={request.isPending} onChange={(event) => {setEdition(event.target.value as typeof edition); request.reset();}}><option value="free-registered">Free Registered</option><option value="commercial">Commercial</option></select></Field>
        <Field label="Customer reference"><input required maxLength={160} autoComplete="organization" value={customer} disabled={request.isPending} onChange={(event) => { setCustomer(event.target.value); request.reset(); }} /></Field>
        <Field label="Validity (TTL)"><input type="number" min={1} step={1} required value={ttl} disabled={request.isPending} onChange={(event) => { setTtl(event.target.value); request.reset(); }} /></Field>
        <Field label="TTL unit"><select value={unit} disabled={request.isPending} onChange={(event) => { setUnit(event.target.value); request.reset(); }}><option value="days">Days</option><option value="hours">Hours</option></select></Field>
      </div>
      <div className="table-wrap"><table><caption>Edition entitlements</caption><thead><tr><th scope="col">Included in request</th><th scope="col">Current entitlement</th><th scope="col">Implementation</th></tr></thead><tbody>
        {status.features.map((feature) => <tr key={feature.id}>
          <td>{features.includes(feature.id) ? '✓ ' : '— '}{feature.name}</td>
          <td>{feature.licensed ? 'Licensed' : 'Not licensed'}</td><td>{feature.implemented ? 'Implemented' : 'Not implemented'}</td>
        </tr>)}
      </tbody></table></div>
      <div className="form-actions"><Button type="submit" variant="primary" disabled={!valid || request.isPending}>{request.isPending ? 'Preparing JSON…' : 'Download JSON for signing'}</Button></div>
      <ErrorNotice error={request.error} />
      {request.isSuccess && <p role="status" className="notice notice-good">Unsigned request downloaded. Send it to your license provider for signing.</p>}
    </form>
  </Panel>;
};

const ClaimDetails = ({value}: {value: LicenseVerification}) => <>
  <p className={value.valid ? 'notice notice-good' : 'notice'}>{value.message}</p>
  {value.claims && <dl className="license-details">
    <dt>Edition</dt><dd>{value.claims.edition === 'commercial' ? 'Commercial' : 'Free Registered'}</dd>
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
    setMessage('License saved. Installed capabilities with a valid entitlement are now available.');
    await cache.invalidateQueries({queryKey: ['license']});
  }, onError: () => setPreview(undefined)});
  const download = useMutation({mutationFn: async () => {
    downloadJson(await api.exportLicense());
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
  if (query.isPending) return <div className="stack"><Loading /><SoftwareLicenses /></div>;
  if (query.error || !query.data) return <div className="stack"><ErrorNotice error={query.error ?? new Error('License state unavailable.')} /><SoftwareLicenses /></div>;
  const status = query.data;
  return <div className="stack">
    <div className="section-title"><h2>License</h2></div>
    <Panel title="Free"><p>No license file required for personal use and eligible organizations under the Free Use Grant, including businesses with consolidated Group revenue up to EUR 2,000,000. All core functions, Resource Sharing and Private Mesh are available. Federated SSO requires registration.</p></Panel>
    <Panel title="Free Registered"><p>Free signed license for eligible organizations under the same grant. Includes Federated SSO.</p></Panel>
    <Panel title="Commercial"><p>A commercial license is required for production use outside the Free Use Grant, including groups above EUR 2,000,000 and excluded productive OEM, SaaS, hosting and managed-service offerings for third parties. Includes Federated SSO.</p></Panel>
    <SoftwareLicenses />
    <Panel title={status.valid ? 'Valid license' : 'License status'}>
      <p>Technical edition: {status.edition === 'commercial' ? 'Commercial' : status.edition === 'free-registered' ? 'Free Registered' : 'Free'}</p>
      <p className="muted">Revenue is not checked by the software. This status does not determine legal eligibility for Free use.</p>
      <ClaimDetails value={status} />
      <p className="muted">Installation ID: <code>{status.installationId}</code></p>
      <p className="muted">Checked: {date(status.checkedAt)}</p>
      <p className="muted">Trusted signing keys: {status.trustedKeyIds.join(', ') || 'None configured'}</p>
      {!status.trustedKeyIds.length && <p className="notice">License verification keys are unavailable. They are delivered with Magic Stick updates; contact the appliance administrator to check the installation. Never upload a private signing key.</p>}
      <Button type="button" disabled={!status.hasDocument || download.isPending} onClick={() => download.mutate()}>Export license</Button>
      <ErrorNotice error={download.error} />
    </Panel>
    <LicenseRequestPanel key={status.installationId} status={status} />
    <Panel title="Import or replace license">
      <Field label="License file"><input ref={fileInput} type="file" accept=".json,.license,application/json" disabled={busy} onChange={(event) => void selectFile(event.target.files?.[0])} /></Field>
      <p className="muted">Upload only the signed license file from your provider. Verification keys are supplied with the installation. Maximum 64 KiB. An invalid upload cannot replace the active license.</p>
      {filename && <p>Selected: {filename}</p>}
      <Button type="button" disabled={!document || busy} onClick={() => inspect.mutate()}>Validate license</Button>
      <ErrorNotice error={error ?? inspect.error ?? activate.error} />
      {preview && <div className="stack" aria-label="License preview">
        <h3>Import preview</h3><ClaimDetails value={preview.candidate} />
        {preview.candidate.claims && <>
          <p>Current license: {preview.current.claims?.licenseId ?? 'None'} → {preview.candidate.claims.licenseId}</p>
          <p>Entitlements: {preview.candidate.claims.features.join(', ') || 'None'}</p>
          <p>Replaces the active license and its entire entitlement set.</p>
        </>}
        <Button variant="primary" type="button" disabled={!preview.candidate.valid || busy} onClick={() => activate.mutate()}>Activate license</Button>
      </div>}
      {message && <p role="status" className="notice notice-good">{message}</p>}
    </Panel>
  </div>;
};
