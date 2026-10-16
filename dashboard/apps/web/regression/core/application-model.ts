import type {MemoryEstimate,ModelsPayload,ModulesPayload} from '@magicstick/dashboard-contracts';
import type {LocalModelFixture} from './config.ts';
import {catalogFixtures} from './input-preparation.ts';
import {HarnessError,atStage,requireProof,requireSafe} from './errors.ts';

const contextStep=256;
const maximumContext=131072;
const maximumRamMi=32768;

/** Read the deployed application contracts, not a parallel Hermes constant.
 * Reserve a second compatible context for APP-09 without inflating model metadata. */
export function applicationContexts(modules:ModulesPayload,types:readonly string[]) {
  const definitions=types.map(type=>modules.catalogJson?.applications?.[type]);
  requireProof(types.length>0 && definitions.every(Boolean),'PREREQUISITE');
  const values=definitions.map(definition=>definition!.minimumModelContextTokens ?? 2048);
  requireProof(values.every(value=>Number.isSafeInteger(value) && Number(value)>=256),'CONFIG');
  const minimum=Math.max(...values.map(Number));
  requireSafe(minimum+contextStep<=maximumContext,'APPLICATION_MODEL');
  return {minimum,initial:minimum+contextStep};
}

/** Select a small, native-context-compatible CPU model independently of the
 * 2K CPU smoke fixture. Both metadata and the larger edit budget are verified
 * before any test model, user or application write is sent. */
export async function applicationModel(models:ModelsPayload,modules:ModulesPayload,types:readonly string[],
  estimate:(fixture:LocalModelFixture)=>Promise<MemoryEstimate>):Promise<LocalModelFixture> {
  return atStage('model-estimate',async()=>{
    const {initial}=applicationContexts(modules,types);
    const capacity=Math.max(0,...(models.computeMemory?.devices ?? []).filter(device=>device.id==='cpu' || device.computeTarget==='cpu')
      .flatMap(device=>Number.isFinite(device.unreservedMi) && Number.isFinite(device.freeMi) ? [Math.min(device.unreservedMi!,device.freeMi!)] : []));
    requireSafe(capacity>0,'APPLICATION_MODEL');
    const candidates=catalogFixtures(models,'OLlama','cpu').filter((fixture,index,all)=>all.findIndex(other=>other.url===fixture.url)===index).slice(0,8);
    for(const candidate of candidates) {
      const small=candidate as LocalModelFixture;
      // Query at a known small context first: the estimator correctly rejects
      // a request above native context, rather than fabricating a larger model.
      const metadata=await estimate(small);
      if(!Number.isSafeInteger(metadata.modelMaxContext) || Number(metadata.modelMaxContext)<initial)continue;
      const fixture={...small,contextWindow:initial};
      const sized=await estimate(fixture);
      requireProof(Number.isSafeInteger(sized.modelMaxContext) && Number(sized.modelMaxContext)>=initial &&
        sized.contextWindow===initial && Number.isFinite(sized.minimumMi) && sized.minimumMi>0 &&
        Number.isFinite(sized.recommendedMi) && sized.recommendedMi>=sized.minimumMi,'API');
      const budget=Math.ceil(Math.max(fixture.memoryRequiredMi,sized.recommendedMi)/100)*100;
      if(budget>Math.min(capacity,maximumRamMi))continue;
      return {...fixture,memoryRequiredMi:budget};
    }
    throw new HarnessError('APPLICATION_MODEL');
  });
}

export function applicationEditContext(modules:ModulesPayload,types:readonly string[],current:number) {
  const {minimum,initial}=applicationContexts(modules,types);
  requireProof(current===minimum || current===initial,'CONFLICT');
  return current===initial ? minimum : initial;
}
