import type {RegressionBlocker,RegressionCleanup} from '@magicstick/dashboard-contracts';
import type {CaseResult} from './report.ts';
import type {GpuScenarioSelection} from './scenario-selection.ts';
import {serviceStages,type ServiceMatrix,type ServiceStage} from './service-matrix.ts';
import {checkedBlocker,blockerFrom} from './blocking.ts';
import {executionIdentity} from './shared-workflow.ts';
import {requireSafe} from './errors.ts';

interface Scope {key:string;stage:ServiceStage}
interface Gate {passed:boolean;cause?:RegressionBlocker}
/** Pure acceptance state for the explicitly selected services suite. A later
 * stage is never a retry of its failed prerequisite. Recovery can make the
 * appliance safe for unrelated entries, but cannot turn an old stage green. */
export class ServiceStageGates {
  private readonly states=new Map<string,Map<ServiceStage,Gate>>();
  private readonly matrix:ServiceMatrix;
  constructor(matrix:ServiceMatrix) {requireSafe(matrix.version===1,'CONFIG');this.matrix=matrix;}
  private scope(scenario:GpuScenarioSelection):Scope {
    const scopes=scenario.evidence.map(item=>{
      const match=/^p5-services-(module|application)-([a-z][a-z0-9-]{0,62})-(installation|access)-[a-z]+-\d{2}$/.exec(item.variant??'');
      requireSafe(match,'CONFIG');return {key:match[1]+':'+match[2],stage:match[3] as ServiceStage};
    });
    const scope=scopes[0];requireSafe(scope&&scopes.every(value=>value.key===scope.key&&value.stage===scope.stage)&&
      this.matrix.entries.some(entry=>entry.kind+':'+entry.id===scope.key&&entry.capabilities[scope.stage].state!=='not-applicable'),'CONFIG');return scope;
  }
  private save(scope:Scope,value:Gate) {
    const entry=this.states.get(scope.key)??new Map<ServiceStage,Gate>();requireSafe(!entry.has(scope.stage),'CONFIG');
    entry.set(scope.stage,value);this.states.set(scope.key,entry);
  }
  /** Return exact dependent tuples before any child/fixture is started. A held
   * recovery fence blocks all entries; otherwise only this entry's failed or
   * missing earlier applicable stage prevents progress. */
  blocked(scenario:GpuScenarioSelection,runId:string,recoveryFence=false,recoveryCause?:RegressionBlocker):CaseResult[]|undefined {
    requireSafe(/^reg-[0-9a-f-]{36}$/.test(runId),'CONFIG');
    const scope=this.scope(scenario),entry=this.matrix.entries.find(entry=>entry.kind+':'+entry.id===scope.key)!;
    let cause=recoveryFence?checkedBlocker(recoveryCause)??{kind:'failure' as const,reason:'RECOVERY' as const,stage:'recovery-barrier' as const}:undefined;
    if(!cause)for(const stage of serviceStages.slice(0,serviceStages.indexOf(scope.stage))) {
      if(entry.capabilities[stage].state==='not-applicable')continue;
      const previous=this.states.get(scope.key)?.get(stage);
      if(!previous?.passed) {
        cause=previous?.cause??{kind:'failure',caseId:'HAR-10',reason:'MISSING_EVIDENCE',stage:'report-evidence'};break;
      }
    }
    if(!cause)return;
    this.save(scope,{passed:false,cause});
    return scenario.evidence.map(item=>({...item,variant:item.variant as CaseResult['variant'],environment:'live',outcome:'Blocked',durationMs:0,
      reason:recoveryFence?'RECOVERY':'DEPENDENCY',stage:recoveryFence?'recovery-barrier':'runner-execution',blockedBy:cause,
      executionId:executionIdentity(runId,scenario.id),executionOutcome:'Blocked',traceRunId:runId}));
  }
  /** cleanup is the post-process private fingerprint assessment returned by
   * childEvidence, not a report checkbox. Both must agree before stage credit. */
  record(scenario:GpuScenarioSelection,value:{runId:string;coordinatorRunId:string;exit:number|null;acceptable:boolean;cases:CaseResult[];
    cleanup:RegressionCleanup|undefined;recoveryFence:boolean}) {
    const scope=this.scope(scenario);requireSafe([value.runId,value.coordinatorRunId].every(id=>/^reg-[0-9a-f-]{36}$/.test(id)),'CONFIG');
    const executionId=executionIdentity(value.coordinatorRunId,scenario.id+'-stage-verification'),supplemental:CaseResult[]=[];
    const exact=scenario.evidence.every(required=>{
      const matches=value.cases.filter(item=>item.id===required.id&&item.variant===required.variant&&item.layer===required.layer&&item.environment==='live');
      return matches.length===1&&matches[0]!.outcome==='Passed'&&matches[0]!.executionOutcome!=='Failed'&&matches[0]!.executionOutcome!=='Blocked';
    });
    const clean=value.cleanup?.state==='verified'&&Number.isFinite(Date.parse(value.cleanup.checkedAt??''))&&!value.recoveryFence;
    const root=value.cases.find(item=>item.outcome==='Failed')??value.cases.find(item=>item.outcome!=='Passed');
    const cleanupFailed=!clean||value.cases.some(item=>item.recoveryRequired);
    const passed=value.exit===0&&value.acceptable&&exact&&!cleanupFailed&&!root;
    let cause:RegressionBlocker|undefined;
    if(!passed) {
      if(root)cause=checkedBlocker(root.blockedBy)??blockerFrom(root);
      else {
        const failure:CaseResult={id:cleanupFailed?'HAR-07':'HAR-10',layer:'A',environment:'live',outcome:'Failed',durationMs:0,
          reason:cleanupFailed?'CLEANUP':!exact?'MISSING_EVIDENCE':'UNEXPECTED',stage:cleanupFailed?'cleanup':!exact?'report-evidence':'runner-execution',
          ...(cleanupFailed?{recoveryRequired:true as const}:{}),executionId,executionOutcome:'Failed',traceRunId:value.coordinatorRunId};
        supplemental.push(failure);cause=blockerFrom(failure);
      }
    }
    this.save(scope,{passed,...(cause?{cause}:{})});return supplemental;
  }
}
