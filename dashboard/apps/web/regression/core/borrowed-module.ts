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

/** One disabled, pre-created optional module; no deletion or prefix adoption.
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
    requireSafe(original.metadata.uid && original.metadata.generation && original.spec?.enabled === false &&
      original.spec.parameters && typeof original.spec.parameters === 'object','PREREQUISITE');
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
  async change(enabled:boolean,parameters:Record<string,string>,action?:()=>Promise<unknown>) {
    const before=await this.current();
    this.unresolved=true;
    await writePrivate(this.receipt,{version:1,original:this.original,applied:this.applied,state:'requested'});
    let acknowledged=false;
    try {const result=await (action ?? (()=>this.adapter.set(enabled,parameters)))();acknowledged=true;return result;}
    catch(error) {
      if(error instanceof MutationNotSubmitted || error instanceof AdministrationRejected && [400,403,409,422].includes(error.status))acknowledged=true;
      throw error;
    }
    finally {
      // A timeout/transport error is never treated as absence or adoption proof.
      if(!acknowledged)await writePrivate(this.receipt,{version:1,original:this.original,applied:this.applied,state:'ambiguous'});
      else {
        await this.guard(); const current=await this.adapter.read();
        requireSafe(current.metadata.uid === before.metadata.uid,'CONFLICT');
        if(canonical(current.spec) !== canonical(before.spec)) {
          const expected={...before.spec,enabled,parameters};
          const merged={...expected,parameters:{...(before.spec?.parameters as Record<string,string>),...parameters}};
          requireSafe(current.metadata.generation === Number(before.metadata.generation)+1 &&
            [canonical(expected),canonical(merged)].includes(canonical(current.spec)),'CONFLICT');
          this.applied=structuredClone(current);
          await writePrivate(this.receipt,{version:1,original:this.original,applied:this.applied,state:'applied'});
        } else requireSafe(current.metadata.generation === before.metadata.generation,'CONFLICT');
        this.unresolved=false;
      }
    }
  }
  async restore() {
    requireSafe(!this.unresolved,'CLEANUP');
    if(!this.applied){await this.current();await writePrivate(this.receipt,{version:1,original:this.original,state:'restored'});return;}
    const current=await this.current(),parameters=this.original.spec!.parameters as Record<string,string>;
    await this.adapter.set(false,parameters);
    const restored=await poll(async()=>{await this.guard();return this.adapter.read();},item=>
      item.metadata.uid === current.metadata.uid && item.metadata.generation === Number(current.metadata.generation)+1 &&
      canonical(item.spec) === canonical(this.original.spec),{timeoutMs:30_000,intervalMs:500,stage:'cleanup'});
    requireSafe(restored.metadata.uid === this.original.metadata.uid && canonical(restored.spec) === canonical(this.original.spec),'CLEANUP');
    this.applied=undefined;
    this.restored=structuredClone(restored);
    await writePrivate(this.receipt,{version:1,original:this.original,state:'restored'});
  }
}
