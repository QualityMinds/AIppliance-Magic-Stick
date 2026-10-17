import {test, expect, type Browser, type BrowserContext} from '@playwright/test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {User} from '@magicstick/dashboard-contracts';
import {kubernetesWorkflow, type KubernetesRuntime} from './kubernetes-live.ts';
import {assertCurrentKubeconfig} from './kubeconfig-export.cases.ts';
import {syntheticKubeconfig, kubernetesIdentityOrigin} from '../fixtures/kubernetes.ts';
import type {LiveFoundation} from '../core/live-foundation.ts';
import {AdministrationRejected} from '../core/administration-api.ts';
import {HarnessError} from '../core/errors.ts';
import {ResourceJournal, newRunId} from '../core/journal.ts';
import {readPrivate, writePrivate} from '../core/private-files.ts';
import {evidenceAnnotations} from '../core/evidence.ts';

const annotation = evidenceAnnotations({id: 'HAR-10', layer: 'U'});
async function fixture(action: (f: Awaited<ReturnType<typeof buildFixture>>) => Promise<void>, profile?: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'kubernetes-case-')), previous = process.env.REGRESSION_REMAINING_PROFILE;
  try {
    const filename = join(directory, 'profile.json');
    await writePrivate(filename, profile ?? {version: 1, identity: {approveDisposableUsers: true},
      kubernetes: {approveAdminGrant: true, plugin: {filename: '/inputs/kubectl-oidc_login', sha256: 'a'.repeat(64)}}});
    process.env.REGRESSION_REMAINING_PROFILE = filename;
    await action(await buildFixture(directory));
  } finally {
    if (previous === undefined) delete process.env.REGRESSION_REMAINING_PROFILE; else process.env.REGRESSION_REMAINING_PROFILE = previous;
    await rm(directory, {recursive: true, force: true});
  }
}
async function buildFixture(directory: string) {
  const journal = await ResourceJournal.create(join(directory, 'journal.json'), newRunId(), 'fixture-appliance');
  let level = 'none', epoch = 0, enabled = true, user: User, nextUid = 0;
  const state = {grants: [] as string[], logins: [] as Array<{level: string; initial: boolean; downloads: boolean}>,
    oidc: [] as string[], exports: 0, removed: [] as string[], restored: [] as string[], revokedUi: 0,
    exportFailure: false, cleanupFailure: false, replaceUid: false, apiFailure: false};
  const contexts = new Map<BrowserContext, {epoch: number; level: string; closed: boolean}>();
  const tokens = new Map<string, string>(), resources = new Map<string, Record<string, any>>();
  const restorations = new Set<() => Promise<void>>();
  const api = {
    updateKubernetesAccess: async (_id: string, next: string) => {
      if (next !== 'none' && !enabled) throw new AdministrationRejected(state.apiFailure ? 503 : 409);
      state.grants.push(next); level = next; epoch++; return {id: user.id, accessLevel: level};
    },
    kubernetesAccess: async () => ({users: [{...user, enabled, accessLevel: level}]}),
    kubeconfig: async () => ({filename: 'fixture.kubeconfig', content: syntheticKubeconfig(user.username), accessLevel: level}),
  };
  const live = {journal, context: {} as BrowserContext, config: {dashboardUrl: 'https://dashboard.example.local',
    identityUrl: kubernetesIdentityOrigin, requestTimeoutMs: 1000}, guard: async () => {},
    registerRestoration: (restore: () => Promise<void>) => {restorations.add(restore); return () => {restorations.delete(restore);};},
    cleanup: async (_journal: unknown, only: {kind: string; name: string}) => {
      if (state.cleanupFailure) throw new HarnessError('CLEANUP', 'Failed', 'cleanup');
      expect(only).toEqual({kind: 'identity', name: user.username}); state.removed.push(user.id);
    }} as unknown as LiveFoundation;
  const runtime: KubernetesRuntime = {
    identities: () => ({
      create: async (suffix, role) => {
        expect(role).toBe('viewer'); user = {id: 'fixture-user-id', username: journal.prefix + suffix, enabled: true, source: 'local'} as User;
        return {user, initialPassword: 'synthetic-initial', password: 'synthetic-current'};
      },
      current: async target => {expect(target.id).toBe(user.id); return {...user, enabled};},
      enabled: async (_target, value) => {enabled = value; return {...user, enabled};},
      client: {api, write: async (_permit: unknown, perform: () => Promise<unknown>) => perform()} as unknown as ReturnType<KubernetesRuntime['identities']>['client'],
    }),
    login: async (_browser, _config, options) => {
      state.logins.push({level, initial: Boolean(options?.actor?.initialPassword), downloads: options?.allowPrivateDownloads === true});
      const context = {close: async () => {contexts.get(context)!.closed = true;}} as unknown as BrowserContext;
      contexts.set(context, {epoch, level, closed: false}); return context;
    },
    authorize: async context => {
      const session = contexts.get(context)!;
      // A grant/revoke logs out the old session. A cached old context cannot
      // produce evidence of a fresh token with the new group membership.
      if (session.epoch !== epoch || session.closed) throw new HarnessError('AUTH');
      state.oidc.push(session.level); const token = 'synthetic-token-' + tokens.size;
      tokens.set(token, session.level); return token;
    },
    request: async (_oidc, token, path, body, method = 'GET') => {
      const tokenLevel = tokens.get(token);
      if (path.endsWith('/selfsubjectaccessreviews')) {
        const r = (body as any).spec.resourceAttributes;
        const allowed = tokenLevel === 'admin' || tokenLevel === 'operator' && r.group === 'appliance.magicstick.dev' && r.namespace === 'ai-system';
        return {status: 201, value: {status: {allowed}}};
      }
      if (path.endsWith('/pods')) return {status: tokenLevel === 'none' ? 403 : 200, value: {kind: 'PodList'}};
      if (method === 'POST') {
        const input = structuredClone(body) as Record<string, any>, key = path + '/' + input.metadata.name;
        expect(input.spec.enabled).toBe(false);
        const value = {...input, metadata: {...input.metadata, uid: 'fixture-intent-' + nextUid++, generation: 1, resourceVersion: '1'},
          spec: {...input.spec, schemaDefault: true}};
        resources.set(key, value); return {status: 201, value: structuredClone(value)};
      }
      const value = resources.get(path);
      if (!value) return {status: 404, value: {}};
      if (method === 'PUT') {
        const updated = structuredClone(body) as Record<string, any>; updated.metadata.resourceVersion = '2';
        if (state.replaceUid) updated.metadata.uid = 'foreign-replacement';
        resources.set(path, updated); return {status: 200, value: structuredClone(updated)};
      }
      if (method === 'DELETE') {
        expect((body as any).preconditions).toEqual({uid: value.metadata.uid, resourceVersion: value.metadata.resourceVersion});
        expect(value.metadata.uid).not.toBe('foreign-replacement');
        resources.delete(path); state.restored.push(value.metadata.uid); return {status: 200, value: {}};
      }
      return {status: 200, value: structuredClone(value)};
    },
    exportUi: async () => {state.exports++; if (state.exportFailure) throw new HarnessError('API', 'Failed', 'kubeconfig-copy');},
    revokedUi: async () => {state.revokedUi++; expect(level).toBe('none');},
  };
  return {live, runtime, state, resources, contexts, restorations, directory,
    run: (id: string) => kubernetesWorkflow(live, {} as Browser, id, runtime)};
}

test('K8S-02 K8S-03 K8S-04 independent role cases never enter the clipboard or export workflow', annotation, async () => {
  for (const [id, role] of [['K8S-02', 'viewer'], ['K8S-03', 'operator'], ['K8S-04', 'admin']]) await fixture(async f => {
    f.state.exportFailure = true;
    await f.run(id!);
    expect(f.state.oidc).toEqual([role]); expect(f.state.exports).toBe(0);
    expect(f.state.grants[0]).toBe(role); expect(f.state.grants.at(-1)).toBe('none');
    expect(f.state.removed).toEqual(['fixture-user-id']);
    expect([...f.contexts.values()].every(value => value.closed)).toBe(true);
    expect(f.resources.size).toBe(0); expect(f.restorations.size).toBe(0);
    if (id === 'K8S-03') {
      expect(f.state.restored).toHaveLength(3);
      for (const plural of ['moduleactivations', 'modelactivations', 'appinstances'])
        expect(JSON.parse(await readPrivate(join(f.directory, 'kube-' + plural + '.json'))).state).toBe('removed');
    }
  });
});

test('K8S-05 export needs neither the exec plugin nor an administrator grant and cleans up after copy failure', annotation, async () => {
  await fixture(async f => {
    f.state.exportFailure = true;
    await expect(f.run('K8S-05')).rejects.toMatchObject({code: 'API', stage: 'kubeconfig-copy'});
    expect(f.state.oidc).toEqual([]); expect(f.state.logins).toEqual([{level: 'viewer', initial: false, downloads: true}]);
    expect(f.state.grants).toEqual(['viewer', 'none']); expect(f.state.removed).toEqual(['fixture-user-id']);
  }, {identity: {approveDisposableUsers: true}});
});

test('K8S-06 every access transition uses a fresh current-password login before fresh OIDC denial', annotation, async () => fixture(async f => {
  await f.run('K8S-06');
  expect(f.state.oidc).toEqual(['viewer', 'operator', 'viewer', 'none']);
  expect(f.state.logins.map(value => value.initial)).toEqual([true, false, false, false]);
  expect(f.state.revokedUi).toBe(1); expect(f.state.exports).toBe(0);
  expect(f.state.grants).toEqual(['viewer', 'operator', 'viewer', 'none', 'none']);
  expect(f.state.removed).toEqual(['fixture-user-id']);
}));

test('K8S-05 a copy failure cannot prevent an independent later Viewer test', annotation, async () => fixture(async f => {
  f.state.exportFailure=true;
  await expect(f.run('K8S-05')).rejects.toMatchObject({stage:'kubeconfig-copy'});
  await f.run('K8S-02');expect(f.state.oidc).toEqual(['viewer']);
  expect(f.state.removed).toHaveLength(2);
}));

test('K8S-05 cleanup failure is retained without replacing the original copy failure', annotation, async () => fixture(async f => {
  f.state.exportFailure=true;f.state.cleanupFailure=true;
  await expect(f.run('K8S-05')).rejects.toMatchObject({code:'API',stage:'kubeconfig-copy'});
  expect(f.state.removed).toEqual([]);
  f.state.cleanupFailure=false;
  const name=f.state.logins.length?f.live.journal.prefix+'kube-k8s-05':'';
  await f.live.cleanup(f.live.journal,{kind:'identity',name});expect(f.state.removed).toHaveLength(1);
}));

test('K8S-06 an unavailable API is not mistaken for the expected disabled-user rejection', annotation, async () => fixture(async f => {
  f.state.apiFailure = true;
  await expect(f.run('K8S-06')).rejects.toMatchObject({code: 'API', stage: 'kubernetes-revoke'});
  expect(f.state.removed).toEqual(['fixture-user-id']);
}));

test('K8S-04 refuses an unapproved administrator grant before creating any test identity', annotation, async () => {
  await fixture(async f => {
    await expect(f.run('K8S-04')).rejects.toMatchObject({code: 'PREREQUISITE', outcome: 'Blocked'});
    expect(f.state.grants).toEqual([]); expect(f.state.removed).toEqual([]);
    await f.run('K8S-02'); expect(f.state.oidc).toEqual(['viewer']);
  }, {identity: {approveDisposableUsers: true}, kubernetes: {plugin: {}, approveAdminGrant: false}});
});

test('K8S-03 a replacement UID is never deleted and its unremoved receipt stays fenced', annotation, async () => fixture(async f => {
  f.state.replaceUid = true;
  await expect(f.run('K8S-03')).rejects.toMatchObject({outcome: 'Failed'});
  expect(f.state.restored).toEqual([]); expect(f.resources.size).toBe(1); expect(f.restorations.size).toBe(1);
  expect(JSON.parse(await readPrivate(join(f.directory, 'kube-moduleactivations.json'))).state).toBe('owned');
}));

test('K8S-05 whole-export equality rejects another user for the same cluster without leaking the text', annotation, () => {
  const current = syntheticKubeconfig('current-user'), stale = syntheticKubeconfig('other-user');
  expect(() => assertCurrentKubeconfig(current, current, kubernetesIdentityOrigin)).not.toThrow();
  for (const content of ['', stale, 'x'.repeat(70 * 1024)]) {
    let error: unknown; try {assertCurrentKubeconfig(content, current, kubernetesIdentityOrigin);} catch (value) {error = value;}
    expect(error).toMatchObject({code: 'API', outcome: 'Failed'});
    expect(String(error)).not.toContain('BEGIN CERTIFICATE'); expect(String(error)).not.toContain('other-user');
  }
});
