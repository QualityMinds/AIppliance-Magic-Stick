import {test, expect, type Browser} from '@playwright/test';
import {fixturePage, origin} from '../fixtures/dashboard.ts';
import {syntheticKubeconfig, kubernetesIdentityOrigin} from '../fixtures/kubernetes.ts';
import {verifyKubeconfigExport, verifyRevokedAccessUi} from './kubeconfig-export.cases.ts';
import {evidenceAnnotations} from '../core/evidence.ts';

const annotation = evidenceAnnotations({id: 'K8S-05', layer: 'B'}, {id: 'HAR-10', layer: 'B'});
async function fixture(browser: Browser, options: {delay?: number; fault?: 'http' | 'clipboard' | 'stale' | 'file' | 'filename' | 'oversize' | 'never'; acceptDownloads?: boolean; revoked?: boolean} = {}) {
  const context = await browser.newContext({serviceWorkers: 'block', acceptDownloads: options.acceptDownloads !== false});
  const content = syntheticKubeconfig(), filename = 'fixture.kubeconfig';
  let reads = 0;
  if (options.fault === 'clipboard' || options.fault === 'stale') await context.addInitScript(fault => {
    Object.defineProperty(navigator.clipboard, 'writeText', {configurable: true,
      value: async (value: string) => {if (value && fault === 'clipboard') throw new Error('Synthetic clipboard failure');}});
    if (fault === 'stale') Object.defineProperty(navigator.clipboard, 'readText', {configurable: true, value: async () => 'synthetic stale clipboard'});
  }, options.fault);
  // Install the real built UI adapter on this context before its first page.
  await fixturePage(context, {
      '/api/session': {subject: 'fixture-admin', username: 'fixture-admin', roles: ['magicstick-admin'],
        identityManagementAvailable: true, identityManagementMode: 'keycloak'},
      '/api/kubernetes-access': {users: [
        {id: 'fixture-user', username: 'fixture-user', displayName: 'Regression Disposable', email: 'fixture-user@example.invalid', enabled: true, accessLevel: options.revoked ? 'none' : 'viewer'},
        {id: 'other-user', username: 'fixture-user-extra', displayName: 'Regression Disposable', email: 'fixture-user-extra@example.invalid', enabled: true, accessLevel: 'viewer'},
      ], total: 2, configuration: {configured: true, apiServer: 'https://192.0.2.44:6443'}},
      '/api/kubernetes-access/fixture-user/kubeconfig': async () => {
        reads++;
        if (options.fault === 'never') return await new Promise(() => {});
        if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
        return {filename: options.fault === 'filename' && reads > 1 ? 'wrong.kubeconfig' : filename,
          content: options.fault === 'file' && reads > 1 ? syntheticKubeconfig('other-user') :
            options.fault === 'oversize' && reads > 1 ? 'x'.repeat(70 * 1024) : content};
      },
    });
    if (options.fault === 'http') await context.route(origin + '/api/kubernetes-access/fixture-user/kubeconfig',
      route => route.fulfill({status: 503, contentType: 'application/json', body: '{"error":"Synthetic API failure"}'}));
  const input = {origin, identityOrigin: kubernetesIdentityOrigin, username: 'fixture-user', userId: 'fixture-user',
    expected: {filename, content}, timeoutMs: options.fault === 'never' || options.fault === 'stale' ? 1000 : 5000};
  return {context, input, reads: () => reads};
}

test('K8S-05 delayed API copy waits for acknowledgement and validates the actual private download', annotation, async ({browser}) => {
  const f = await fixture(browser, {delay: 250});
  let downloads = 0; f.context.on('page', page => page.on('download', () => {downloads++;}));
  try {
    await verifyKubeconfigExport(f.context, f.input);
    expect(f.reads()).toBe(2); expect(downloads).toBe(1);
    expect(f.context.pages()).toHaveLength(0);
  } finally {await f.context.close();}
});

test('K8S-05 HTTP and clipboard rejection fail at copy rather than accepting an old value', annotation, async ({browser}) => {
  for (const fault of ['http', 'clipboard', 'stale'] as const) {
    const f = await fixture(browser, {fault});
    try {
      await expect(verifyKubeconfigExport(f.context, f.input)).rejects.toMatchObject({outcome: 'Failed', stage: 'kubeconfig-copy'});
      expect(f.context.pages()).toHaveLength(0);
    } finally {await f.context.close();}
  }
});

test('K8S-05 success notices cannot pass a canceled wrong-user wrong-name or oversized download', annotation, async ({browser}) => {
  for (const options of [{acceptDownloads: false}, {fault: 'file' as const}, {fault: 'filename' as const}, {fault: 'oversize' as const}]) {
    const f = await fixture(browser, options);
    try {
      await expect(verifyKubeconfigExport(f.context, f.input)).rejects.toMatchObject({outcome: 'Failed', stage: 'kubeconfig-download'});
      expect(f.context.pages()).toHaveLength(0);
    } finally {await f.context.close();}
  }
});

test('K8S-05 a never-completing export is bounded and closes its page before later work', annotation, async ({browser}) => {
  const f = await fixture(browser, {fault: 'never'});
  try {
    await expect(verifyKubeconfigExport(f.context, f.input)).rejects.toMatchObject({code: 'DEADLINE', outcome: 'Failed', stage: 'kubeconfig-copy'});
    expect(f.context.pages()).toHaveLength(0);
  } finally {await f.context.close();}
});

test('K8S-06 revoked UI proof requires no access and both disabled export actions',
  evidenceAnnotations({id:'K8S-06',layer:'B'}), async ({browser}) => {
    for(const revoked of [true,false]) {
      const f=await fixture(browser,{revoked});
      try {
        const checked=verifyRevokedAccessUi(f.context,origin,'fixture-user',5000);
        if(revoked)await checked;
        else await expect(checked).rejects.toMatchObject({code:'API',outcome:'Failed'});
        expect(f.reads()).toBe(0);expect(f.context.pages()).toHaveLength(0);
      }finally{await f.context.close();}
    }
  });
