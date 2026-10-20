import type {MemoryEstimate} from '@magicstick/dashboard-contracts';
import type {GpuModelFixture} from './config.ts';
import {requireSafe} from './errors.ts';

export function gpuFixtureEstimateBody(fixture:GpuModelFixture) {
  return {engine:fixture.engine,computeTarget:fixture.computeTarget,url:fixture.url,contextWindow:fixture.contextWindow,
    maxNumSeqs:fixture.maxNumSeqs,modelType:'chat',kvCacheType:fixture.kvCacheType,
    ...(fixture.gpuDevices?.length?{gpuDevices:fixture.gpuDevices,gpuDeployment:fixture.gpuDeployment??'split'}:{}),
    ...(fixture.engine==='VLLM'&&fixture.gpuDevices&&fixture.gpuDevices.length>1&&fixture.gpuDeployment!=='replicated'?
      {vllm:{parallelism:fixture.vllm?.parallelism??'auto'}}:{})};
}

/** CPU catalog sizes select a small model, but are never GPU admission budgets.
 * Re-estimate the actual engine, card group and replication mode. Never divide
 * an already per-device estimate again, or copy a split host budget to replicas. */
export function sizedGpuFixture(fixture:GpuModelFixture,estimate:MemoryEstimate):GpuModelFixture {
  const round=(n:number)=>Math.ceil(n/100)*100;
  const count=fixture.gpuDevices?.length??1,ram=estimate.systemMemory;
  requireSafe(Number.isFinite(estimate.recommendedMi)&&estimate.recommendedMi>0&&
    Number.isFinite(estimate.minimumMi)&&estimate.minimumMi>0&&estimate.recommendedMi>=estimate.minimumMi&&
    ram&&Number.isFinite(ram.recommendedMi)&&Number(ram.recommendedMi)>0&&
    Number.isFinite(ram.minimumMi)&&Number(ram.recommendedMi)>=Number(ram.minimumMi),'API');
  if(count>1)requireSafe(estimate.gpuCount===count&&estimate.memoryBudgetScope==='per-device'&&
    ram.scope===(fixture.gpuDeployment==='replicated'?'per-copy':'per-pod')&&
    ram.replicaCount===(fixture.gpuDeployment==='replicated'?count:1),'API');
  const memoryRequiredMi=round(estimate.recommendedMi),systemMemoryMi=round(Number(ram.recommendedMi));
  // Keep automatically selected fixtures small and within current admission
  // limits. Missing capacity is a prerequisite, not permission to overcommit.
  requireSafe(memoryRequiredMi<=32768&&systemMemoryMi<=65536&&
    (typeof estimate.maximumMi!=='number'||memoryRequiredMi<=estimate.maximumMi)&&
    (typeof ram.maximumMi!=='number'||systemMemoryMi<=ram.maximumMi),'CAPABILITY');
  return {...fixture,memoryRequiredMi,systemMemoryMi};
}
