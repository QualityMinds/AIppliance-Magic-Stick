import type {CleanupAdapter, JournalEntry} from './journal.ts';
import {HarnessError, requireSafe} from './errors.ts';
import {KubectlObserver, type KubeObject} from './observer.ts';
import {poll} from './poll.ts';
import {readPrivate} from './private-files.ts';
import {isDeepStrictEqual} from 'node:util';
import {KubernetesCommandError} from './kubernetes-command.ts';
import type {CleanupObservation} from './cleanup-diagnostic.ts';

const resource = 'modelactivations.appliance.magicstick.dev';
const group = 'appliance.magicstick.dev';

/** Only a namespaced ModelActivation DELETE credential; never an admin kubeconfig. */
export class KubernetesModelCleaner extends KubectlObserver {
  readonly namespace: string;
  constructor(kubeconfig: string, namespace: string, timeoutMs = 15_000) {
    super(kubeconfig, timeoutMs);
    this.namespace = namespace;
    requireSafe(namespace === 'ai-system', 'CONFIG');
  }

  async verifyConfiguration() {
    await readPrivate(this.kubeconfig);
    const data = JSON.parse(await this.command(['config', 'view', '--raw', '--minify', '-o', 'json']));
    const cluster = data.clusters?.[0]?.cluster, user = data.users?.[0]?.user;
    requireSafe(cluster && /^https:\/\//.test(cluster.server) && !cluster['insecure-skip-tls-verify'] &&
      user && !user.exec && !user['auth-provider'], 'OBSERVER');
    const review = JSON.parse(await this.command(['create', '--raw', '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews', '-f', '-'],
      JSON.stringify({apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectRulesReview', spec: {namespace: this.namespace}})));
    verifyModelCleanerRules(review);
  }

  async find(name: string): Promise<KubeObject | null> {
    requireSafe(/^[a-z0-9][a-z0-9-]{0,62}$/.test(name), 'OWNERSHIP');
    const matches = (await this.list(resource, this.namespace)).filter(item => item.metadata.name === name);
    requireSafe(matches.length <= 1, 'OWNERSHIP');
    return matches[0] ?? null;
  }

  async remove(name: string, uid: string, generation: number,
    observe?:(value:Omit<CleanupObservation,'at'|'elapsedMs'>)=>Promise<void>,assertHeld:()=>Promise<void>=async()=>{}) {
    let intent:Record<string,unknown>|undefined,previousResourceVersion:string|undefined;
    for(let attempt=1;attempt<=3;attempt++) {
      await assertHeld();
      const current=await this.find(name);
      const uidMatches=current?current.metadata.uid===uid:null;
      const generationMatches=current?current.metadata.generation===generation:null;
      const intentMatches=current&&intent!==undefined?isDeepStrictEqual(current.spec,intent):null;
      await observe?.({operation:'remove',state:'running',method:'DELETE',endpoint:'model-activation',attempt,
        requestAttempted:false,exists:current!==null,uidMatches,generationMatches,intentMatches,
        deleting:!!current?.metadata.deletionTimestamp,expectedGeneration:generation,
        ...(current?.metadata.generation!==undefined?{observedGeneration:current.metadata.generation}:{}),
        ...(previousResourceVersion!==undefined?{resourceVersionChanged:current?current.metadata.resourceVersion!==previousResourceVersion:null}:{})});
      // No new DELETE is needed if the same removal completed meanwhile. The
      // adapter still independently verifies intent, Pods and catalog absence.
      if(!current)return;
      requireSafe(uidMatches&&generationMatches&&current.metadata.name===name&&current.metadata.namespace===this.namespace&&
        current.metadata.resourceVersion&&current.metadata.labels?.['app.kubernetes.io/managed-by']==='ai-appliance-dashboard'&&
        ['local','external'].includes(String(current.spec?.type))&&current.spec?.targetNamespace==='ai','OWNERSHIP');
      requireSafe(intent===undefined||intentMatches,'OWNERSHIP');
      intent??=structuredClone(current.spec!);
      if(current.metadata.deletionTimestamp)return;
      // A stale re-read or an unchanged revision does not explain the conflict
      // and cannot authorize another write. Never drop the RV precondition.
      requireSafe(previousResourceVersion===undefined||current.metadata.resourceVersion!==previousResourceVersion,'CONFLICT');
      await assertHeld();
      const path=`/apis/${group}/v1alpha1/namespaces/${this.namespace}/modelactivations/${name}`;
      const options={apiVersion:'v1',kind:'DeleteOptions',preconditions:{uid,resourceVersion:current.metadata.resourceVersion}};
      await observe?.({operation:'remove',state:'running',method:'DELETE',endpoint:'model-activation',attempt,requestAttempted:true});
      // A diagnostic checkpoint can yield to the heartbeat. Recheck immediately
      // before transport, and correct the pending marker if no request is sent.
      try {await assertHeld();}
      catch(error) {
        await observe?.({operation:'remove',state:'failed',attempt,requestAttempted:false,
          reason:error instanceof HarnessError?error.code:'UNEXPECTED',stage:'cleanup'});
        throw error;
      }
      try {
        await this.command(['delete','--raw',path,'-f','-'],JSON.stringify(options));
        await observe?.({operation:'remove',state:'passed',method:'DELETE',endpoint:'model-activation',attempt,requestAttempted:true});
        return;
      }catch(error) {
        const diagnostic=error instanceof KubernetesCommandError?error.diagnostic:{commandFailure:'unknown' as const,httpStatus:null};
        const conflict=diagnostic.commandFailure==='api'&&diagnostic.httpStatus===409&&diagnostic.kubernetesReason==='Conflict'&&diagnostic.exitCode===1;
        const retrying=conflict&&attempt<3;
        const reason=conflict?'CONFLICT':diagnostic.httpStatus===401||diagnostic.httpStatus===403?'AUTH':
          error instanceof HarnessError?error.causeReason??error.code:'UNEXPECTED';
        // A rejected request is retained as an observation even if a later
        // attempt succeeds; it does not itself fail the completed scenario.
        await observe?.({operation:'remove',state:'failed',method:'DELETE',endpoint:'model-activation',attempt,
          requestAttempted:true,retrying,reason,stage:'cleanup',...diagnostic});
        if(!retrying)throw new HarnessError('CLEANUP','Failed','cleanup',{reason,stage:'cleanup'});
        previousResourceVersion=current.metadata.resourceVersion;
      }
    }
  }

  adapter(prefix: string, readRemaining: (name: string) => Promise<{podCount: number; catalogCount: number}>,
    heartbeat: () => Promise<void> = async () => {},options:{timeoutMs?:number;intervalMs?:number}={}): CleanupAdapter {
    const timeoutMs=options.timeoutMs??300_000;
    requireSafe(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=300_000,'CONFIG');
    return {
      lookup: async (entry,observe) => {
        await heartbeat();
        validateEntry(entry, prefix);
        const item = await this.find(entry.name);
        await observe?.({operation:'lookup',state:'running',exists:item!==null,uidMatches:item?item.metadata.uid===entry.uid:null,
          generationMatches:item?item.metadata.generation===entry.generation:null,deleting:!!item?.metadata.deletionTimestamp,
          ...(entry.generation!==undefined?{expectedGeneration:entry.generation}:{}),
          ...(item?.metadata.generation!==undefined?{observedGeneration:item.metadata.generation}:{})});
        if (item) requireSafe(item.metadata.generation === entry.generation &&
          item.metadata.labels?.['app.kubernetes.io/managed-by'] === 'ai-appliance-dashboard' &&
          ['local', 'external'].includes(String(item.spec?.type)) && item.spec?.targetNamespace === 'ai', 'OWNERSHIP');
        return item?.metadata.uid ? {uid:item.metadata.uid,generation:item.metadata.generation,deleting:!!item.metadata.deletionTimestamp} : null;
      },
      removeIfUid: async (entry, uid,observe) => {
        validateEntry(entry, prefix);
        requireSafe(entry.uid === uid, 'OWNERSHIP');
        await this.remove(entry.name, uid, entry.generation!,observe,heartbeat);
      },
      verifyRemoved: async (entry,observe) => {
        // A conclusively rejected create owns no UID. It is still checked for
        // independent absence, but can never pass the deletion preconditions.
        if(entry.uid===null)requireSafe(entry.kind==='model'&&entry.name.startsWith(prefix)&&entry.state==='removed','OWNERSHIP');
        else validateEntry(entry, prefix);
        await poll(async () => {
          await heartbeat();
          let item:KubeObject|null,remaining:{podCount:number;catalogCount:number};
          try {[item,remaining]=await Promise.all([this.find(entry.name),readRemaining(entry.name)]);}
          catch(error){await observe?.({operation:'verify',state:'failed',exists:null,uidMatches:null,generationMatches:null,podCount:null,catalogCount:null,
            reason:error instanceof HarnessError?error.code:'UNEXPECTED',stage:'cleanup',timeoutMs});throw error;}
          await observe?.({operation:'verify',state:'running',exists:item!==null,uidMatches:item?item.metadata.uid===entry.uid:null,
            generationMatches:item?item.metadata.generation===entry.generation:null,deleting:!!item?.metadata.deletionTimestamp,
            ...(entry.generation!==undefined?{expectedGeneration:entry.generation}:{}),
            ...(item?.metadata.generation!==undefined?{observedGeneration:item.metadata.generation}:{}),
            podCount:remaining.podCount,catalogCount:remaining.catalogCount,timeoutMs});
          return {item, remaining};
        }, result => result.item === null && result.remaining.podCount === 0 && result.remaining.catalogCount === 0,
        {timeoutMs, intervalMs:options.intervalMs??1000, stage: 'cleanup'});
        return true;
      },
    };
  }
}

function validateEntry(entry: JournalEntry, prefix: string) {
  requireSafe(entry.kind === 'model' && entry.name.startsWith(prefix) && entry.uid &&
    Number.isSafeInteger(entry.generation) && Number(entry.generation) > 0, 'OWNERSHIP');
}

export function verifyModelCleanerRules(review: {status?: {incomplete?: boolean; resourceRules?: Array<{
  apiGroups: string[]; resources: string[]; verbs: string[]}>; nonResourceRules?: Array<{verbs: string[]}>}}) {
  requireSafe(review.status?.incomplete === false && Array.isArray(review.status.resourceRules), 'OBSERVER');
  let modelDelete = false;
  for (const rule of review.status.resourceRules) {
    requireSafe(Array.isArray(rule.apiGroups) && Array.isArray(rule.resources) && Array.isArray(rule.verbs), 'OBSERVER');
    const model = rule.apiGroups.length === 1 && rule.apiGroups[0] === group &&
      rule.resources.length === 1 && rule.resources[0] === 'modelactivations';
    const selfReview = rule.apiGroups.every(value => ['authorization.k8s.io', 'authentication.k8s.io'].includes(value)) &&
      rule.resources.every(value => ['selfsubjectaccessreviews', 'selfsubjectrulesreviews', 'selfsubjectreviews'].includes(value));
    requireSafe((model && rule.verbs.every(value => ['get', 'list', 'delete'].includes(value))) ||
      (selfReview && rule.verbs.every(value => value === 'create')), 'OBSERVER');
    if (model && rule.verbs.some(value => String(value) === 'delete')) modelDelete = true;
  }
  requireSafe(modelDelete && (review.status.nonResourceRules ?? []).every(rule =>
    Array.isArray(rule.verbs) && rule.verbs.every(value => value === 'get')), 'OBSERVER');
}
