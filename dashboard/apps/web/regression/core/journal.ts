import {randomUUID} from 'node:crypto';
import {HarnessError, requireSafe,reasons,stages,type ReasonCode,type Stage} from './errors.ts';
import {readPrivate, writePrivate} from './private-files.ts';

export type ResourceKind = 'model' | 'app' | 'key' | 'identity';
const cleanupOperations=['guard','lookup','remove','verify','persist'] as const;
export interface CleanupFailure {operation:typeof cleanupOperations[number];reason:ReasonCode;stage?:Stage}
export interface JournalEntry {kind: ResourceKind; name: string; uid: string | null; state: 'requested' | 'owned' | 'removed' | 'blocked'; generation?: number;
  cleanupFailure?:CleanupFailure}
interface JournalData {version: 1; runId: string; targetUid: string; prefix: string; entries: JournalEntry[]}

function cleanupFailure(operation:CleanupFailure['operation'],error:unknown):CleanupFailure {
  const reason=error instanceof HarnessError && Object.hasOwn(reasons,error.code) ? error.code : 'UNEXPECTED';
  const stage=error instanceof HarnessError && error.stage && stages.includes(error.stage) ? error.stage : undefined;
  return {operation,reason,...(stage?{stage}:{})};
}
function validCleanupFailure(value:unknown):value is CleanupFailure {
  if(!value || typeof value!=='object' || Array.isArray(value))return false;
  const item=value as CleanupFailure;
  return Object.keys(item).every(key=>['operation','reason','stage'].includes(key)) && cleanupOperations.includes(item.operation) &&
    Object.hasOwn(reasons,item.reason) && (item.stage===undefined || stages.includes(item.stage));
}
export interface CleanupAdapter {
  lookup(entry: JournalEntry): Promise<{uid: string} | null>;
  /** Must reject UID replacement atomically, not GET-then-DELETE by name. */
  removeIfUid(entry: JournalEntry, uid: string): Promise<void>;
  verifyRemoved(entry: JournalEntry): Promise<boolean>;
}

/** AppInstance names have a catalog-type prefix before the run prefix. It is
 * still an exact journal entry, never a license to sweep a matching prefix. */
export function ownedJournalName(kind:ResourceKind,name:string,prefix:string) {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(name) && (name.startsWith(prefix) ||
    kind === 'app' && ['openclaw','hermes','paperclip','kubeopencode','odysseus'].some(type=>name.startsWith(type+'-'+prefix)));
}

export function newRunId() { return `reg-${randomUUID()}`; }

/** Recovery reads exactly one reviewed private journal, not a glob or prefix.
 * GPU worker replacement may add one bounded child directory. CPU recovery
 * retains its original root-only path contract. */
export function recoveryJournalPath(value:unknown,gpu=false):value is string {
  if(typeof value !== 'string') return false;
  const match=value.match(/^\/private\/runs\/reg-[0-9a-f-]{36}\/(?:worker-([1-9][0-9]?)\/)?journal\.json$/);
  return Boolean(match && (!match[1] || gpu && Number(match[1]) <= 64));
}

export class ResourceJournal {
  readonly filename: string;
  private data: JournalData;
  private writes:Promise<void> = Promise.resolve();
  private constructor(filename: string, data: JournalData) { this.filename = filename; this.data = data; }
  get entries(): ReadonlyArray<JournalEntry> { return this.data.entries.map(item => ({...item,
    ...(item.cleanupFailure?{cleanupFailure:{...item.cleanupFailure}}:{})})); }
  /** Fixed diagnostic vocabulary only; no resource names, IDs or upstream body. */
  get cleanupFailures():ReadonlyArray<CleanupFailure&{kind:ResourceKind}> {
    return this.data.entries.flatMap(item=>item.cleanupFailure?[{kind:item.kind,...item.cleanupFailure}]:[]);
  }
  get runId() { return this.data.runId; }
  get prefix() { return this.data.prefix; }

  static async create(filename: string, runId: string, targetUid: string) {
    requireSafe(/^reg-[0-9a-f-]{36}$/.test(runId) && targetUid.length > 0, 'OWNERSHIP');
    const prefix = `reg-${runId.slice(4, 16)}-`;
    const journal = new ResourceJournal(filename, {version: 1, runId, targetUid, prefix, entries: []});
    await writePrivate(filename, journal.data, true);
    return journal;
  }
  static async resume(filename: string, targetUid: string) {
    let data: JournalData;
    try { data = JSON.parse(await readPrivate(filename)); } catch { throw new HarnessError('OWNERSHIP'); }
    requireSafe(data && typeof data === 'object' && data.version === 1 && data.targetUid === targetUid && /^reg-[0-9a-f-]{36}$/.test(data.runId) &&
      data.prefix === `reg-${data.runId.slice(4, 16)}-` && Array.isArray(data.entries), 'OWNERSHIP');
    const seen = new Set<string>();
    for (const item of data.entries) {
      requireSafe(item && typeof item === 'object' && ['model', 'app', 'key', 'identity'].includes(item.kind) &&
        typeof item.name === 'string' && ownedJournalName(item.kind,item.name,data.prefix) && ['requested', 'owned', 'removed', 'blocked'].includes(item.state) &&
        (item.uid === null || (typeof item.uid === 'string' && item.uid.length > 0)) &&
        // A conclusively rejected create is removed without ever owning a UID.
        // Such an entry is skipped, never adopted or deleted, during recovery.
        (item.state !== 'owned' || item.uid !== null) &&
        (item.generation === undefined || (['model','app'].includes(item.kind) && Number.isSafeInteger(item.generation) && item.generation > 0 && item.uid !== null)) &&
        (item.cleanupFailure===undefined || item.state==='blocked' && validCleanupFailure(item.cleanupFailure)) &&
        !seen.has(`${item.kind}:${item.name}`), 'OWNERSHIP');
      seen.add(`${item.kind}:${item.name}`);
    }
    return new ResourceJournal(filename, data);
  }
  private persist() {
    // Racing API clients share one journal. A slower old rename must never
    // replace a newer ownership snapshot after a successful concurrent create.
    this.writes = this.writes.catch(()=>{}).then(()=>writePrivate(this.filename,this.data));
    return this.writes;
  }

  /** Persist before a future API request; ambiguous requests never get retried here. */
  async requested(kind: ResourceKind, name: string) {
    requireSafe(ownedJournalName(kind,name,this.prefix) &&
      !this.data.entries.some(item => item.kind === kind && item.name === name), 'OWNERSHIP');
    this.data.entries.push({kind, name, uid: null, state: 'requested'});
    await this.persist();
  }
  async owned(kind: ResourceKind, name: string, uid: string, generation?: number) {
    const entry = this.data.entries.find(item => item.kind === kind && item.name === name);
    requireSafe(entry?.state === 'requested' && typeof uid === 'string' && uid.length > 0 &&
      (generation === undefined || (['model','app'].includes(kind) && Number.isSafeInteger(generation) && generation > 0)), 'OWNERSHIP');
    entry.uid = uid; entry.state = 'owned';
    if (generation !== undefined) entry.generation = generation;
    await this.persist();
  }
  /** Mark a reviewed request as conclusively rejected only after an independent
   * lookup proved that no object with the run-owned name exists. */
  async rejected(kind: ResourceKind, name: string) {
    const entry = this.data.entries.find(item => item.kind === kind && item.name === name);
    requireSafe(entry?.state === 'requested' && entry.uid === null, 'OWNERSHIP');
    entry.state = 'removed'; await this.persist();
  }
  /** Only registered recovery, after fencing/draining the prior runner and
   * independently proving absence. An existing object without a recorded UID
   * still cannot be adopted or deleted. */
  async recoveredAbsent(kind:ResourceKind,name:string) {
    const entry=this.data.entries.find(item=>item.kind===kind&&item.name===name);
    requireSafe(entry&&['requested','blocked'].includes(entry.state)&&entry.uid===null,'OWNERSHIP');
    entry.state='removed';delete entry.cleanupFailure;await this.persist();
  }
  /** A model spec change is journaled immediately after the API acknowledges it. */
  async modelGeneration(name: string, uid: string, previous: number, generation: number) {
    return this.generation('model',name,uid,previous,generation);
  }
  async generation(kind:'model'|'app',name:string,uid:string,previous:number,generation:number) {
    const entry = this.data.entries.find(item => item.kind === kind && item.name === name);
    requireSafe(entry?.state === 'owned' && entry.uid === uid && entry.generation === previous &&
      Number.isSafeInteger(generation) && generation > previous, 'OWNERSHIP');
    entry.generation = generation;
    await this.persist();
  }
  /** Inspectable recovery plan only: this operation never removes a resource. */
  recoveryPlan() { return this.entries.filter(item => item.state !== 'removed').map(item => ({...item,
    automaticallyRemovable: (item.state === 'owned' || item.state === 'blocked') && item.uid !== null &&
      (!['model','app'].includes(item.kind) || item.generation !== undefined)})); }

  async verifyCleanup(adapters:Record<ResourceKind,CleanupAdapter>,assertHeld:()=>Promise<void>) {
    requireSafe(this.recoveryPlan().length===0,'CLEANUP');
    for(const entry of this.entries) {
      await assertHeld();requireSafe(await adapters[entry.kind].verifyRemoved(entry),'CLEANUP');
    }
  }

  async cleanup(adapters: Record<ResourceKind, CleanupAdapter>, assertHeld: () => Promise<void>,
    only?: {kind: ResourceKind; name: string}) {
    if (only) requireSafe(this.data.entries.some(entry => entry.kind === only.kind && entry.name === only.name), 'OWNERSHIP');
    const failures: CleanupFailure[] = [];
    for (const entry of [...this.data.entries].reverse()) {
      if (entry.state === 'removed') continue;
      if (only && (entry.kind !== only.kind || entry.name !== only.name)) continue;
      let operation:CleanupFailure['operation']='guard';
      try {
        await assertHeld();
        operation='lookup';
        requireSafe((entry.state === 'owned' || entry.state === 'blocked') && entry.uid, 'OWNERSHIP');
        const adapter = adapters[entry.kind];
        requireSafe(adapter, 'CLEANUP');
        const current = await adapter.lookup({...entry});
        if (current) {
          requireSafe(current.uid === entry.uid, 'OWNERSHIP');
          operation='guard';
          await assertHeld();
          operation='remove';
          await adapter.removeIfUid({...entry}, entry.uid);
        }
        operation='verify';
        requireSafe(await adapter.verifyRemoved({...entry}), 'CLEANUP');
        entry.state = 'removed'; delete entry.cleanupFailure;operation='persist';await this.persist();
      } catch(error) {
        entry.state = 'blocked';entry.cleanupFailure=cleanupFailure(operation,error);
        // Diagnostic storage can fail too. Keep the in-memory fence and the
        // fixed persist reason; a later attempt still re-observes exact UID.
        try{await this.persist();}catch(persistError){entry.cleanupFailure=cleanupFailure('persist',persistError);}
        failures.push({...entry.cleanupFailure});
      }
    }
    if (failures.length) throw new HarnessError('CLEANUP', 'Failed',failures[0]!.stage ?? 'cleanup');
  }
}

/** A fixture-tested guard; no live global-setting adapter is enabled in phase 0. */
export async function restoreRevision<T>(original: T, appliedRevision: string, adapter: {
  currentRevision(): Promise<string>; restore(value: T, expectedRevision: string): Promise<void>;
}, assertHeld: () => Promise<void>) {
  await assertHeld();
  requireSafe(await adapter.currentRevision() === appliedRevision, 'CONFLICT');
  await assertHeld();
  await adapter.restore(original, appliedRevision);
}
