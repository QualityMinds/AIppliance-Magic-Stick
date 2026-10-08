import {test,expect} from '@playwright/test';
import {join} from 'node:path';
import {loadLabConfig} from '../core/config.ts';
import {realLogin} from '../core/auth.ts';
import {registeredLab} from '../core/lab-policy.ts';
import {LabLease} from '../core/lease.ts';
import {KubectlObserver,KubernetesLeaseStore} from '../core/observer.ts';
import {ResourceJournal,newRunId} from '../core/journal.ts';
import {AutomaticRecovery} from '../core/automatic-recovery.ts';
import {recoveryAdapters} from '../core/recovery-adapters.ts';
import {readPrivate,writePrivate} from '../core/private-files.ts';
import {requireSafe} from '../core/errors.ts';

/** Controlled no-resource crash drill. Only the registered lab Lease changes;
 * no model, module, key, account or sharing intent is created or borrowed. */
test('HAR-04 HAR-07 registered automatic recovery fences an expired exact owner and releases the real Lease',async({browser})=>{
  requireSafe(process.env.REGRESSION_CONFIG&&process.env.REGRESSION_INPUT_DIR&&process.env.REGRESSION_OUTPUT_DIR,'CONFIG');
  const config=await loadLabConfig(process.env.REGRESSION_CONFIG);requireSafe(config.lock,'CONFIG');
  const observer=new KubectlObserver(config.observerKubeconfig,config.requestTimeoutMs);
  await observer.verifyConfiguration();const registration=await registeredLab(config,observer);
  const context=await realLogin(browser,config),runId=newRunId(),root=process.env.REGRESSION_OUTPUT_DIR,path=join(root,runId);
  const store=new KubernetesLeaseStore(config.lock.kubeconfig,config.lock.namespace,config.lock.name,config.requestTimeoutMs);
  const owner=new LabLease(store,runId,registration.applianceUid,Date.now,120);let acquired=false,expired=false;
  try {
    await ResourceJournal.create(join(path,'journal.json'),runId,registration.applianceUid);
    // Explicit fixture lifecycle proof precedes the crash injection; a killed
    // drill is still recoverable by the next ordinary automatic preparation.
    await writePrivate(join(path,'runner-session.json'),{version:1,runId,targetUid:registration.applianceUid,
      state:'finished',updatedAt:new Date().toISOString(),interrupted:true});
    const adapters=await recoveryAdapters(process.env.REGRESSION_INPUT_DIR,context,registration);await adapters.verifyTarget();
    await owner.acquire(runId);acquired=true;await owner.heartbeat();const ours=await store.read();
    requireSafe(ours.spec.holderIdentity===runId&&ours.metadata.uid,'LOCK_LOST');
    await store.replace({...ours,spec:{...ours.spec,renewTime:new Date(Date.now()-600_000).toISOString().replace(/\.(\d{3})Z$/,'.$1000Z')}});
    expired=true;await expect(owner.assertHeld()).rejects.toMatchObject({code:'LOCK_LOST'});
    const plan=await AutomaticRecovery.prepare(root,await store.read(),registration);
    expect(await plan.execute(adapters)).toBe(runId);acquired=false;
    expect(JSON.parse(await readPrivate(join(path,'automatic-recovery.json'))).state).toBe('released');
    requireSafe(!(await store.read()).spec.holderIdentity,'CLEANUP');
  } finally {
    // Never revive an expired owner or clear a replacement holder on failure.
    if(acquired&&!expired)await owner.release();
    await context.close();
  }
});
