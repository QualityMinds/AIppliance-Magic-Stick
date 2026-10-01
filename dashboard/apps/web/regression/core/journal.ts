import {randomUUID} from 'node:crypto';
import {HarnessError, requireSafe} from './errors.ts';
import {readPrivate, writePrivate} from './private-files.ts';

export type ResourceKind = 'model' | 'app' | 'key' | 'identity';
export interface JournalEntry {kind: ResourceKind; name: string; uid: string | null; state: 'requested' | 'owned' | 'removed' | 'blocked'; generation?: number}
interface JournalData {version: 1; runId: string; targetUid: string; prefix: string; entries: JournalEntry[]}
export interface CleanupAdapter {
  lookup(entry: JournalEntry): Promise<{uid: string} | null>;
  /** Must reject UID replacement atomically, not GET-then-DELETE by name. */
  removeIfUid(entry: JournalEntry, uid: string): Promise<void>;
  verifyRemoved(entry: JournalEntry): Promise<boolean>;
}

export function newRunId() { return `reg-${randomUUID()}`; }

export class ResourceJournal {
  readonly filename: string;
  private data: JournalData;
  private constructor(filename: string, data: JournalData) { this.filename = filename; this.data = data; }
  get entries(): ReadonlyArray<JournalEntry> { return this.data.entries.map(item => ({...item})); }
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
        typeof item.name === 'string' && item.name.startsWith(data.prefix) &&
        /^[a-z0-9][a-z0-9-]{0,62}$/.test(item.name) && ['requested', 'owned', 'removed', 'blocked'].includes(item.state) &&
        (item.uid === null || (typeof item.uid === 'string' && item.uid.length > 0)) &&
        ((item.state !== 'owned' && item.state !== 'removed') || item.uid !== null) &&
        (item.generation === undefined || (item.kind === 'model' && Number.isSafeInteger(item.generation) && item.generation > 0 && item.uid !== null)) &&
        !seen.has(`${item.kind}:${item.name}`), 'OWNERSHIP');
      seen.add(`${item.kind}:${item.name}`);
    }
    return new ResourceJournal(filename, data);
  }
  private persist() { return writePrivate(this.filename, this.data); }

  /** Persist before a future API request; ambiguous requests never get retried here. */
  async requested(kind: ResourceKind, name: string) {
    requireSafe(name.startsWith(this.prefix) && /^[a-z0-9][a-z0-9-]{0,62}$/.test(name) &&
      !this.data.entries.some(item => item.kind === kind && item.name === name), 'OWNERSHIP');
    this.data.entries.push({kind, name, uid: null, state: 'requested'});
    await this.persist();
  }
  async owned(kind: ResourceKind, name: string, uid: string, generation?: number) {
    const entry = this.data.entries.find(item => item.kind === kind && item.name === name);
    requireSafe(entry?.state === 'requested' && typeof uid === 'string' && uid.length > 0 &&
      (generation === undefined || (kind === 'model' && Number.isSafeInteger(generation) && generation > 0)), 'OWNERSHIP');
    entry.uid = uid; entry.state = 'owned';
    if (generation !== undefined) entry.generation = generation;
    await this.persist();
  }
  /** A model spec change is journaled immediately after the API acknowledges it. */
  async modelGeneration(name: string, uid: string, previous: number, generation: number) {
    const entry = this.data.entries.find(item => item.kind === 'model' && item.name === name);
    requireSafe(entry?.state === 'owned' && entry.uid === uid && entry.generation === previous &&
      Number.isSafeInteger(generation) && generation > previous, 'OWNERSHIP');
    entry.generation = generation;
    await this.persist();
  }
  /** Inspectable recovery plan only: this operation never removes a resource. */
  recoveryPlan() { return this.entries.filter(item => item.state !== 'removed').map(item => ({...item,
    automaticallyRemovable: (item.state === 'owned' || item.state === 'blocked') && item.uid !== null &&
      (item.kind !== 'model' || item.generation !== undefined)})); }

  async cleanup(adapters: Record<ResourceKind, CleanupAdapter>, assertHeld: () => Promise<void>) {
    const failures: string[] = [];
    for (const entry of [...this.data.entries].reverse()) {
      if (entry.state === 'removed') continue;
      try {
        await assertHeld();
        requireSafe((entry.state === 'owned' || entry.state === 'blocked') && entry.uid, 'OWNERSHIP');
        const adapter = adapters[entry.kind];
        requireSafe(adapter, 'CLEANUP');
        const current = await adapter.lookup({...entry});
        if (current) {
          requireSafe(current.uid === entry.uid, 'OWNERSHIP');
          await assertHeld();
          await adapter.removeIfUid({...entry}, entry.uid);
        }
        requireSafe(await adapter.verifyRemoved({...entry}), 'CLEANUP');
        entry.state = 'removed'; await this.persist();
      } catch {
        entry.state = 'blocked'; await this.persist(); failures.push(entry.name);
      }
    }
    if (failures.length) throw new HarnessError('CLEANUP', 'Failed');
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
