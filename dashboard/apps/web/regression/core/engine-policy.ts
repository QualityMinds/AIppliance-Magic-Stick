import {labPolicy} from './lab-policy.ts';

/** Test selection only. Never use this policy to gate a product engine. */
export const disabledExperimentalEngines=labPolicy.disabledExperimentalEngines;
export const engineRegressionEnabled=(engine:string)=>!disabledExperimentalEngines.includes(engine);
/** Omni is stored as engine VLLM plus realtime settings. Never disable ordinary
 * vLLM along with the experimental Omni/Realtime acceptance cases. */
export const realtimeRegressionEnabled=()=>engineRegressionEnabled('VLLM-Omni');

/** Shared APP/ACL cases still run for other applications. Keep the native
 * Hermes adapter and its isolated checks for the later, separate regression. */
export const applicationRegressionEnabled=(application:string)=>!labPolicy.deferredApplicationTests.includes(application);
export const deferredApplicationSteps=(phases:readonly number[])=>phases.includes(5)?
  labPolicy.deferredApplicationTests.map(application=>`phase5/${application}-live (deferred to separate regression)`):[];
export const deferredApplicationStep=(step:string)=>deferredApplicationSteps([5]).includes(step);
