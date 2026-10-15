import type {KubeObject} from './observer.ts';
import {canonical} from './borrowed-sharing.ts';
import {requireSafe} from './errors.ts';
import {readPrivate,writePrivate} from './private-files.ts';
import {poll} from './poll.ts';
import {AdministrationRejected} from './administration-api.ts';
import {MutationNotSubmitted} from './browser-action.ts';

interface Adapter {
  read():Promise<KubeObject>;
  set(enabled:boolean,parameters:Record<string,string>):Promise<unknown>;
}

/** One pre-created optional module; no deletion or prefix adoption.
 * Observe and journal writes before asserting their success/rejection, so even
 * an unexpectedly accepted negative request is covered by final restoration. */
export class BorrowedModule {
  private applied?:KubeObject;
  private restored?:KubeObject;
  private unresolved=false;
  readonly original:KubeObject;
  readonly receipt:string;
  readonly adapter:Adapter;
  readonly guard:()=>Promise<void>;
  constructor(original:KubeObject,receipt:string,adapter:Adapter,guard:()=>Promise<void>) {
    this.original=original;this.receipt=receipt;this.adapter=adapter;this.guard=guard;
    requireSafe(original.metadata.uid && original.metadata.generation && typeof original.spec?.enabled === 'boolean' &&
      (original.spec.parameters === undefined || original.spec.parameters && typeof original.spec.parameters === 'object' &&
        !Array.isArray(original.spec.parameters)),'PREREQUISITE');
  }
  static async resume(receipt:string,adapter:Adapter,guard:()=>Promise<void>) {
    const value=JSON.parse(await readPrivate(receipt));
    requireSafe(value.version===1&&['requested','ambiguous','applied','unchanged','restored'].includes(value.state),'OWNERSHIP');
    const borrowed=new BorrowedModule(value.original,receipt,adapter,guard);
    if(value.applied) {
      requireSafe(value.applied.metadata?.uid===value.original.metadata.uid&&Number.isSafeInteger(value.applied.metadata.generation)&&
        value.applied.metadata.generation>=value.original.metadata.generation&&value.applied.spec,'OWNERSHIP');
      borrowed.applied=value.applied;
    }
    if(value.restored) {
      requireSafe(value.restored.metadata?.uid===value.original.metadata.uid &&
        Number.isSafeInteger(value.restored.metadata.generation) && value.restored.metadata.generation>=value.original.metadata.generation &&
        canonical(value.restored.spec)===canonical(value.original.spec),'OWNERSHIP');
      borrowed.restored=value.restored;
    }
    borrowed.unresolved=['requested','ambiguous'].includes(value.state);
    return borrowed;
  }
  /** Recovery has already fenced the expired owner and drained bounded writes.
   * Only the last independently journaled UID/generation/spec is accepted;
   * an unacknowledged changed spec is never adopted. */
  async reconcileUnchanged() {
    await this.current();
    if(this.unresolved) {
      this.unresolved=false;
      await writePrivate(this.receipt,{version:1,original:this.original,applied:this.applied,state:this.applied?'applied':'unchanged'});
    }
  }
  private async current() {
    await this.guard(); const current=await this.adapter.read(),expected=this.applied ?? this.restored ?? this.original;
    requireSafe(current.metadata.uid === expected.metadata.uid && current.metadata.generation === expected.metadata.generation &&
      canonical(current.spec) === canonical(expected.spec),'CONFLICT');
    return current;
  }
  async change(enabled:boolean,parameters:Record<string,string>,action?:(acknowledge:()=>Promise<void>)=>Promise<unknown>) {
    const before=await this.current();
    this.unresolved=true;
    await writePrivate(this.receipt,{version:1,original:this.original,applied:this.applied,restored:this.restored,state:'requested'});
    let acknowledged=false;
    const acknowledge=async()=>{
      await this.guard();const current=await this.adapter.read();
      requireSafe(current.metadata.uid===before.metadata.uid,'CONFLICT');
      // Empty requests preserve an absent optional parameter map. Missing and
      // empty are not interchangeable ownership/revision evidence.
      const expected={...before.spec,enabled,...(before.spec?.parameters !== undefined || Object.keys(parameters).length ? {parameters} : {})};
      const merged={...expected,parameters:{...(before.spec?.parameters as Record<string,string>),...parameters}};
      if(canonical(current.spec)!==canonical(before.spec)) {
        requireSafe(current.metadata.generation===Number(before.metadata.generation)+1 &&
          [canonical(expected),canonical(merged)].includes(canonical(current.spec)),'CONFLICT');
        this.applied=structuredClone(current);
      } else requireSafe(current.metadata.generation===before.metadata.generation,'CONFLICT');
      await writePrivate(this.receipt,{version:1,original:this.original,applied:this.applied,restored:this.restored,state:this.applied?'applied':'unchanged'});
      this.unresolved=false;acknowledged=true;
    };
    try {const result=await (action ? action(acknowledge) : this.adapter.set(enabled,parameters));if(!acknowledged)await acknowledge();return result;}
    catch(error) {
      if(error instanceof MutationNotSubmitted || error instanceof AdministrationRejected && [400,403,409,422].includes(error.status)) {
        // A proven non-write cannot authorize adoption of any changed spec.
        await this.current();this.unresolved=false;acknowledged=true;
        await writePrivate(this.receipt,{version:1,original:this.original,applied:this.applied,restored:this.restored,state:this.applied?'applied':'unchanged'});
      }
      throw error;
    }
    finally {
      // A timeout/transport error is never treated as absence or adoption proof.
      if(!acknowledged)await writePrivate(this.receipt,{version:1,original:this.original,applied:this.applied,restored:this.restored,state:'ambiguous'});
    }
  }
  async restore() {
    requireSafe(!this.unresolved,'CLEANUP');
    if(!this.applied){await this.current();await writePrivate(this.receipt,{version:1,original:this.original,restored:this.restored,state:'restored'});return;}
    const current=await this.current(),parameters=(this.original.spec!.parameters ?? {}) as Record<string,string>;
    // A confirmed forward change may already have returned to the baseline.
    // Do not demand a nonexistent generation increment from an idempotent API.
    if(canonical(current.spec) === canonical(this.original.spec)) {
      this.applied=undefined;this.restored=structuredClone(current);
      await writePrivate(this.receipt,{version:1,original:this.original,restored:this.restored,state:'restored'});return;
    }
    await this.adapter.set(this.original.spec!.enabled as boolean,parameters);
    const restored=await poll(async()=>{await this.guard();return this.adapter.read();},item=>
      item.metadata.uid === current.metadata.uid && item.metadata.generation === Number(current.metadata.generation)+1 &&
      canonical(item.spec) === canonical(this.original.spec),{timeoutMs:30_000,intervalMs:500,stage:'cleanup'});
    requireSafe(restored.metadata.uid === this.original.metadata.uid && canonical(restored.spec) === canonical(this.original.spec),'CLEANUP');
    this.applied=undefined;
    this.restored=structuredClone(restored);
    await writePrivate(this.receipt,{version:1,original:this.original,restored:this.restored,state:'restored'});
  }
}
