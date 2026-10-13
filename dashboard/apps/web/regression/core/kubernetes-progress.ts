import {caseDescription} from './case-descriptions.ts';
import {reasons,stages,type ReasonCode} from './errors.ts';
import {blockedAction} from './report.ts';
import {blockerDescription} from './blocker-description.ts';

const count=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=100_000 ? Number(n):0;
const outcomes=['Passed','Failed','Blocked'] as const;
export class KubernetesProgress {
  readonly phases:number[];
  completedPhases=0;phase:number|undefined;step='';stepIndex=0;stepTotal=1;
  testIndex=0;testCompleted=0;testTotal=0;currentTest='';counts={Passed:0,Failed:0,Blocked:0};
  private ended=new Set<number>();
  private owners=new Set<string>();
  campaignRunId:string|undefined;
  constructor(phases:number[],private targetUid?:string) {this.phases=phases;}
  consume(value:unknown) {
    const e=value as Record<string,any>;
    if(e?.version!==1)return;
    if(e.event==='owner-start'&&e.targetUid===this.targetUid&&this.targetUid&&/^reg-[a-f0-9-]{36}$/.test(e.runId)&&this.owners.size<1000) {
      this.owners.add(e.runId);
    } else if(e.event==='phase-start'&&this.phases.includes(e.phase)) {
      this.phase=e.phase;this.step='';this.stepIndex=0;this.testIndex=0;this.testCompleted=0;this.testTotal=0;this.currentTest='';
    } else if(e.event==='phase-end'&&this.phases.includes(e.phase)&&outcomes.includes(e.outcome)) {
      this.ended.add(e.phase);this.completedPhases=this.ended.size;this.stepIndex=0;this.testCompleted=0;
    } else if(e.event==='step-start'&&/^[-a-z0-9]{1,40}$/.test(e.step)) {
      this.step=e.step;this.stepIndex=count(e.index);this.stepTotal=Math.max(1,count(e.total));this.testIndex=0;this.testCompleted=0;this.testTotal=0;
    } else if(['test-start','test-end'].includes(e.event)&&Array.isArray(e.ids)&&e.ids.every((id:unknown)=>typeof id==='string'&&Object.hasOwn(reasons,'CONFIG')&&/^[A-Z][A-Z0-9]+-\d{2}$/.test(id))) {
      this.testIndex=count(e.position);this.testTotal=count(e.total);
      // Read descriptions from the source catalogue, not an arbitrary event
      // message, test title, endpoint, console output or error body.
      this.currentTest=e.ids.map((id:string)=>id+': '+caseDescription(id)).join(' ').slice(0,1600);
      if(e.event==='test-end'&&outcomes.includes(e.outcome)){this.testCompleted=this.testIndex;this.counts[e.outcome as 'Passed'|'Failed'|'Blocked']++;}
    } else if(e.event==='campaign-end'&&/^reg-[a-f0-9-]{36}$/.test(e.runId))this.campaignRunId=e.runId;
  }
  snapshot(finished=false) {
    const stage=Math.max(0,this.stepIndex-1+(this.testTotal?Math.min(1,this.testCompleted/this.testTotal):0))/this.stepTotal;
    const percent=finished&&this.completedPhases===this.phases.length?100:
      Math.min(99,Math.floor(100*(this.completedPhases+Math.min(1,stage))/this.phases.length));
    return {percent,completedPhases:this.completedPhases,totalPhases:this.phases.length,currentPhase:this.phase,
      step:this.step,currentTest:this.currentTest,testIndex:this.testIndex,testTotal:this.testTotal,executionCounts:{...this.counts},ownedRunIds:[...this.owners]};
  }
}

export function publicResult(summary:Record<string,any>,campaign:Record<string,any>) {
  const rows=Array.isArray(summary.cases)?summary.cases:[];
  const cases=rows.filter((r:Record<string,any>)=>r.outcome!=='Passed').slice(0,200).map((r:Record<string,any>)=>{
    const reason:ReasonCode=Object.hasOwn(reasons,r.reason)?r.reason:'PREREQUISITE';
    const traceRunId=/^reg-[a-f0-9-]{36}$/.test(r.traceRunId)?r.traceRunId:undefined,
      executionId=/^[a-f0-9]{24}$/.test(r.executionId)?r.executionId:undefined,
      phase=typeof r.variant==='string'&&/^p[0-8]-/.test(r.variant)?Number(r.variant[1]):undefined;
    return {id:/^[A-Z][A-Z0-9]+-\d{2}$/.test(r.id)?r.id:'HAR-10',outcome:outcomes.includes(r.outcome)?r.outcome:'Blocked',
      layer:/^[UCBAEON]$/.test(r.layer)?r.layer:'A',variant:typeof r.variant==='string'&&/^[-a-z0-9]{1,100}$/.test(r.variant)?r.variant:'',
      description:caseDescription(r.id).slice(0,1000),reason,message:blockerDescription(reason,r.id,r.variant,r.layer),action:blockedAction(reason),durationMs:Number.isSafeInteger(r.durationMs)&&r.durationMs>=0&&r.durationMs<=86_400_000?r.durationMs:0,
      ...(phase!==undefined?{phase}:{}),...(stages.includes(r.stage)?{stage:r.stage}:{}),
      ...(traceRunId&&executionId?{traceRunId,executionId,tracePath:`report-artifacts/${traceRunId}/traces/${executionId}.json`}:{})};
  });
  const counts=(value:Record<string,any>)=>Object.fromEntries(outcomes.map(key=>[key,count(value?.[key])]));
  const phases=(Array.isArray(campaign.phases)?campaign.phases:[]).filter((p:any)=>Number.isInteger(p.phase)&&p.phase>=0&&p.phase<=8)
    .map((p:any)=>({phase:p.phase,outcome:outcomes.includes(p.state)?p.state:'Blocked',counts:counts(p.counts),executionCounts:counts(p.executionCounts)}));
  return {counts:counts(summary.counts),executionCounts:counts(summary.executionCounts),phases,cases,
    omittedCases:Math.max(0,rows.filter((r:any)=>r.outcome!=='Passed').length-cases.length),recoveryRequired:summary.recoveryFenceActive===true};
}
