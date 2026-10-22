import {test as base,expect} from '@playwright/test';
import {GpuScenario} from '../core/gpu-scenario.ts';
import {executionBudget} from '../core/execution-budget.ts';

/** Setup/teardown have a budget separate from the scenario body. A timed-out
 * assertion must not consume the time needed to restore the borrowed backend. */
export const test=base.extend<{gpuSetup:GpuScenario;gpu:GpuScenario}>({
  gpuSetup:[async({browser},use,info)=>{
    const scenario=await GpuScenario.open(browser,info.workerIndex);
    await use(scenario);
  },{timeout:executionBudget.preparationMs}],
  gpu:[async({gpuSetup},use)=>{
    try {await use(gpuSetup);}
    finally {await base.step('Verify owned GPU scenario cleanup',()=>gpuSetup.close());}
  },{timeout:executionBudget.cleanupMs}],
});
export {expect};
