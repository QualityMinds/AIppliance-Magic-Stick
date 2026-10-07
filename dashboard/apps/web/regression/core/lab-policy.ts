import type {LabConfig} from './config.ts';
import type {KubeObject} from './observer.ts';
import {readPrivate} from './private-files.ts';
import {requireSafe} from './errors.ts';

/** Versioned repository policy. Permissions are not user-maintained switches.
 * Registering a disposable lab authorizes these operations, not other targets. */
export const labPolicy = Object.freeze({version:1,phases:Object.freeze([0,1,2,3,4,5,6,7,8]),
  // Suite scope only: the product engine, its UI and runtime remain enabled.
  disabledExperimentalEngines:Object.freeze(['FreeToken']),
  scopes:Object.freeze(['gpu','identity','kubernetes','license','api-restart','first-license','modules','amd-profile',
    'federation','mesh','realtime','cache','reboot','unmanaged-key','host-drills']),
  credentialSeconds:86_400,namespace:'magicstick-regression',marker:'registered-lab'});
export interface LabRegistration {
  version:1;kind:'disposable-regression-lab';policyVersion:1;id:string;
  applianceUid:string;nodeUids:string[];dashboardUrl:string;identityUrl:string;
  createdAt:string;
}
export function parseRegistration(value:unknown):LabRegistration {
  const r=value as LabRegistration;
  requireSafe(r?.version === 1 && r.kind === 'disposable-regression-lab' && r.policyVersion === labPolicy.version &&
    /^[a-f0-9-]{36}$/.test(r.id) && /^[A-Za-z0-9-]{1,64}$/.test(r.applianceUid) &&
    Array.isArray(r.nodeUids) && r.nodeUids.length > 0 && r.nodeUids.length <= 64 &&
    new Set(r.nodeUids).size === r.nodeUids.length && r.nodeUids.every(uid=>/^[A-Za-z0-9-]{1,64}$/.test(uid)) &&
    Number.isFinite(Date.parse(r.createdAt)),'LAB');
  for(const field of ['dashboardUrl','identityUrl'] as const) {
    let url:URL;try{url=new URL(r[field]);}catch{requireSafe(false,'LAB');}
    requireSafe(url.protocol === 'https:' && url.origin === r[field] && !url.username && !url.password,'LAB');
  }
  return r;
}
export function verifyRegistration(r:LabRegistration,config:LabConfig,marker:KubeObject & {data?:Record<string,string>;immutable?:boolean}) {
  requireSafe(r.applianceUid === config.expected.applianceUid && r.dashboardUrl === config.dashboardUrl && r.identityUrl === config.identityUrl &&
    r.nodeUids.length === config.expected.nodes.length && r.nodeUids.every(uid=>config.expected.nodes.some(node=>node.uid === uid)) &&
    marker.immutable === true && marker.metadata.namespace === labPolicy.namespace && marker.metadata.name === labPolicy.marker &&
    marker.metadata.labels?.['regression.magicstick.dev/appliance-uid'] === r.applianceUid &&
    marker.data?.registrationId === r.id && marker.data?.policyVersion === String(labPolicy.version) &&
    marker.data?.kind === r.kind && marker.data?.nodeUids === [...r.nodeUids].sort().join(','),'LAB');
}
export async function registeredLab(config:LabConfig,observer:{get:(resource:string,namespace:string,name:string)=>Promise<KubeObject>}) {
  requireSafe(config.registrationFile,'LAB');
  const r=parseRegistration(JSON.parse(await readPrivate(config.registrationFile)));
  verifyRegistration(r,config,await observer.get('configmaps',labPolicy.namespace,labPolicy.marker));
  return r;
}
