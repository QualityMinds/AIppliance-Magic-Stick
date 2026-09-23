import {useState} from 'react';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {formatBytes} from '@magicstick/dashboard-core';
import type {HostOperationRequest, ManagedHost} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, Empty, ErrorNotice, Loading, Panel, StatusBadge} from '../components';
import {InfoPopover} from '../InfoPopover';
import {useHosts} from './HostManagement';

const terminal = new Set(['Succeeded', 'PreparedUnverified', 'Failed', 'Rejected', 'Interrupted', 'RolledBack']);
const size = (value?: number) => value === 0 ? '0 B' : formatBytes(value);

const CachePanel = ({host, stale}: {host: ManagedHost; stale: boolean}) => {
  const cache = host.modelCache!;
  const client = useQueryClient();
  const [pending, setPending] = useState<HostOperationRequest | null>(null);
  const mutation = useMutation({mutationFn: (request: HostOperationRequest) => api.requestHostOperation(request), retry: false,
    onSuccess: async () => {setPending(null); await client.invalidateQueries({queryKey: ['host-management']});}});
  const active = Boolean(host.operation && !terminal.has(host.operation.phase));
  const reason = stale || !host.available ? 'Host information is unavailable or stale.'
    : host.updates?.busy || active ? 'Another host operation is in progress.'
    : cache.blocked ? cache.message || 'Stop local models before clearing the cache.'
    : !cache.reclaimableBytes ? 'The model cache is empty.' : '';
  const disabled = Boolean(reason) || !cache.id || mutation.isPending;
  return <div className="stack">
    <dl className="facts">
      <div><dt>System disk</dt><dd>{size(cache.totalBytes)}</dd></div>
      <div><dt>Free disk space</dt><dd>{size(cache.freeBytes)}</dd></div>
      <div><dt>Clearable model cache</dt><dd>{size(cache.reclaimableBytes)}</dd></div>
    </dl>
    <div className="table-wrap"><table><thead><tr><th>Engine cache</th><th>Size</th></tr></thead>
      <tbody>{cache.caches.map((entry) => <tr key={entry.id}><td><span className="inline-info">{entry.name}{!entry.clearable &&
        <InfoPopover label="FreeToken cache"><p className="memory-info-note">FreeToken uses a temporary Pod cache. Stop the model in Models to release it. It is never deleted while its Pod exists.</p></InfoPopover>}</span></td><td>{size(entry.usedBytes)}</td></tr>)}</tbody>
    </table></div>
    <div className="form-actions"><Button variant="danger" disabled={disabled} title={reason || undefined} onClick={() => {
      mutation.reset();
      setPending({action: 'clear-model-cache', nodeName: host.name, nodeUid: host.nodeUid, bootId: host.bootId,
        requestId: crypto.randomUUID().replaceAll('-', ''), planId: cache.id, confirmation: host.name,
        acknowledgeDisruption: true, allowExperimental: false, experimentMode: false});
    }}>Clear model cache</Button>{reason && <InfoPopover label={`Cache cleanup unavailable on ${host.name}`}><p className="memory-info-note">{reason}</p></InfoPopover>}</div>
    {host.operation?.action === 'clear-model-cache' && <div className="notice" role="status"><div className="section-title">
      <strong>Cache cleanup</strong><StatusBadge phase={host.operation.phase} />
      <InfoPopover label={`Cache cleanup status on ${host.name}`}><p className="memory-info-note">{host.operation.message || 'Waiting for the host worker.'}</p></InfoPopover>
    </div></div>}
    <ErrorNotice error={mutation.error} />
    <ConfirmDialog open={Boolean(pending)} title="Clear model cache" expectedValue={host.name} confirmLabel="Clear cache"
      description={`${host.name}: delete cached Hugging Face and Ollama model files (${formatBytes(cache.reclaimableBytes)}). They must be downloaded again when needed. Model settings, credentials, container images and application data are kept. Active models block cleanup; this action does not stop them.`}
      busy={mutation.isPending || disabled} error={mutation.error}
      onClose={() => {if (!mutation.isPending) setPending(null);}}
      onConfirm={() => {if (pending && !disabled) mutation.mutate(pending);}} />
  </div>;
};

export const ModelCachePage = () => {
  const hosts = useHosts();
  return <div className="stack"><div className="section-title"><div className="inline-info"><h2>Model cache</h2>
    <InfoPopover label="Model cache management"><p className="memory-info-note">Disk space for downloaded models, not RAM or VRAM. Only known model-cache directories are cleared. Shared caches stay protected while local model deployments exist; unpinned and KubeAI deployments may also protect caches on other nodes.</p></InfoPopover>
  </div><Button variant="ghost" disabled={hosts.isFetching} onClick={() => void hosts.refetch()}>Refresh cache</Button></div>
    <ErrorNotice error={hosts.error} />{hosts.isPending && <Loading />}
    {hosts.data?.nodes.map((host) => <Panel title={host.name} key={host.nodeUid}>
      {host.modelCache?.supported ? <CachePanel key={host.bootId} host={host} stale={Boolean(hosts.error)} />
        : <Empty>{host.modelCache?.message || 'Model cache management requires the current host worker.'}</Empty>}
    </Panel>)}
    {!hosts.isPending && !hosts.data?.nodes.length && <Empty>No manageable computers reported.</Empty>}
  </div>;
};
