import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {readPrivate,writePrivate} from './private-files.ts';
import {HarnessError,requireSafe} from './errors.ts';
import type {RecoveryIdentity} from './recovery-inventory.ts';
import type {KubeObject} from './observer.ts';

const owner='regression.magicstick.dev/run-uid',namespace='magicstick-regression';
const hash=(body:string)=>createHash('sha256').update(body).digest('hex');
const terminal=['Passed','Failed','Blocked','Cancelled'];
interface Reader {
  get(resource:string,namespace:string,name:string):Promise<KubeObject>;
  list(resource:string,namespace:string):Promise<KubeObject[]>;
}
export async function verifiedKubernetesTermination(directory:string,runId:string,identity:RecoveryIdentity) {
  try {
    const proof=JSON.parse(await readPrivate(join(directory,'runner-termination.json')));
    const session=await readPrivate(join(directory,'runner-session.json'));
    return proof.version===1&&proof.kind==='kubernetes-termination'&&proof.runId===runId&&proof.targetUid===identity.applianceUid&&
      Array.isArray(proof.nodeUids)&&JSON.stringify([...proof.nodeUids].sort())===JSON.stringify([...identity.nodeUids].sort())&&
      /^[a-f0-9-]{36}$/.test(proof.runtimeRunUid)&&typeof proof.jobUid==='string'&&proof.jobUid.length>0&&
      typeof proof.podUid==='string'&&proof.podUid.length>0&&typeof proof.containerId==='string'&&proof.containerId.length>0&&
      Number.isFinite(Date.parse(proof.finishedAt))&&Number.isFinite(Date.parse(proof.checkedAt))&&proof.sessionHash===hash(session);
  }catch{return false;}
}

/** Reconcile only the retained account's exact old Kubernetes execution. This
 * is termination evidence, not cleanup, and never edits the old session/report,
 * Lease, Pod or Job. A missing Pod or ownership mismatch stays fenced. */
export async function attestKubernetesTermination(options:{root:string;reports:string;runId:string;runtimeRunUid:string;
  accountRunUid:string;currentRunUid:string;identity:RecoveryIdentity;reader:Reader}) {
  const {root,reports,runId,runtimeRunUid,accountRunUid,currentRunUid,identity,reader}=options;
  requireSafe(/^reg-[a-f0-9-]{36}$/.test(runId)&&/^[a-f0-9-]{36}$/.test(runtimeRunUid)&&
    /^[a-f0-9-]{36}$/.test(accountRunUid)&&runtimeRunUid!==currentRunUid,'RECOVERY');
  const directory=join(root,runId),session=await readPrivate(join(directory,'runner-session.json'));
  const value=JSON.parse(session);
  requireSafe(value.version===1&&value.runId===runId&&value.targetUid===identity.applianceUid,'RECOVERY');
  const status=JSON.parse(await readPrivate(join(reports,runtimeRunUid,'status.json'),8*1024*1024));
  requireSafe(status.version===1&&status.runUid===runtimeRunUid&&Array.isArray(status.progress?.ownedRunIds)&&
    status.progress.ownedRunIds.length<=1000&&status.progress.ownedRunIds.includes(runId),'OWNERSHIP');
  const runs=(await reader.list('regressionruns.appliance.magicstick.dev','ai-system')).filter(run=>run.metadata.uid===runtimeRunUid);
  requireSafe(runs.length===1,'OWNERSHIP');const run=runs[0]!;
  requireSafe(run.metadata.name&&run.metadata.namespace==='ai-system'&&run.metadata.resourceVersion&&run.spec?.applianceUid===identity.applianceUid&&
    terminal.includes(run.status?.phase??''),'PROCESS_STATE');
  requireSafe((run.spec.accountRunUid??runtimeRunUid)===accountRunUid&&Array.isArray(run.spec.nodeUids)&&
    JSON.stringify([...run.spec.nodeUids].sort())===JSON.stringify([...identity.nodeUids].sort()),'OWNERSHIP');
  const job=await reader.get('jobs.batch',namespace,run.metadata.name);
  requireSafe(job.metadata.uid&&job.metadata.namespace===namespace&&job.metadata.resourceVersion&&
    job.metadata.labels?.[owner]===runtimeRunUid&&(!job.status?.active||job.status.active===0),'OWNERSHIP');
  const pods=(await reader.list('pods',namespace)).filter(pod=>pod.metadata.labels?.[owner]===runtimeRunUid);
  requireSafe(pods.length===1,'PROCESS_STATE');const pod=pods[0]!;
  requireSafe(pod.metadata.uid&&pod.metadata.name&&pod.metadata.namespace===namespace&&pod.metadata.resourceVersion&&
    pod.metadata.ownerReferences?.some(ref=>ref.kind==='Job'&&ref.uid===job.metadata.uid&&ref.controller===true),'OWNERSHIP');
  const spec=pod.spec as Record<string,any>|undefined,containers=pod.status?.containerStatuses,container=containers?.[0],ended=container?.state?.terminated;
  const nodes=await reader.list('nodes','');
  requireSafe(nodes.some(node=>node.metadata.name===spec?.nodeName&&identity.nodeUids.includes(node.metadata.uid??'')),'IDENTITY');
  requireSafe(spec&&spec.hostPID!==true&&spec.shareProcessNamespace!==true&&spec.securityContext?.runAsNonRoot===true&&
    Array.isArray(spec.containers)&&spec.containers.length===1&&spec.containers[0]?.name==='runner'&&
    typeof run.spec?.image==='string'&&/@sha256:[a-f0-9]{64}$/.test(run.spec.image)&&spec.containers[0]?.image===run.spec.image&&
    spec.containers[0]?.securityContext?.allowPrivilegeEscalation===false&&
    spec.containers[0]?.securityContext?.privileged!==true&&!(spec.containers[0]?.securityContext?.capabilities?.add??[]).length&&
    spec.containers[0]?.securityContext?.capabilities?.drop?.includes('ALL')&&
    !(spec.volumes??[]).some((volume:any)=>volume.hostPath)&&!(spec.initContainers??[]).length&&!(spec.ephemeralContainers??[]).length&&
    ['Succeeded','Failed'].includes(pod.status?.phase??'')&&containers?.length===1&&container?.name==='runner'&&
    !container.state?.running&&!container.state?.waiting&&Number.isInteger(ended?.exitCode)&&
    /^[a-z][a-z0-9-]*:\/\/[a-zA-Z0-9_.-]{1,256}$/.test(container.containerID??'')&&
    Number.isFinite(Date.parse(ended?.finishedAt??''))&&Date.parse(ended!.finishedAt!)<=Date.now()&&
    Number.isFinite(Date.parse(value.updatedAt))&&Date.parse(value.updatedAt)<=Date.parse(ended!.finishedAt!),'PROCESS_STATE');
  // Repeat the exact reads, so a replaced Pod, Job, run or changing session
  // cannot turn a stale observation into a private termination attestation.
  const [again,jobAgain,runAgain]=await Promise.all([reader.get('pods',namespace,pod.metadata.name),
    reader.get('jobs.batch',namespace,run.metadata.name),reader.get('regressionruns.appliance.magicstick.dev','ai-system',run.metadata.name)]);
  requireSafe(again.metadata.uid===pod.metadata.uid&&again.metadata.resourceVersion===pod.metadata.resourceVersion&&
    jobAgain.metadata.uid===job.metadata.uid&&jobAgain.metadata.resourceVersion===job.metadata.resourceVersion&&
    runAgain.metadata.uid===runtimeRunUid&&runAgain.metadata.resourceVersion===run.metadata.resourceVersion&&
    JSON.stringify(again.status?.containerStatuses)===JSON.stringify(containers)&&
    await readPrivate(join(directory,'runner-session.json'))===session,'CONFLICT');
  await writePrivate(join(directory,'runner-termination.json'),{version:1,kind:'kubernetes-termination',runId,targetUid:identity.applianceUid,
    nodeUids:identity.nodeUids,runtimeRunUid,accountRunUid,jobUid:job.metadata.uid,podUid:pod.metadata.uid,containerId:container!.containerID,
    finishedAt:ended!.finishedAt,checkedAt:new Date().toISOString(),sessionHash:hash(session)});
}

/** The bootstrap already verified lab/node identity and owns a transient admin
 * context. Use it only for fixed read operations; no new service-account rights. */
export async function reconcileKubernetesSession(options:{root:string;runId:string;identity:RecoveryIdentity;
  runtimeRunUid?:string;reports?:string;env:Record<string,string|undefined>;command:(args:string[])=>Promise<any>}) {
  if(options.env.REGRESSION_EXECUTION!=='kubernetes')return;
  const session=JSON.parse(await readPrivate(join(options.root,options.runId,'runner-session.json')));
  if(session.state==='finished'&&session.processesStopped!==false)return;
  await attestKubernetesTermination({...options,reports:options.reports??'/state/reports',
    runtimeRunUid:options.runtimeRunUid??options.env.REGRESSION_ACCOUNT_RUN_UID??'',
    accountRunUid:options.env.REGRESSION_ACCOUNT_RUN_UID??options.env.REGRESSION_RUN_UID??'',currentRunUid:options.env.REGRESSION_RUN_UID??'',
    reader:{get:(resource,ns,name)=>options.command(['get',resource,name,...(ns?['-n',ns]:[]),'-o','json']),
      list:async(resource,ns)=>(await options.command(['get',resource,...(ns?['-n',ns]:[]),'-o','json'])).items}});
  if(!await verifiedKubernetesTermination(join(options.root,options.runId),options.runId,options.identity))throw new HarnessError('PROCESS_STATE');
}
