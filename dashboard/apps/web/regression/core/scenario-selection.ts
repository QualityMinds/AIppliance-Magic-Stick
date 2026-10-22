import {phase4Requirements,phase4Variants} from '../profiles/gpu-p0.ts';
import {requireSafe} from './errors.ts';
import type {Evidence} from './evidence.ts';

export interface GpuScenarioSelection {id:string;title:string;source:{file:string;line:number};evidence:Evidence[]}
/** Collect from Playwright itself, then validate against the existing profile.
 * No second hand-written test list and no arbitrary browser-supplied grep. */
export function phase4Scenarios(value:unknown,complete=true):GpuScenarioSelection[] {
  const manifest=value as {version?:number;scenarios?:GpuScenarioSelection[]};
  requireSafe(manifest?.version===1&&Array.isArray(manifest.scenarios)&&manifest.scenarios.length>0&&manifest.scenarios.length<=64,'CONFIG');
  const seen=new Set<string>();
  for(const s of manifest.scenarios) {
    requireSafe(typeof s.id==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(s.id)&&!seen.has(s.id)&&
      typeof s.title==='string'&&s.title.length>0&&s.title.length<=1000&&
      /^regression\/hardware\/(?:sharing|multi-gpu)\.e2e\.spec\.ts$/.test(s.source?.file)&&
      Array.isArray(s.evidence)&&s.evidence.length>0&&s.evidence.every(e=>e.variant&&Object.hasOwn(phase4Variants,e.variant)&&
        phase4Requirements.some(r=>r.variant===e.variant&&r.id===e.id&&r.layer===e.layer&&r.environment==='live')),'CONFIG');
    seen.add(s.id);
  }
  if(complete)requireSafe(phase4Requirements.filter(r=>r.environment==='live').every(r=>manifest.scenarios!.some(s=>
    s.evidence.some(e=>e.id===r.id&&e.variant===r.variant&&e.layer===r.layer))),'CONFIG');
  return manifest.scenarios;
}
export const scenarioGrep=(title:string)=>title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$';
