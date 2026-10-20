import {test, type Browser, type BrowserContext} from '@playwright/test';
import type {LiveFoundation} from '../core/live-foundation.ts';
import {OwnedIdentityClient} from '../core/owned-identity.ts';
import {AdministrationRejected} from '../core/administration-api.ts';
import {realLogin} from '../core/auth.ts';
import {readPrivate, writePrivate, journalFile} from '../core/private-files.ts';
import {parseKubeconfig, executeOidc, identityKubeRequest, type OidcConfig} from '../core/oidc-exec.ts';
import {atStage, requireProof as requireSafe} from '../core/errors.ts';
import {poll} from '../core/poll.ts';
import {withCleanup} from '../core/run-lifecycle.ts';
import {canonical} from '../core/borrowed-sharing.ts';
import {verifyRevokedAccessUi, verifyKubeconfigExport} from './kubeconfig-export.cases.ts';

type KubernetesCase = 'K8S-02' | 'K8S-03' | 'K8S-04' | 'K8S-05' | 'K8S-06';
type AccessLevel = 'none' | 'viewer' | 'operator' | 'admin';
type Plugin = Parameters<typeof executeOidc>[3];
/** Only isolated owning tests replace these ports. Installed cases always use
 * the normal scoped API, real SSO/exec plugin and verified Kubernetes client. */
export interface KubernetesRuntime {
  identities: (live: LiveFoundation) => Pick<OwnedIdentityClient, 'client' | 'create' | 'current' | 'enabled'>;
  login: typeof realLogin;
  authorize: typeof executeOidc;
  request: typeof identityKubeRequest;
  exportUi: typeof verifyKubeconfigExport;
  revokedUi: typeof verifyRevokedAccessUi;
}
const runtimeDefaults: KubernetesRuntime = {identities: live => new OwnedIdentityClient(live),
  login: realLogin, authorize: executeOidc, request: identityKubeRequest, exportUi: verifyKubeconfigExport, revokedUi: verifyRevokedAccessUi};

// Kubernetes may add schema defaults. Pin the acknowledged saved spec, while
// requiring every submitted field to survive; defaults are not foreign edits.
function containsIntent(value: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== 'object') return value === expected;
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(expected).every(([key, item]) => containsIntent((value as Record<string, unknown>)[key], item)));
}

/** CRUD only disabled run-owned intents, never workloads or Secrets. Retain
 * acknowledgement before assertions, and delete with UID/generation/spec and
 * resource-version checks. Ambiguous creates remain fenced, not adopted. */
async function operatorCrud(live: LiveFoundation, runtime: KubernetesRuntime, oidc: OidcConfig, token: string) {
  const resources = [
    ['ModuleActivation', 'moduleactivations', {module: live.journal.prefix + 'unknown', enabled: false}],
    ['AppInstance', 'appinstances', {application: live.journal.prefix + 'unknown', enabled: false, targetNamespace: 'ai'}],
    ['ModelActivation', 'modelactivations', {type: 'local', enabled: false, targetNamespace: 'ai',
      local: {engine: 'OLlama', url: 'ollama://disabled-fixture', computeTarget: 'cpu'}}],
  ] as const;
  for (const [kind, plural, spec] of resources) {
    const name = live.journal.prefix + 'kube-' + plural.slice(0, 5);
    const path = '/apis/appliance.magicstick.dev/v1alpha1/namespaces/ai-system/' + plural;
    const receipt = journalFile(live.journal, 'kube-' + plural + '.json');
    requireSafe((await runtime.request(oidc, token, path + '/' + name)).status === 404, 'OWNERSHIP');
    let submitted = false, uid: string | undefined, generation: number | undefined, confirmedSpec: Record<string, unknown> | undefined;
    const record = (state: string) => writePrivate(receipt, {version: 1, kind, namespace: 'ai-system', name,
      ...(uid ? {uid, generation} : {}), state});
    const restore = async () => {
      await live.guard();
      const current = await runtime.request(oidc, token, path + '/' + name);
      if (current.status === 404) {
        requireSafe(!submitted || uid, 'CLEANUP'); await record('removed'); return;
      }
      requireSafe(current.status === 200 && uid && current.value.metadata?.uid === uid &&
        current.value.metadata.generation === generation && current.value.metadata.resourceVersion &&
        current.value.metadata.labels?.['regression.magicstick.dev/run'] === live.journal.runId &&
        confirmedSpec?.enabled === false && canonical(current.value.spec) === canonical(confirmedSpec), 'OWNERSHIP');
      await live.guard();
      const removed = await runtime.request(oidc, token, path + '/' + name, {apiVersion: 'v1', kind: 'DeleteOptions',
        preconditions: {uid, resourceVersion: current.value.metadata.resourceVersion}}, 'DELETE');
      requireSafe([200, 202].includes(removed.status), 'CLEANUP');
      await poll(() => runtime.request(oidc, token, path + '/' + name), value => value.status === 404,
        {timeoutMs: 30_000, intervalMs: 500, stage: 'cleanup'});
      await record('removed');
    };
    await writePrivate(receipt, {version: 1, kind, namespace: 'ai-system', name, state: 'requested'}, true);
    const unregister = live.registerRestoration(restore);
    await withCleanup(async () => {
      await live.guard(); submitted = true;
      const result = await runtime.request(oidc, token, path, {apiVersion: 'appliance.magicstick.dev/v1alpha1', kind,
        metadata: {name, labels: {'regression.magicstick.dev/run': live.journal.runId}}, spec}, 'POST');
      if (typeof result.value.metadata?.uid === 'string') {
        uid = result.value.metadata.uid; generation = result.value.metadata.generation; confirmedSpec = result.value.spec;
        await record('owned');
      }
      requireSafe(result.status === 201 && uid && Number.isSafeInteger(generation) && Number(generation) > 0 &&
        containsIntent(result.value.spec, spec), 'API');
      const get = await runtime.request(oidc, token, path + '/' + name);
      requireSafe(get.status === 200 && get.value.metadata?.uid === uid &&
        get.value.metadata.generation === generation && canonical(get.value.spec) === canonical(confirmedSpec), 'OWNERSHIP');
      await live.guard();
      const update = await runtime.request(oidc, token, path + '/' + name, {...get.value,
        metadata: {...get.value.metadata, annotations: {...get.value.metadata.annotations, 'regression.magicstick.dev/update': 'verified'}}}, 'PUT');
      requireSafe(update.status === 200 && update.value.metadata?.uid === uid &&
        update.value.metadata.generation === generation && canonical(update.value.spec) === canonical(confirmedSpec), 'API');
    }, () => test.step('Remove the exact disabled Kubernetes intent and retain any cleanup fence', async () => {
      await atStage('cleanup', restore); unregister();
    }));
  }
}

/** Each catalogue case has its own user and cleanup. An export/UI failure must
 * not rerun the Viewer loop as Operator/Admin/revocation evidence. */
export async function kubernetesWorkflow(live: LiveFoundation, browser: Browser, id: string,
  runtime: KubernetesRuntime = runtimeDefaults): Promise<void> {
  requireSafe(['K8S-02', 'K8S-03', 'K8S-04', 'K8S-05', 'K8S-06'].includes(id), 'CONFIG');
  const selected = id as KubernetesCase;
  const profile = JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!));
  requireSafe(profile.identity?.approveDisposableUsers === true, 'PREREQUISITE');
  // Export does not need an exec plugin or permission to grant cluster-admin.
  if (selected !== 'K8S-05') requireSafe(profile.kubernetes?.plugin, 'PREREQUISITE');
  if (selected === 'K8S-04') requireSafe(profile.kubernetes.approveAdminGrant === true, 'PREREQUISITE');
  const users = runtime.identities(live), api = users.client;
  const created = await users.create('kube-' + selected.toLowerCase(), 'viewer');
  const contexts = new Set<BrowserContext>();
  let initialized = false;
  const grant = async (level: AccessLevel) => {
    await users.current(created.user);
    const result = await api.write({method: 'PUT', path: `/api/kubernetes-access/${created.user.id}`, body: {accessLevel: level}},
      () => api.api.updateKubernetesAccess(created.user.id, level));
    requireSafe(result && typeof result === 'object' && (result as {id?: unknown}).id === created.user.id &&
      (result as {accessLevel?: unknown}).accessLevel === level, 'API');
  };
  const currentLevel = async (level: AccessLevel) => {
    const matches = (await api.api.kubernetesAccess(created.user.username)).users.filter(user => user.id === created.user.id);
    requireSafe(matches.length === 1 && matches[0]!.accessLevel === level, 'API');
  };
  const login = async () => {
    const context = await runtime.login(browser, live.config, {actor: {username: created.user.username,
      subject: created.user.id, role: 'magicstick-viewer', password: created.password,
      ...(!initialized ? {initialPassword: created.initialPassword} : {})}});
    initialized = true; contexts.add(context); return context;
  };
  const session = async (level: Exclude<AccessLevel, 'none'>) => {
    await grant(level); await currentLevel(level);
    const context = await login();
    const exported = await atStage('kubeconfig-export', async () => {
      const result = await api.api.kubeconfig(created.user.id);
      requireSafe(result.accessLevel === level, 'API'); return result;
    });
    const oidc = await atStage('kubeconfig-export', async () => parseKubeconfig(exported.content, live.config.identityUrl));
    const token = await runtime.authorize(context, live.config, oidc, profile.kubernetes.plugin as Plugin);
    const access = async (group: string, resource: string, verb: string, namespace?: string) => {
      const result = await runtime.request(oidc, token, '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews',
        {apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview',
          spec: {resourceAttributes: {group, resource, verb, ...(namespace ? {namespace} : {})}}}, 'POST');
      requireSafe(result.status === 201 && typeof result.value.status?.allowed === 'boolean', 'API');
      return result.value.status.allowed as boolean;
    };
    const pods = await runtime.request(oidc, token, '/api/v1/namespaces/ai/pods');
    requireSafe(pods.status === 200 && pods.value.kind === 'PodList', 'API');
    if (level !== 'admin') {
      for (const [group, resource, verb, namespace] of [['', 'secrets', 'get', 'ai'], ['', 'pods', 'create', 'ai'],
        ['apps', 'deployments', 'create', 'ai'], ['appliance.magicstick.dev', 'modelactivations', 'create', 'default']])
        requireSafe(!await access(group!, resource!, verb!, namespace), 'API');
    }
    return {context, oidc, token, access};
  };
  await withCleanup(() => atStage('kubernetes-access', async () => {
    if (selected === 'K8S-02') {
      const viewer = await session('viewer');
      for (const resource of ['moduleactivations', 'modelactivations', 'appinstances'])
        requireSafe(!await viewer.access('appliance.magicstick.dev', resource, 'create', 'ai-system'), 'API');
    } else if (selected === 'K8S-03') {
      const operator = await session('operator');
      for (const resource of ['moduleactivations', 'modelactivations', 'appinstances'])
        for (const verb of ['get', 'list', 'create', 'update', 'patch', 'delete'])
          requireSafe(await operator.access('appliance.magicstick.dev', resource, verb, 'ai-system'), 'API');
      await operatorCrud(live, runtime, operator.oidc, operator.token);
    } else if (selected === 'K8S-04') {
      const admin = await session('admin');
      requireSafe(await admin.access('', 'secrets', 'get', 'ai') &&
        await admin.access('rbac.authorization.k8s.io', 'clusterroles', 'create'), 'API');
      // Revoke before optional UI checks or later work, not just afterAll.
      await grant('none'); await currentLevel('none');
    } else if (selected === 'K8S-05') {
      await grant('viewer');
      const exported = await atStage('kubeconfig-export', () => api.api.kubeconfig(created.user.id));
      requireSafe(exported.accessLevel === 'viewer', 'API');
      const context = await runtime.login(browser, live.config, {allowPrivateDownloads: true}); contexts.add(context);
      await runtime.exportUi(context, {origin: live.config.dashboardUrl, identityOrigin: live.config.identityUrl,
        username: created.user.username, userId: created.user.id, expected: exported, timeoutMs: live.config.requestTimeoutMs});
    } else {
      let oidc: OidcConfig | undefined;
      for (const level of ['viewer', 'operator', 'viewer'] as const) {
        const actor = await session(level); oidc = actor.oidc;
        requireSafe(await actor.access('appliance.magicstick.dev', 'modelactivations', 'create', 'ai-system') === (level === 'operator'), 'API');
        await actor.context.close(); contexts.delete(actor.context);
      }
      await atStage('kubernetes-revoke', async () => {
        await grant('none'); await currentLevel('none'); requireSafe(oidc, 'API');
        // Changing groups deliberately logs out the user. Establish a fresh
        // ordinary Dashboard/IdP session before requesting a fresh OIDC token.
        const freshContext = await login();
        const token = await runtime.authorize(freshContext, live.config, oidc, profile.kubernetes.plugin as Plugin);
        requireSafe([401, 403].includes((await runtime.request(oidc, token, '/api/v1/namespaces/ai/pods')).status), 'API');
        await runtime.revokedUi(live.context, live.config.dashboardUrl, created.user.username, live.config.requestTimeoutMs);
        await users.enabled(created.user, false);
        let refused = false;
        try { await grant('viewer'); }
        catch (error) { if (!(error instanceof AdministrationRejected) || error.status !== 409) throw error; refused = true; }
        requireSafe(refused, 'API'); await currentLevel('none');
      });
    }
  }), () => test.step('Revoke Kubernetes test access and remove only the owned identity', () => atStage('cleanup', async () => {
    await withCleanup(async () => {
      for (const context of contexts) await context.close();
      await grant('none'); await currentLevel('none');
    }, () => live.cleanup(live.journal, {kind: 'identity', name: created.user.username}));
  })));
}
