import {test,expect} from '@playwright/test';
import {GpuScenario} from '../core/gpu-scenario.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {requestValidationUi,completedValidation} from './validation-workflow.ts';
import {canonical} from '../core/borrowed-sharing.ts';
import {requireSafe} from '../core/errors.ts';

test.describe('Explicit physical GPU engine verification',()=>{
  let s:GpuScenario|undefined;
  test.beforeAll(async ({browser},info)=>{s=await GpuScenario.open(browser,info.workerIndex);});
  test.afterAll(async ()=>{if(s) await s.close();});
  for (const scope of ['nvidia','all'] as const) test(`HW-06 ${scope} scope runs Ollama and vLLM on exact current physical devices`,evidenceAnnotations(
    {id:'HW-06',variant:scope === 'all' ? 'p3-validation-all' : 'p3-validation-single',layer:'A'},
    {id:'HW-06',variant:scope === 'all' ? 'p3-validation-all' : 'p3-validation-single',layer:'E'}),async ()=>{
    const scenario=s!,page=await scenario.live.context.newPage();
    try {
      const before=scenario.config.gpu!.devices.amd ? await scenario.live.observer.get('moduleactivations.appliance.magicstick.dev',scenario.config.expected.applianceNamespace,'amd-gpu') : undefined;
      const beforeAnnotations=structuredClone(before?.metadata.annotations ?? {});
      for (const [index,engine] of (['OLlama','VLLM'] as const).entries()) {
        const request=await requestValidationUi(scenario,page,engine,scope,(scope === 'all' ? 2 : 0)+index);
        await completedValidation(scenario,request); await page.reload();
        const region=page.getByRole('region',{name:`Engine validation on ${scenario.config.gpu!.nodeName}`});
        await expect(region.getByText('GPU smoke passed',{exact:true}).first()).toBeVisible();
      }
      if (scope === 'nvidia' && before) {
        const after=await scenario.live.observer.get('moduleactivations.appliance.magicstick.dev',scenario.config.expected.applianceNamespace,'amd-gpu');
        requireSafe(after.metadata.uid === before.metadata.uid && after.metadata.generation === before.metadata.generation &&
          canonical(after.spec) === canonical(before.spec) && canonical(after.metadata.annotations) === canonical(beforeAnnotations),'CONFLICT');
      }
    } finally {await page.close();}
  });
});
