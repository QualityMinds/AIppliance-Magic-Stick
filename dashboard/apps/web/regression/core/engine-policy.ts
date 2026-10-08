import {labPolicy} from './lab-policy.ts';

/** Test selection only. Never use this policy to gate a product engine. */
export const disabledExperimentalEngines=labPolicy.disabledExperimentalEngines;
export const engineRegressionEnabled=(engine:string)=>!disabledExperimentalEngines.includes(engine);
export const freeTokenRegressionEnabled=engineRegressionEnabled('FreeToken');
