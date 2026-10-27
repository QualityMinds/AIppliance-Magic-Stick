import {phase4Requirements,phase4Variants} from '../profiles/gpu-p0.ts';
import {requireSafe} from './errors.ts';
import type {Evidence} from './evidence.ts';
import {phase2Requirements} from '../profiles/phase2-p0.ts';
import {phase3Requirements} from '../profiles/gpu-p0.ts';
import type {DiagnosticSelection} from './diagnostic-selection.ts';

export interface GpuScenarioSelection {id:string;title:string;source:{file:string;line:number};evidence:Evidence[]}
export const diagnosticRequirements=(selection:DiagnosticSelection)=>(selection.phase===2?phase2Requirements:
  selection.phase===3?phase3Requirements:phase4Requirements).filter(r=>r.environment==='live'&&selection.caseIds.includes(r.id)&&
    (!selection.variants||selection.variants.includes(r.variant)));
export const registeredScenarioSource=(phase:2|3|4,file:string)=>(phase===2?/^regression\/models\/cpu-model-control\.e2e\.spec\.ts$/:
  phase===3?/^regression\/hardware\/validation\.e2e\.spec\.ts$/:/^regression\/hardware\/(?:sharing|multi-gpu)\.e2e\.spec\.ts$/).test(file);

/** Discover first, then select exact registered variants. The public selection
 * cannot pass a grep/script or accidentally execute another case's live work. */
export function diagnosticScenarios(value:unknown,selection:DiagnosticSelection):GpuScenarioSelection[] {
  const manifest=value as {version?:number;scenarios?:GpuScenarioSelection[]};
  const required=diagnosticRequirements(selection);
  requireSafe(manifest?.version===1&&Array.isArray(manifest.scenarios)&&manifest.scenarios.length>0&&manifest.scenarios.length<=64&&
    required.length>0&&(!selection.variants||selection.variants.every(v=>required.some(r=>r.variant===v))),'CONFIG');
  const matches=(e:Evidence)=>required.some(r=>r.id===e.id&&r.variant===e.variant&&r.layer===e.layer);
  const selected=manifest.scenarios.filter(s=>Array.isArray(s.evidence)&&s.evidence.some(matches));
  const seen=new Set<string>();
  for(const s of selected) {
    requireSafe(typeof s.id==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(s.id)&&!seen.has(s.id)&&
      typeof s.title==='string'&&s.title.length>0&&s.title.length<=1000&&registeredScenarioSource(selection.phase,s.source?.file)&&
      s.evidence.length>0&&s.evidence.every(matches),'CONFIG');
    seen.add(s.id);
  }
  // Several provider scenarios may prove the same case/variant/layer tuple.
  // Scenario IDs, not tuple counts, guarantee one execution of each scenario.
  requireSafe(required.every(r=>selected.some(s=>s.evidence.some(e=>e.id===r.id&&e.variant===r.variant&&e.layer===r.layer))),'CONFIG');
  return selected;
}
/** Collect from Playwright itself, then validate against the existing profile.
 * No second hand-written test list and no arbitrary browser-supplied grep. */
export function phase4Scenarios(value:unknown,complete=true,caseIds?:readonly string[]):GpuScenarioSelection[] {
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
  if(complete||caseIds)requireSafe(phase4Requirements.filter(r=>r.environment==='live'&&(!caseIds||caseIds.includes(r.id))).every(r=>manifest.scenarios!.some(s=>
    s.evidence.some(e=>e.id===r.id&&e.variant===r.variant&&e.layer===r.layer))),'CONFIG');
  if(caseIds)requireSafe(manifest.scenarios.every(s=>s.evidence.every(e=>caseIds.includes(e.id))),'CONFIG');
  return manifest.scenarios;
}
export const scenarioGrep=(title:string)=>title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$';
