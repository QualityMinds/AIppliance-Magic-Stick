import {labPolicy} from './lab-policy.ts';

/** Test selection only. Never use this policy to gate a product engine. */
export const disabledExperimentalEngines=labPolicy.disabledExperimentalEngines;
export const engineRegressionEnabled=(engine:string)=>!disabledExperimentalEngines.includes(engine);
/** Omni is stored as engine VLLM plus realtime settings. Never disable ordinary
 * vLLM along with the experimental Omni/Realtime acceptance cases. */
export const realtimeRegressionEnabled=()=>engineRegressionEnabled('VLLM-Omni');
