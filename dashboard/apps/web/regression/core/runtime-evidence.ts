import {test} from '@playwright/test';
import {join,dirname} from 'node:path';
import type {LiveFoundation} from './live-foundation.ts';
import type {OwnedModelClient} from './owned-model.ts';
import type {InferenceProbe} from './inference.ts';
import {runtimeDiagnostic} from './runtime-diagnostic.ts';
import {writePrivate} from './private-files.ts';
import {HarnessError,requireSafe,type Stage} from './errors.ts';

export interface RuntimeSubject {client:OwnedModelClient;uid:string;generation:number}
export async function preserveRuntimeFailure(live:LiveFoundation,model:RuntimeSubject,stage:Stage,error:unknown) {
  try {
    const state=await live.modelState(model.client,model.uid);
    if(state.item)await test.info().attach('magicstick-runtime-diagnostic',{contentType:'application/json',
      body:Buffer.from(JSON.stringify(runtimeDiagnostic(state.item,state.pods,model.uid,model.generation)))});
  }catch{/* Diagnostics must not replace the primary failure. */}
  const directory=dirname(live.journal.filename);
  await writePrivate(join(directory,`runtime-failure-${model.client.name}.json`),{version:1,runId:live.journal.runId,
    stage,reason:error instanceof HarnessError?error.code:'UNEXPECTED'}).catch(()=>{});
  // Authenticated bounded product logs only; these are excluded from exports.
  try{await writePrivate(join(directory,`logs-${model.client.name}.json`),await model.client.logs());}catch{}
}

/** The first CPU inference uses the same structural evidence as GPU inference.
 * Distinguish a missing route from a failed/slow response without retaining
 * cookies, keys, prompts or response bodies, and without extending deadlines. */
export async function proveRoutedInference(live:LiveFoundation,probe:InferenceProbe,model:RuntimeSubject,upstreamModel?:string) {
  const file=join(dirname(live.journal.filename),`inference-${model.client.name}.json`),started=Date.now();
  let stage:Stage='model-route';
  try {
    const advertised=await probe.advertised(model.client.name);
    await writePrivate(file,{version:1,stage,advertised,durationMs:Date.now()-started});
    requireSafe(advertised,'API');stage='model-inference';
    await probe.chat(model.client.name,upstreamModel,8,async value=>{
      await writePrivate(file,{version:1,stage,advertised,durationMs:Date.now()-started,...value});
    });
  }catch(error) {
    await preserveRuntimeFailure(live,model,stage,error);
    throw new HarnessError(error instanceof HarnessError?error.code:'UNEXPECTED','Failed',stage);
  }
}
