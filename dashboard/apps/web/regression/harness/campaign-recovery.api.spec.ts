import {test} from '@playwright/test';
import {loadLabConfig} from '../core/config.ts';
import {realLogin} from '../core/auth.ts';
import {registeredLab} from '../core/lab-policy.ts';
import {KubectlObserver,KubernetesLeaseStore} from '../core/observer.ts';
import {AutomaticRecovery,campaignRecoveryLease} from '../core/automatic-recovery.ts';
import {recoveryAdapters} from '../core/recovery-adapters.ts';
import {requireSafe} from '../core/errors.ts';

test('HAR-07 restore the exact finished campaign child before independent live tests continue',async({browser})=>{
  requireSafe(process.env.REGRESSION_CONFIG&&process.env.REGRESSION_INPUT_DIR&&process.env.REGRESSION_OUTPUT_DIR&&
    /^reg-[0-9a-f-]{36}$/.test(process.env.REGRESSION_RECOVERY_RUN_ID??''),'CONFIG');
  const config=await loadLabConfig(process.env.REGRESSION_CONFIG);requireSafe(config.lock,'CONFIG');
  const observer=new KubectlObserver(config.observerKubeconfig,config.requestTimeoutMs);
  await observer.verifyConfiguration();const registration=await registeredLab(config,observer);
  const context=await realLogin(browser,config),store=new KubernetesLeaseStore(config.lock.kubeconfig,
    config.lock.namespace,config.lock.name,config.requestTimeoutMs);
  try {
    const lease=await test.step('Wait for the finished child lease and drain window',()=>campaignRecoveryLease(
      process.env.REGRESSION_OUTPUT_DIR!,process.env.REGRESSION_RECOVERY_RUN_ID!,registration.applianceUid,store));
    const plan=await AutomaticRecovery.prepare(process.env.REGRESSION_OUTPUT_DIR!,lease,registration);
    await test.step('Restore exact owned resources and borrowed settings',async()=>{
      await plan.execute(await recoveryAdapters(process.env.REGRESSION_INPUT_DIR!,context,registration));
    });
    requireSafe(!(await store.read()).spec.holderIdentity,'CLEANUP');
  }finally{await context.close();}
});
