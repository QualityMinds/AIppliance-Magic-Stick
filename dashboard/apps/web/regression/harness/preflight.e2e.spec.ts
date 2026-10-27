import {test, type BrowserContext} from '@playwright/test';
import type {LabConfig} from '../core/config.ts';
import type {ManagedHost, ModelsPayload} from '@magicstick/dashboard-contracts';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadLabConfig} from '../core/config.ts';
import {realLogin} from '../core/auth.ts';
import {KubectlObserver, KubernetesLeaseStore, type KubeObject} from '../core/observer.ts';
import {safeBaseline, verifiedEndpoint, verifyIdle} from '../core/preflight.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import {HarnessError, requireSafe} from '../core/errors.ts';
import {writePrivate} from '../core/private-files.ts';

test.describe.serial('read-only installed-appliance preflight', () => {
  let config: LabConfig;
  let observer: KubectlObserver;
  let context: BrowserContext | undefined;
  let baseline: {hosts: ManagedHost[]; models: ModelsPayload; nodes: KubeObject[]; pods: KubeObject[]; flux: KubeObject[]};
  test.afterAll(async () => { await context?.close(); });

test('HAR-01 [p0:verified-login] verified endpoints and real administrator login', async ({browser}) => {
  const filename = process.env.REGRESSION_CONFIG;
  requireSafe(filename, 'CONFIG');
  config = await loadLabConfig(filename);
  const ca = config.caFile ? await readFile(config.caFile, 'utf8') : undefined;
  for (const url of [config.dashboardUrl, config.identityUrl, ...(config.inferenceUrl ? [config.inferenceUrl] : [])]) {
    await verifiedEndpoint(url, config.requestTimeoutMs, ca);
  }
  observer = new KubectlObserver(config.observerKubeconfig, config.requestTimeoutMs);
  context = await realLogin(browser, config, {httpsPurpose: 'certificate'});
});

test('HAR-02 [p0:pinned-baseline] [layer:A] independent lab identity, capabilities and requested deployment pins', async () => {
    requireSafe(context && observer && config, 'CONFIG');
    requireSafe(process.env.REGRESSION_RUN_DIR, 'CONFIG');
    const snapshot=await LiveFoundation.snapshot(context,config,process.env.REGRESSION_RUN_DIR);
    const {models,nodes,pods,flux}=snapshot;
    baseline = {hosts: snapshot.hosts.nodes, models, nodes, pods, flux};
    await writePrivate(join(process.env.REGRESSION_RUN_DIR, 'baseline.json'), safeBaseline(config, nodes, pods, models, flux));
});

test('HAR-03 [p0:idle-baseline] [layer:A] idle host and no unrelated active local models or lab owner', async () => {
    requireSafe(baseline && config, 'CONFIG');
    verifyIdle(baseline.hosts, baseline.models, config);
    if (config.lock) {
      // Preflight is read only, including the dedicated test Lease.
      const lease = await new KubernetesLeaseStore(config.lock.kubeconfig, config.lock.namespace, config.lock.name).read();
      requireSafe(lease.metadata.labels['regression.magicstick.dev/appliance-uid'] === config.expected.applianceUid, 'IDENTITY');
      if (lease.spec.holderIdentity) {
        const expires = Date.parse(lease.spec.renewTime ?? '') + Number(lease.spec.leaseDurationSeconds) * 1000;
        throw new HarnessError(Number.isFinite(expires) && Date.now() >= expires ? 'LOCK_STALE' : 'LOCK_BUSY');
      }
    }
});
});
