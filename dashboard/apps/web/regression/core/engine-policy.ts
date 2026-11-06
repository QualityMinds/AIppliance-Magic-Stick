import {labPolicy} from './lab-policy.ts';

/** Test selection only. Never use this policy to gate a product engine. */
export const disabledExperimentalEngines=labPolicy.disabledExperimentalEngines;
export const engineRegressionEnabled=(engine:string)=>!disabledExperimentalEngines.includes(engine);
/** Omni is stored as engine VLLM plus realtime settings. Never disable ordinary
 * vLLM along with the experimental Omni/Realtime acceptance cases. */
export const realtimeRegressionEnabled=()=>engineRegressionEnabled('VLLM-Omni');

export type ProductLiveWorkflow='applications'|'modules'|'credentials';
export const liveWorkflowEnabled=(workflow:ProductLiveWorkflow)=>!labPolicy.deferredLiveWorkflows.includes(workflow);
/** Test selection only: never disable product apps or their retained cleanup. */
export const applicationFixtureEnabled=(application:string)=>!labPolicy.deferredApplicationTests.includes(application);
export const applicationRegressionEnabled=(application:string)=>liveWorkflowEnabled('applications')&&applicationFixtureEnabled(application);
const workflowLabels:Record<ProductLiveWorkflow,string>={
  applications:'phase5/applications-live (deferred to separate regression)',
  modules:'phase5/services-live (deferred to separate regression)',
  credentials:'phase5/service-credentials-live (deferred to separate regression)',
};
const legacyApplicationSteps=()=>labPolicy.deferredApplicationTests.map(application=>`phase5/${application}-live (deferred to separate regression)`);
export const deferredApplicationSteps=(phases:readonly number[])=>!phases.includes(5)?[]:[
  ...Object.entries(workflowLabels).filter(([workflow])=>!liveWorkflowEnabled(workflow as ProductLiveWorkflow)).map(([,label])=>label),
  ...(liveWorkflowEnabled('applications')?legacyApplicationSteps():[]),
];
/** Recognize recorded legacy labels independently of today's active policy. */
export const deferredApplicationStep=(step:string)=>Object.values(workflowLabels).includes(step)||legacyApplicationSteps().includes(step);
