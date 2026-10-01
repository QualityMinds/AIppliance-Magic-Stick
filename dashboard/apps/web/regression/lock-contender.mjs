import {loadLabConfig} from './core/config.ts';
import {HarnessError, requireSafe} from './core/errors.ts';
import {newRunId} from './core/journal.ts';
import {LabLease} from './core/lease.ts';
import {KubernetesLeaseStore} from './core/observer.ts';

// This child process is one independent runner contender. Its only permitted
// write is a compare-and-swap update of the pre-provisioned lab Lease.
let lease;
let held = false;
try {
  requireSafe(process.env.REGRESSION_CONFIG, 'CONFIG');
  const config = await loadLabConfig(process.env.REGRESSION_CONFIG);
  requireSafe(config.lock, 'CONFIG');
  lease = new LabLease(new KubernetesLeaseStore(config.lock.kubeconfig, config.lock.namespace, config.lock.name),
    newRunId(), config.expected.applianceUid, Date.now, 30);
  await lease.acquire();
  held = true;
  await new Promise(resolve => setTimeout(resolve, 2500));
  await lease.heartbeat();
  await lease.release();
  held = false;
  process.stdout.write('won-and-released\n');
} catch (error) {
  if (error instanceof HarnessError && error.code === 'LOCK_BUSY') {
    process.stdout.write('busy\n');
    process.exitCode = 3;
  } else {
    process.stdout.write(error instanceof HarnessError ? `failed-${error.code}\n` : 'unexpected\n');
    process.exitCode = 2;
  }
} finally {
  if (held) {
    try { await lease?.release(); } catch { process.exitCode = 2; }
  }
}
