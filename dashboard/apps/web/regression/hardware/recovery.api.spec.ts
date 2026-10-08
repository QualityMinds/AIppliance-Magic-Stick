import {test} from '@playwright/test';
import {GpuScenario} from '../core/gpu-scenario.ts';
import {requireSafe} from '../core/errors.ts';
import {evidenceAnnotations} from '../core/evidence.ts';

test('HAR-07 HAR-08 explicit GPU recovery refuses adoption and restores unchanged journal-owned settings',evidenceAnnotations(
  {id:'HAR-07',layer:'A'},{id:'HAR-08',variant:'p4-restoration',layer:'A'}),async ({browser})=>{
  requireSafe(process.env.REGRESSION_RECOVERY_JOURNAL,'CONFIG');
  const recovered=await GpuScenario.recover(browser,process.env.REGRESSION_RECOVERY_JOURNAL);await recovered.close();
});
