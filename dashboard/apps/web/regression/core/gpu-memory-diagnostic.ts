import {requireSafe} from './errors.ts';

export const gpuMemoryCheckpoints=['initial','dynamic-changed','dynamic-restored','fixed-changed','fixed-restored'] as const;
export interface GpuMemoryDiagnostic {
  version:1;kernelDynamicLimitMi:number;initialDraftMi:number;stepMi:number;allowedMaximumMi:number;
  observations:Array<{checkpoint:typeof gpuMemoryCheckpoints[number];expectedDraftMi:number;draftMi:number|null;
    expectedFixedPosition:number;fixedPosition:number|null;expectedReviewEnabled:boolean;reviewEnabled:boolean|null}>;
}
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=2_147_483_647;
/** Only bounded memory values and fixed control states. Never retain host names,
 * selectors, response bodies, error messages or arbitrary attachment fields. */
export function parseGpuMemoryDiagnostic(value:unknown):GpuMemoryDiagnostic {
  const d=value as GpuMemoryDiagnostic;
  requireSafe(d?.version===1&&integer(d.kernelDynamicLimitMi)&&d.kernelDynamicLimitMi>0&&integer(d.initialDraftMi)&&
    integer(d.stepMi)&&d.stepMi>0&&integer(d.allowedMaximumMi)&&Array.isArray(d.observations)&&
    d.observations.length>0&&d.observations.length<=gpuMemoryCheckpoints.length,'CONFIG');
  const seen=new Set<string>();
  const observations=d.observations.map(o=>{
    requireSafe(o&&gpuMemoryCheckpoints.includes(o.checkpoint)&&!seen.has(o.checkpoint)&&
      integer(o.expectedDraftMi)&&(o.draftMi===null||integer(o.draftMi))&&
      integer(o.expectedFixedPosition)&&(o.fixedPosition===null||integer(o.fixedPosition))&&
      typeof o.expectedReviewEnabled==='boolean'&&(o.reviewEnabled===null||typeof o.reviewEnabled==='boolean'),'CONFIG');
    seen.add(o.checkpoint);
    return {checkpoint:o.checkpoint,expectedDraftMi:o.expectedDraftMi,draftMi:o.draftMi,
      expectedFixedPosition:o.expectedFixedPosition,fixedPosition:o.fixedPosition,
      expectedReviewEnabled:o.expectedReviewEnabled,reviewEnabled:o.reviewEnabled};
  });
  return {version:1,kernelDynamicLimitMi:d.kernelDynamicLimitMi,initialDraftMi:d.initialDraftMi,stepMi:d.stepMi,
    allowedMaximumMi:d.allowedMaximumMi,observations};
}
export function gpuMemoryDiagnosticText(d:GpuMemoryDiagnostic):string[] {
  const state=(value:boolean|null)=>value===null?'unknown':value?'enabled':'disabled';
  return [`GPU memory draft: kernel ${d.kernelDynamicLimitMi} MiB; initial draft ${d.initialDraftMi} MiB; step ${d.stepMi} MiB; allowance maximum ${d.allowedMaximumMi} MiB`,
    ...d.observations.map(o=>`${o.checkpoint}: draft ${o.draftMi??'unknown'} MiB / expected ${o.expectedDraftMi} MiB; fixed position ${o.fixedPosition??'unknown'} / expected ${o.expectedFixedPosition}; Review ${state(o.reviewEnabled)} / expected ${state(o.expectedReviewEnabled)}`)];
}
