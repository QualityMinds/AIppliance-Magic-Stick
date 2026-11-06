import {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {HostOperationRequest, ManagedHost, SoftwareChannel} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, Empty, ErrorNotice, Field, StatusBadge} from '../components';
import {InfoPopover} from '../InfoPopover';

const terminal = new Set(['Succeeded', 'PreparedUnverified', 'Failed', 'Rejected', 'Interrupted', 'RolledBack']);
const same = (a?: SoftwareChannel, b?: SoftwareChannel) => a?.kind === b?.kind && a?.value === b?.value;
const short = (value?: string) => value ? value.replace(/^(?:.*@)?sha1:/, '').slice(0, 12) : 'Unknown';
const productTag = (channel?: SoftwareChannel) => channel?.kind === 'tag' && /^v\d+\.\d+\.\d+(?:-.*)?$/.test(channel.value);
const choice = (channel?: SoftwareChannel) => productTag(channel) ? 'release'
  : channel?.kind === 'branch' && channel.value === 'main' ? 'main' : channel?.kind ?? 'release';

export const SoftwareChannelEditor = ({host, stale}: {host: ManagedHost; stale: boolean}) => {
  const software = host.software;
  const [draft, setDraft] = useState<SoftwareChannel>(software?.channel ?? {kind: 'branch', value: 'main'});
  const [mode, setMode] = useState(choice(software?.channel));
  const [confirming, setConfirming] = useState(false);
  const [showPrereleases, setShowPrereleases] = useState(Boolean(productTag(software?.channel) && software?.channel?.value.includes('-')));
  const client = useQueryClient();
  const releases = useQuery({queryKey: ['software-releases'], queryFn: () => api.softwareReleases(),
    enabled: Boolean(software?.supported && software.channel), staleTime: 300_000, retry: false});
  const mutation = useMutation({mutationFn: (payload: HostOperationRequest) => api.requestHostOperation(payload), retry: false,
    onSuccess: async () => {setConfirming(false); await client.invalidateQueries({queryKey: ['host-management']});}});
  if (!software?.supported || !software.channel) return <Empty>{software?.message ?? 'Software channel management requires the current host worker.'}</Empty>;
  const operation = host.operation;
  const disabled = stale || !host.available || software.busy || Boolean(host.updates?.busy)
    || Boolean(operation && !terminal.has(operation.phase)) || mutation.isPending;
  const preview = software.preview;
  const catalog = Array.isArray(releases.data?.releases) ? releases.data.releases : [];
  const visibleVersions = catalog.filter((item) => showPrereleases || !item.prerelease);
  const selectedRelease = visibleVersions.find((item) => item.version === draft.value);
  const catalogUnavailable = releases.isPending || releases.isError || releases.data?.stale !== false;
  const releaseSupported = software.releaseCatalogVersion === 1;
  const releaseValid = mode !== 'release' || (releaseSupported && !catalogUnavailable && selectedRelease?.selectable === true);
  const changed = !same(draft, software.channel);
  const valid = draft.kind === 'commit' ? /^[a-fA-F0-9]{40}$/.test(draft.value)
    : /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/.test(draft.value) && !draft.value.includes('..')
      && !draft.value.includes('//') && !draft.value.startsWith('refs/') && !/[/.]$/.test(draft.value)
      && !draft.value.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'));
  const reviewed = Boolean(preview?.ready && same(preview.channel, draft) && preview.configurationId === software.id
    && Date.now() / 1000 - preview.checkedAtEpoch >= 0 && Date.now() / 1000 - preview.checkedAtEpoch <= 900);
  const applicable = reviewed && (changed || preview?.commit !== software.hostCommit || software.blocked);
  const payload = (action: 'check-software-channel' | 'apply-software-channel'): HostOperationRequest => ({
    action, nodeName: host.name, nodeUid: host.nodeUid, bootId: host.bootId, planId: software.id,
    requestId: crypto.randomUUID().replaceAll('-', ''), confirmation: host.name,
    acknowledgeDisruption: true, allowExperimental: false, experimentMode: false, softwareChannel: draft,
    ...(action === 'apply-software-channel' ? {softwarePreviewId: preview?.id} : {}),
  });
  const selectMode = (value: string) => {
    setMode(value);
    setDraft(value === 'main' ? {kind: 'branch', value} : {kind: value === 'release' ? 'tag' : value as SoftwareChannel['kind'], value: ''});
  };
  const lastResult = software.operation;
  const observed = software.observed;
  const freshObserved = observed?.checkedAtEpoch && Date.now() / 1000 - observed.checkedAtEpoch < 180;
  const converged = freshObserved && observed?.ready && software.hostCommit
    && observed.appliedRevision?.endsWith(software.hostCommit) && observed.sourceRevision?.endsWith(software.hostCommit);
  return <div className="stack">
    <div className="section-title"><div className="inline-info"><h3>Magic Stick software</h3>
      <InfoPopover label="Software channel"><p>Choose a published product version to keep a fixed, reviewed host and cluster revision. Development branches follow new commits automatically and are not stable releases. Checking or refreshing the version list never starts an update. Ubuntu updates are configured separately below.</p></InfoPopover></div>
      <StatusBadge phase={software.busy ? 'Updating' : software.blocked ? 'Needs attention' : converged ? 'Ready' : 'Checking'} /></div>
    <dl className="facts"><div><dt>Current channel</dt><dd>{software.channel.kind}: {software.channel.value}</dd></div>
      <div><dt>Host revision</dt><dd>{short(software.hostCommit)}</dd></div>
      <div><dt>Cluster revision</dt><dd>{freshObserved ? short(observed?.appliedRevision) : 'Unknown'}</dd></div></dl>
    {software.blocked && <div className="notice notice-warn" role="alert">Automatic software updates are paused after an incomplete change. Review the result and check a channel again, or use local software recovery.</div>}
    <fieldset disabled={disabled} className="form-grid">
      <Field label="Software channel"><select value={mode} onChange={(event) => selectMode(event.target.value)}>
        <option value="release">Released version</option><option value="main">Development · main</option>
        <option value="branch">Other branch (advanced)</option><option value="tag">Other tag (advanced)</option><option value="commit">Exact commit (advanced)</option>
      </select></Field>
      {mode === 'release' && <Field label="Version"><select value={draft.value} disabled={catalogUnavailable || !releaseSupported}
        onChange={(event) => setDraft({kind: 'tag', value: event.target.value})}>
        <option value="">Choose a released version</option>
        {draft.value && !visibleVersions.some((item) => item.version === draft.value)
          && <option value={draft.value} disabled>{draft.value} · not in the current verified list</option>}
        {visibleVersions.map((item) => <option key={item.version} value={item.version} disabled={!item.selectable}>
          {item.version}{item.prerelease ? ' · prerelease' : ''}{!item.selectable ? ' · not verified' : ''}
        </option>)}
      </select></Field>}
      {!['main', 'release'].includes(mode) && <Field label={draft.kind === 'branch' ? 'Branch name' : draft.kind === 'tag' ? 'Tag name' : 'Full commit'}>
        <input value={draft.value} maxLength={draft.kind === 'commit' ? 40 : 200} spellCheck={false} autoComplete="off"
          placeholder={draft.kind === 'branch' ? 'feature/my-change' : draft.kind === 'tag' ? 'v1.2.3' : '40-character commit'}
          onChange={(event) => setDraft({...draft, value: draft.kind === 'commit' ? event.target.value.toLowerCase() : event.target.value})} />
      </Field>}
    </fieldset>
    {mode === 'release' && <div className="stack">
      {!releaseSupported && <p role="status">Version selection requires the current release-aware host worker. Existing branch and commit settings are preserved.</p>}
      <div className="form-actions"><label><input type="checkbox" checked={showPrereleases} onChange={(event) => {
        setShowPrereleases(event.target.checked);
        if (!event.target.checked && draft.value.includes('-')) setDraft({kind: 'tag', value: ''});
      }} /> Show prereleases</label>
        <Button variant="ghost" disabled={releases.isFetching} onClick={() => {void releases.refetch();}}>Refresh versions</Button></div>
      {releases.isPending ? <p role="status">Loading released versions…</p>
        : releases.data?.stale ? <div className="notice notice-warn" role="alert">{releases.data.message ?? 'The release catalog is stale. Refresh before checking or applying a version.'}</div>
          : !visibleVersions.some((item) => item.selectable) && <p role="status">No verified {showPrereleases ? 'product versions' : 'stable versions'} are published. A development branch is never selected automatically.</p>}
      <ErrorNotice error={releases.error} />
      {selectedRelease && <p>{selectedRelease.prerelease ? 'Prerelease' : 'Released'} · {selectedRelease.publishedAt.slice(0, 10)} · <a href={selectedRelease.url} target="_blank" rel="noreferrer">Release notes</a>
        {selectedRelease.reason && <> · {selectedRelease.reason}</>}</p>}
    </div>}
    {draft.kind === 'branch' && <div className="notice notice-warn">This is a development branch, not a stable release. Future commits also update host automation.</div>}
    <div className="form-actions"><Button variant="ghost" disabled={disabled || !valid || !releaseValid} onClick={() => mutation.mutate(payload('check-software-channel'))}>Check channel</Button>
      <Button disabled={disabled || !valid || !releaseValid || !applicable} onClick={() => setConfirming(true)}>Apply channel</Button>
      {software.previousCommit && <Button variant="ghost" disabled={disabled} onClick={() => {setMode('commit'); setDraft({kind: 'commit', value: software.previousCommit!});}}>Select previous revision</Button>}</div>
    {reviewed && preview && <div className="notice"><strong>Checked revision: {short(preview.commit)}</strong>
      {preview.release && <div><p>Verified release: {preview.release.version}</p>
        <p>Magic Stick source: BUSL-1.1 · first public distribution {preview.release.license.firstPublicDistribution} · Change License MIT from {preview.release.license.changeDate}.</p>
        <p>Third-party components retain their own licenses. Installing a version does not grant a commercial entitlement.</p></div>}
      <details><summary>Published images ({preview.images.length})</summary><ul>{preview.images.map((item) => <li key={item.name}><strong>{item.name}</strong><div className="software-image-reference">{item.image}</div></li>)}</ul></details></div>}
    {lastResult?.message && <div className={lastResult.phase === 'Failed' || lastResult.phase === 'Interrupted' ? 'notice notice-warn' : 'notice'} role="status"><strong>{lastResult.phase}</strong> · {lastResult.message}</div>}
    <ErrorNotice error={mutation.error} />
    <details><summary>Running software details</summary><dl className="facts"><div><dt>Source revision</dt><dd>{observed?.sourceRevision || 'Unknown'}</dd></div></dl>
      {observed?.images?.map((item) => <div key={item.name} className="software-image-reference"><strong>{item.name}</strong> · {freshObserved && item.ready ? 'Ready' : 'Not verified'}<br />{item.imageId || item.image}</div>)}
    </details>
    <ConfirmDialog open={confirming} title="Change software channel"
      description={`${host.name}: use ${draft.kind} ${draft.value} at ${short(preview?.commit)}. Services and the dashboard may restart. ${draft.kind === 'branch' ? 'New commits on this branch will be applied automatically.' : 'This revision remains fixed.'} Host configuration and cluster resources will change; reverting software does not undo database migrations.`}
      confirmLabel="Apply channel" expectedValue={host.name} busy={mutation.isPending} error={mutation.error}
      onClose={() => {if (!mutation.isPending) setConfirming(false);}}
      onConfirm={() => {if (applicable && !disabled && releaseValid) mutation.mutate(payload('apply-software-channel'));}} />
  </div>;
};
