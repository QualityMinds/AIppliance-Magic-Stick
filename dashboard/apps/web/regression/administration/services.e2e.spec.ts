import {test} from '@playwright/test';
import {loadLabConfig} from '../core/config.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import {gpuWorkerJournal} from '../core/gpu-scenario.ts';
import {loadServicePlan,automaticServiceMatrix} from '../core/service-plan.ts';
import {serviceStages,serviceStageEvidence} from '../core/service-matrix.ts';
import {serviceRegressionEnabled} from '../core/service-selection.ts';
import {canonical} from '../core/borrowed-sharing.ts';
import {requireSafe,HarnessError} from '../core/errors.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {withCleanup} from '../core/run-lifecycle.ts';
import {modulesWorkflow,standaloneServiceStage} from './modules-live.ts';
import {applicationServiceStage} from './apps-live.ts';

requireSafe(serviceRegressionEnabled()&&process.env.REGRESSION_MODE==='services','CONFIG');
const plan=await loadServicePlan();
// Discovery records all applicable catalog entries before the first write.
// The serial launcher independently checks this complete evidence matrix.
for(const stage of serviceStages)for(const entry of plan.matrix.entries) {
  const evidence=serviceStageEvidence(stage,entry);
  if(!evidence.length)continue; // explicitly not-applicable in the saved matrix
  const ids=[...new Set(evidence.map(item=>item.id))];
  test(`${ids.join(' ')} services ${stage} ${entry.kind} ${entry.id}`,evidenceAnnotations(...evidence),async({browser},info)=>{
    requireSafe(process.env.REGRESSION_CONFIG&&process.env.REGRESSION_RUN_DIR,'CONFIG');
    const config=await loadLabConfig(process.env.REGRESSION_CONFIG);
    const {journal}=await gpuWorkerJournal(process.env.REGRESSION_RUN_DIR,info.workerIndex,config.expected.applianceUid,true);
    const live=await LiveFoundation.open(browser,config,journal,{inferenceOrigin:config.inferenceUrl});
    await withCleanup(async()=>{
      requireSafe(canonical(automaticServiceMatrix(await live.api.modules()))===canonical(plan.matrix),'REVISION');
      if(entry.capabilities[stage].state!=='supported')throw new HarnessError('PREREQUISITE','Blocked','app-ready');
      let proved:Set<string>;
      if(entry.kind==='application')proved=await applicationServiceStage(live,browser,stage,entry.id);
      else {
        const fixture=plan.modules.find(item=>item.id===entry.id);requireSafe(fixture,'CONFIG');
        if(entry.id==='anything-llm')proved=await standaloneServiceStage(live,browser,fixture,stage);
        else {
          proved=await modulesWorkflow(live,{stage,fixture,endpointRequired:stage==='access'});
        }
      }
      requireSafe(ids.every(id=>proved.has(id)),'MISSING_EVIDENCE');
    },()=>live.close());
  });
}
