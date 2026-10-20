import {join} from 'node:path';
import type {DashboardLoginConfig} from './auth.ts';
import {requireSafe,requireProof} from './errors.ts';
import {readPrivate} from './private-files.ts';
import {readOnlyApi} from './transport.ts';

export const nonDestructiveVariants = Object.fromEntries(Array.from({length:9},(_,phase)=>[
  [`p${phase}-non-destructive-tls`,'HAR-01'],[`p${phase}-non-destructive-read`,'HAR-02']]).flat());

export async function readOnlyConnection(input: string): Promise<DashboardLoginConfig & {applianceUid:string;nodeUids:string[];caFile:string}> {
  const value=JSON.parse(await readPrivate(join(input,'non-destructive.json')));
  requireSafe(value?.version===1 && value.testMode==='non-destructive' &&
    /^[a-f0-9-]{36}$/.test(value.applianceUid) && Array.isArray(value.nodeUids) && value.nodeUids.length>0 &&
    value.nodeUids.every((uid:unknown)=>typeof uid==='string'&&/^[a-f0-9-]{36}$/.test(uid)),'CONFIG');
  const dashboard=new URL(value.dashboardUrl),identity=new URL(value.identityUrl);
  requireSafe(dashboard.protocol==='https:' && dashboard.origin===value.dashboardUrl && !dashboard.username &&
    identity.origin===value.identityUrl && identity.protocol==='https:' && identity.hostname==='id.'+dashboard.hostname &&
    identity.port===dashboard.port,'CONFIG');
  return {dashboardUrl:dashboard.origin,identityUrl:identity.origin,usernameFile:join(input,'username.txt'),passwordFile:join(input,'password.txt'),
    caFile:join(input,'appliance-ca.pem'),requestTimeoutMs:30_000,loginTimeoutMs:90_000,expected:{role:'magicstick-viewer'},
    applianceUid:value.applianceUid,nodeUids:value.nodeUids};
}

/** No product setters, estimators, key creation, inference or Kubernetes client.
 * Active models are deliberately allowed and are never stopped for these reads. */
export async function observeReadOnlyPhase(api:ReturnType<typeof readOnlyApi>,phase:number,target:{applianceUid:string;nodeUids:string[]}) {
  requireSafe(Number.isInteger(phase)&&phase>=0&&phase<=8,'CONFIG');
  const appliance=await api.appliance();
  requireSafe(appliance.metadata?.uid===target.applianceUid,'IDENTITY');
  if(phase===0||phase===6) {
    const hosts=await api.hostManagement();requireProof(Array.isArray(hosts.nodes),'API');
    requireSafe(target.nodeUids.every(uid=>hosts.nodes.some(node=>node.nodeUid===uid)),'IDENTITY');
  } else if(phase===1||phase===8) {
    const status=await api.status();requireProof(Array.isArray(status.pods)&&Array.isArray(status.services),'API');
    await api.settings();
  } else if(phase===2||phase===3||phase===4) {
    const models=await api.models();requireProof(Array.isArray(models.activations)&&Array.isArray(models.computeTargets?.targets),'API');
    if(phase!==2) {const sharing=await api.gpuSharing();requireProof(Array.isArray(sharing.providers),'API');}
  } else {
    const modules=await api.modules();requireProof(modules.modules&&typeof modules.modules==='object','API');
    if(phase===5) {const instances=await api.instances();requireProof(instances.instances&&typeof instances.instances==='object','API');}
  }
}
