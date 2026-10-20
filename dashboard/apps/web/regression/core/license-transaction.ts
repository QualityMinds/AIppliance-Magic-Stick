import {createHash} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import {requireProof as requireSafe,atStage} from './errors.ts';
import {canonicalInput} from './input-preparation.ts';
import {readPrivate} from './private-files.ts';

export const licenseHash=(document:string|null)=>document===null?null:createHash('sha256').update(document).digest('hex');
export interface LicenseSnapshot {uid:string;revision:string;installationId:string;document:string|null;otherData:Record<string,string>}
export interface LicenseReceipt {
  version:1;secretUid:string;installationId:string;beforeRevision:string;originalHash:string|null;
  otherDataHash:string;
  selectedHash?:string|null;appliedRevision?:string;restoredRevision?:string;
  state:'reviewed'|'requested'|'forwarded'|'applied'|'restoring'|'restored';
}
interface Ports {state:()=>Promise<LicenseSnapshot>;guard:()=>Promise<void>;
  restore:(current:LicenseSnapshot,document:string|null)=>Promise<void>;record:(receipt:LicenseReceipt)=>Promise<void>}
/** Borrow one exact document, never the Secret/installation identity. Register
 * restore() before arming a write. A lost response is reconciled only against
 * the exact candidate and unchanged UID/other fields; a confirmed revision may
 * not be silently advanced by a later writer. Receipts contain no documents. */
export class LicenseTransaction {
  private receipt:LicenseReceipt;
  private selected?:string;
  readonly original:LicenseSnapshot;
  private ports:Ports;
  constructor(original:LicenseSnapshot,ports:Ports) {
    this.original=original;this.ports=ports;
    this.receipt={version:1,secretUid:original.uid,installationId:original.installationId,beforeRevision:original.revision,
      originalHash:licenseHash(original.document),otherDataHash:licenseHash(canonicalInput(original.otherData))!,state:'reviewed'};
  }
  async begin(){await this.ports.record(this.receipt);return this;}
  private sameIdentity(current:LicenseSnapshot) {
    requireSafe(current.uid===this.original.uid&&current.installationId===this.original.installationId&&
      canonicalInput(current.otherData)===canonicalInput(this.original.otherData),'CONFLICT');
  }
  async unchanged() {
    const current=await this.ports.state();this.sameIdentity(current);
    requireSafe(current.revision===this.original.revision&&current.document===this.original.document,'API');
  }
  async request(document:string) {
    requireSafe(['reviewed','requested','forwarded'].includes(this.receipt.state),'CONFLICT');
    await this.unchanged();await this.ports.guard();this.selected=document;
    this.receipt={...this.receipt,selectedHash:licenseHash(document),state:'requested'};
    await this.ports.record(this.receipt);
  }
  /** Called by the existing guarded transport after approval, immediately
   * before forwarding. Preparing a UI click alone is not a submitted write. */
  async forwarded() {
    requireSafe(this.receipt.state==='requested','CONFLICT');await this.unchanged();
    this.receipt={...this.receipt,state:'forwarded'};await this.ports.record(this.receipt);
  }
  async acknowledge(revision:string) {
    const current=await this.ports.state();this.sameIdentity(current);
    requireSafe(this.receipt.state==='forwarded'&&this.selected!==undefined&&current.document===this.selected&&current.revision===revision,'API');
    this.receipt={...this.receipt,appliedRevision:revision,state:'applied'};await this.ports.record(this.receipt);
  }
  async restore() {await atStage('license-restore',async()=>{
    await this.ports.guard();const current=await this.ports.state();this.sameIdentity(current);
    if(this.receipt.state==='restored') {
      requireSafe(current.document===this.original.document&&current.revision===this.receipt.restoredRevision,'CONFLICT');
      // The last durable write itself may have failed after restoration.
      // Reconcile the same verified result instead of leaving a stale receipt.
      await this.ports.record(this.receipt);return;
    }
    const unchanged=current.revision===this.original.revision&&current.document===this.original.document;
    // A prior restore may have committed while its response was lost. Only a
    // recorded restore intent permits recognizing the exact original again.
    const restored=this.receipt.state==='restoring'&&current.document===this.original.document;
    if(!unchanged&&!restored) {
      requireSafe(this.selected!==undefined&&['forwarded','applied','restoring'].includes(this.receipt.state)&&current.document===this.selected&&
        (!this.receipt.appliedRevision||current.revision===this.receipt.appliedRevision),'CONFLICT');
      this.receipt={...this.receipt,appliedRevision:current.revision,state:'restoring'};
      await this.ports.record(this.receipt);await this.ports.guard();
      await this.ports.restore(current,this.original.document);
    }
    const verified=await this.ports.state();this.sameIdentity(verified);
    requireSafe(verified.document===this.original.document,'CLEANUP');
    this.receipt={...this.receipt,restoredRevision:verified.revision,state:'restored'};await this.ports.record(this.receipt);
  });}
}

/** A killed worker may never execute its in-memory callback. Do not release
 * its lab lease merely because the ordinary owned-resource journal is empty. */
export async function assertLicenseReceiptsRestored(directory:string) {
  for(const name of await readdir(directory))if(/^license-(?:transaction(?:-lic-0[234])?|baseline(?:-(?:lic-01|sso-01))?)\.json$/.test(name)) {
    const value=JSON.parse(await readPrivate(directory+'/'+name));
    requireSafe(value.version===1&&value.state==='restored','CLEANUP');
  }
}
