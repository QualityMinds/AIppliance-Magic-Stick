import type {RegressionBlocker, RegressionBlockedCounts} from '@magicstick/dashboard-contracts';
import {emptyBlockedCounts, regressionBlockedKind, regressionBlockedKinds} from '../../../../packages/core/src/regression-blocking.ts';
import {caseDescriptions} from './case-descriptions.ts';
import {reasons, stages} from './errors.ts';

export interface BlockingEvidence {
  id: string; outcome: string; reason?: string; stage?: string; executionId?: string; traceRunId?: string;
  executionOutcome?: string; blockedBy?: RegressionBlocker;
}

/** Keep only public catalogue identifiers and known reasons, never raw errors. */
export function checkedBlocker(value: unknown): RegressionBlocker | undefined {
  const item = value as RegressionBlocker | null;
  if (!item || !regressionBlockedKinds.includes(item.kind)) return;
  return {kind: item.kind,
    ...(typeof item.reason==='string' && Object.hasOwn(reasons, item.reason) ? {reason: item.reason} : {}),
    ...(typeof item.caseId==='string' && Object.hasOwn(caseDescriptions, item.caseId) ? {caseId: item.caseId} : {}),
    ...(typeof item.stage==='string' && stages.includes(item.stage as typeof stages[number]) ? {stage: item.stage} : {}),
    ...(typeof item.executionId==='string' && /^[a-f0-9]{24}$/.test(item.executionId) ? {executionId: item.executionId} : {}),
    ...(typeof item.traceRunId==='string' && /^reg-[a-f0-9-]{36}$/.test(item.traceRunId) ? {traceRunId: item.traceRunId} : {})};
}

export function blockerFrom(item: BlockingEvidence): RegressionBlocker {
  return checkedBlocker({kind: item.outcome === 'Failed' || item.outcome === 'Flaky' ? 'failure' : regressionBlockedKind(item.reason),
    reason: item.reason, caseId: item.id, stage: item.stage, executionId: item.executionId, traceRunId: item.traceRunId})!;
}

export function recoveryCause(value:string|undefined):RegressionBlocker|undefined {
  if(!value || value.length>2048)return;
  try {const cause=checkedBlocker(JSON.parse(value));return cause?.kind==='failure'?cause:undefined;}catch{return;}
}

/** Carry the original cleanup failure across children/phases, not a later
 * generic recovery guard. A verified recovery clears both fence and cause. */
export function inheritRecoveryCause(environment:Record<string,string|undefined>,cases:BlockingEvidence[],active:boolean) {
  if(!active){delete environment.REGRESSION_RECOVERY_FENCE;delete environment.REGRESSION_RECOVERY_CAUSE;return;}
  environment.REGRESSION_RECOVERY_FENCE='1';
  if(recoveryCause(environment.REGRESSION_RECOVERY_CAUSE))return;
  const root=cases.find(item=>item.outcome==='Failed'&&item.id==='HAR-10'&&item.stage==='runner-execution') ??
    cases.find(item=>item.outcome==='Failed'&&['CLEANUP','OWNERSHIP','CONFLICT','LOCK_LOST','LOCK_STALE','RECOVERY','PROCESS_STATE'].includes(item.reason??'')) ??
    cases.find(item=>item.outcome==='Failed');
  if(root)environment.REGRESSION_RECOVERY_CAUSE=JSON.stringify(blockerFrom(root));
}

/** Dependency attribution stays within its recorded executable scenario. */
export function withBlockedCauses<T extends BlockingEvidence>(cases: T[]): Array<T & {blockedBy?: RegressionBlocker}> {
  const groups = new Map<string, T[]>();
  for (const item of cases) if (item.executionId && /^[a-f0-9]{24}$/.test(item.executionId)) {
    const key = (item.traceRunId ?? '') + '/' + item.executionId;
    const group=groups.get(key);if(group)group.push(item);else groups.set(key,[item]);
  }
  const roots=new Map([...groups].map(([key,peers])=>[key,peers.find(peer=>['Failed','Flaky'].includes(peer.outcome)) ??
    peers.find(peer=>peer.outcome==='Blocked'&&peer.reason!=='DEPENDENCY')]));
  return cases.map(item => {
    if (item.outcome !== 'Blocked') return {...item, blockedBy: undefined};
    const recorded = checkedBlocker(item.blockedBy);
    if (recorded) return {...item, blockedBy: recorded};
    if (item.reason === 'DEPENDENCY') {
      const root = item.executionId ? roots.get((item.traceRunId ?? '') + '/' + item.executionId) : undefined;
      if (root) return {...item, blockedBy: checkedBlocker(root.blockedBy) ?? blockerFrom(root)};
      return {...item, blockedBy: {kind: item.executionOutcome === 'Failed' ? 'failure' : 'unknown', reason: 'DEPENDENCY'} as RegressionBlocker};
    }
    const kind = item.reason==='PREREQUISITE'&&!item.executionId ? 'unknown' : regressionBlockedKind(item.reason);
    return {...item, blockedBy: {kind, ...(item.reason && Object.hasOwn(reasons, item.reason) ? {reason: item.reason} : {})}};
  });
}

export function blockedCounts(cases: BlockingEvidence[], executions = false): RegressionBlockedCounts {
  const counts = emptyBlockedCounts(), resolved = withBlockedCauses(cases);
  if (!executions) {
    for (const item of resolved) if (item.outcome === 'Blocked') counts[item.blockedBy!.kind]++;
    return counts;
  }
  const groups = new Map<string, typeof resolved>();
  for (const item of resolved) if (item.executionId && /^[a-f0-9]{24}$/.test(item.executionId)) {
    const key = (item.traceRunId ?? '') + '/' + item.executionId;
    const group=groups.get(key);if(group)group.push(item);else groups.set(key,[item]);
  }
  for (const rows of groups.values()) {
    const outcomes = rows.map(row => row.executionOutcome ?? row.outcome);
    if (outcomes.some(outcome => outcome === 'Failed' || outcome === 'Flaky') || !outcomes.some(outcome => outcome !== 'Passed')) continue;
    const kinds = rows.filter(row => row.outcome === 'Blocked').map(row => row.blockedBy!.kind);
    const kind = kinds.includes('failure') ? 'failure' : kinds.includes('prerequisite') ? 'prerequisite' :
      kinds.includes('cancelled') ? 'cancelled' : 'unknown';
    counts[kind]++;
  }
  return counts;
}
