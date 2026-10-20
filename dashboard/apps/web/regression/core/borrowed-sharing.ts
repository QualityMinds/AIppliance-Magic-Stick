import type {GpuSharingRequest, GpuSharingState} from '@magicstick/dashboard-contracts';
import type {KubeObject} from './observer.ts';
import {readPrivate, writePrivate} from './private-files.ts';
import {HarnessError,requireSafe} from './errors.ts';

export type Provider = 'amd' | 'nvidia';
/** A response that explicitly rejects a CAS write, never a transport timeout. */
export class SharingWriteRejected extends HarnessError {
  readonly httpStatus:number;
  constructor(httpStatus:number) {super(httpStatus === 409 ? 'CONFLICT' : 'API');this.httpStatus=httpStatus;}
}
export interface SharingSnapshot {object: KubeObject; state: GpuSharingState}
export interface SharingAdapter {
  read(provider: Provider): Promise<SharingSnapshot>;
  apply(request: GpuSharingRequest): Promise<void>;
}
interface BorrowedEntry {
  provider: Provider; uid: string; originalSpec: Record<string, unknown>;
  originalMode: GpuSharingState['mode']; originalCount: number;
  originalBackend?: 'dra' | 'device-plugin';
  generation: number; lastSpec: Record<string, unknown>;
  state: 'borrowed' | 'pending' | 'restored';
}
interface Data {version: 1; runId: string; targetUid: string; nodeName: string; nodeUid: string; entries: BorrowedEntry[]}

/** Order-insensitive exact JSON comparison, including all unrelated parameters. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a.localeCompare(b))
    .map(([key,item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}

export function sharingSpec(spec: Record<string, unknown>, request: GpuSharingRequest) {
  const next = structuredClone(spec);
  const parameters = {...(next.parameters as Record<string, unknown> ?? {})};
  // This is the existing product API's canonical persisted representation, not
  // a second backend. The API performs the actual CAS patch and reconciliation.
  const config = {allowExperimental:request.provider === 'amd' && request.mode === 'shared',
    maxModels:request.maxModels, mode:request.mode === 'exclusive' ? 'exclusive' : request.provider === 'amd' || request.allocationBackend === 'dra' ? 'dra-shared' : 'time-slicing',
    namespace:'ai',nodeName:request.nodeName,nodeUid:request.nodeUid,
    ...(request.provider === 'nvidia' && request.allocationBackend === 'dra' ? {allocationBackend:'dra'} : {})};
  parameters.gpuSharing = '{' + Object.entries(config).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value]) => JSON.stringify(key) + ': ' + JSON.stringify(value)).join(', ') + '}';
  if (request.provider === 'amd') parameters.validationRequest = '';
  next.parameters = parameters; return next;
}

/** Durable borrowed-setting transaction. UID + spec generation fence user
 * edits; status-only resourceVersion changes do not cause false conflicts.
 * An ambiguous write remains pending and is NEVER automatically adopted. */
export class BorrowedSharing {
  readonly filename:string;
  private data:Data;
  private adapter:SharingAdapter;
  private assertHeld:()=>Promise<void>;
  private constructor(filename:string,data:Data,adapter:SharingAdapter,assertHeld:()=>Promise<void>) {
    this.filename=filename;this.data=data;this.adapter=adapter;this.assertHeld=assertHeld;
  }
  get entries() {return structuredClone(this.data.entries);}
  static async create(filename: string, identity: Omit<Data,'version'|'entries'>, adapter: SharingAdapter,
    assertHeld: () => Promise<void>) {
    requireSafe(/^reg-[0-9a-f-]{36}$/.test(identity.runId) && identity.nodeUid.length > 0, 'CONFIG');
    const data: Data = {version:1,...identity,entries:[]};
    await writePrivate(filename,data,true);
    return new BorrowedSharing(filename,data,adapter,assertHeld);
  }
  static async resume(filename: string, identity: Omit<Data,'version'|'entries'>, adapter: SharingAdapter,
    assertHeld: () => Promise<void>) {
    const data = JSON.parse(await readPrivate(filename)) as Data;
    requireSafe(data.version === 1 && data.runId === identity.runId && data.targetUid === identity.targetUid &&
      data.nodeName === identity.nodeName && data.nodeUid === identity.nodeUid && Array.isArray(data.entries) && data.entries.length <= 2 &&
      new Set(data.entries.map(entry => entry.provider)).size === data.entries.length, 'OWNERSHIP');
    for (const entry of data.entries) requireSafe(['amd','nvidia'].includes(entry.provider) && typeof entry.uid === 'string' &&
      Number.isSafeInteger(entry.generation) && entry.generation > 0 && ['borrowed','pending','restored'].includes(entry.state) &&
      ['exclusive','shared'].includes(entry.originalMode) && Number.isSafeInteger(entry.originalCount) && entry.originalCount >= 2 &&
      (entry.originalBackend === undefined || ['dra','device-plugin'].includes(entry.originalBackend)) &&
      entry.originalCount <= 16 && entry.originalSpec && entry.lastSpec && typeof entry.originalSpec === 'object' &&
      typeof entry.lastSpec === 'object' && !Array.isArray(entry.originalSpec) && !Array.isArray(entry.lastSpec), 'OWNERSHIP');
    return new BorrowedSharing(filename,data,adapter,assertHeld);
  }
  private persist() {return writePrivate(this.filename,this.data);}
  /** No adoption of a lost response. After recovery fencing/drain, a pending
   * request may be cleared only at the exact last journaled spec generation. */
  async reconcileUnchanged() {
    for(const entry of this.data.entries)if(entry.state==='pending') {
      await this.current(entry);entry.state='borrowed';await this.persist();
    }
  }
  async verifyRecoverable() {
    for(const entry of this.data.entries)if(entry.state!=='restored')await this.current(entry);
  }
  private async current(entry: BorrowedEntry) {
    await this.assertHeld();
    const value = await this.adapter.read(entry.provider);
    requireSafe(value.object.metadata.uid === entry.uid && value.object.metadata.generation === entry.generation &&
      canonical(value.object.spec) === canonical(entry.lastSpec), 'CONFLICT');
    requireSafe(value.state.managed && value.state.nodeName === this.data.nodeName && value.state.nodeUid === this.data.nodeUid &&
      value.state.expectedRevision === value.object.metadata.resourceVersion, 'IDENTITY');
    return value;
  }
  async borrow(provider: Provider) {
    requireSafe(!this.data.entries.some(entry => entry.provider === provider), 'OWNERSHIP');
    await this.assertHeld(); const value = await this.adapter.read(provider);
    const {uid,generation} = value.object.metadata, parameters = value.object.spec?.parameters as Record<string,unknown> | undefined;
    requireSafe(value.state.provider === provider && value.state.managed && value.state.available && value.state.phase === 'Ready' &&
      value.state.nodeName === this.data.nodeName && value.state.nodeUid === this.data.nodeUid && uid && generation &&
      parameters && parameters.gpuSharing && Number.isSafeInteger(value.state.maxModels) && value.state.maxModels >= 2 &&
      value.state.maxModels <= 16 && (!parameters.validationRequest || parameters.validationRequest === ''), 'CAPABILITY');
    // Unmanaged/custom configurations cannot be faithfully removed through this
    // API. Do not adopt them just to make a test pass.
    const request = this.request(value.state,value.state.mode,value.state.maxModels);
    requireSafe(canonical(sharingSpec(value.object.spec!,request)) === canonical(value.object.spec), 'CAPABILITY');
    this.data.entries.push({provider,uid,originalSpec:structuredClone(value.object.spec!),originalMode:value.state.mode,
      originalCount:value.state.maxModels, originalBackend:provider === 'nvidia' && value.state.backend === 'dra' ? 'dra' : 'device-plugin', generation,lastSpec:structuredClone(value.object.spec!),state:'borrowed'});
    await this.persist();
  }
  private request(state: GpuSharingState, mode: GpuSharingState['mode'], maxModels: number): GpuSharingRequest {
    return {provider:state.provider,mode,maxModels,nodeName:this.data.nodeName,nodeUid:this.data.nodeUid,
      expectedRevision:state.expectedRevision,acknowledgeSharing:mode === 'shared',acknowledgeRestart:true,
      ...(state.provider === 'nvidia' ? {allocationBackend:state.backend === 'dra' ? 'dra' : 'device-plugin'} : {})};
  }
  async change(provider: Provider, mode: GpuSharingState['mode'], maxModels: number, backend?: 'dra' | 'device-plugin') {
    requireSafe(['exclusive','shared'].includes(mode) && Number.isSafeInteger(maxModels) && maxModels >= 2 && maxModels <= 16, 'CONFIG');
    const entry = this.data.entries.find(item => item.provider === provider);
    requireSafe(entry?.state === 'borrowed', 'OWNERSHIP');
    const current = await this.current(entry);
    const request = {...this.request(current.state,mode,maxModels), ...(provider === 'nvidia' && backend ? {allocationBackend:backend} : {})}, expectedSpec = sharingSpec(entry.lastSpec,request);
    if (canonical(expectedSpec) === canonical(entry.lastSpec)) return;
    entry.state = 'pending'; await this.persist(); await this.assertHeld();
    try {await this.adapter.apply(request);}
    catch (error) {
      if (error instanceof SharingWriteRejected) {
        // Restore permission only after independent proof that nothing changed.
        // In particular, never adopt an accepted write with a lost response.
        await this.current(entry); entry.state = 'borrowed'; await this.persist();
      }
      throw error;
    }
    const after = await this.adapter.read(provider);
    requireSafe(after.object.metadata.uid === entry.uid && after.object.metadata.generation === entry.generation + 1 &&
      canonical(after.object.spec) === canonical(expectedSpec), 'CONFLICT');
    entry.generation = after.object.metadata.generation!; entry.lastSpec = expectedSpec; entry.state = 'borrowed';
    await this.persist();
  }
  async restore() {
    for (const entry of [...this.data.entries].reverse()) {
      if (entry.state === 'restored') continue;
      requireSafe(entry.state === 'borrowed', 'CONFLICT');
      for (let attempt=0;attempt<3;attempt++) {
        try {await this.change(entry.provider,entry.originalMode,entry.originalCount,entry.originalBackend ?? 'device-plugin');break;}
        catch(error) {
          // A 409 is retriable only after change() independently proved that
          // the previously owned UID/generation/spec was not changed.
          if (!(error instanceof SharingWriteRejected) || error.httpStatus !== 409 || attempt === 2) throw error;
        }
      }
      const current = await this.current(entry);
      requireSafe(canonical(current.object.spec) === canonical(entry.originalSpec), 'CLEANUP');
      entry.state = 'restored'; await this.persist();
    }
  }
}
