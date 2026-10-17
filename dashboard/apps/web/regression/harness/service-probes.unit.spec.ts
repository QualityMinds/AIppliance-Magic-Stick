import {test, expect, type APIRequestContext} from '@playwright/test';
import {moduleResourceLinks, type ResourceLink} from '@magicstick/dashboard-core';
import {moduleProbeLinks, probeModuleServices} from '../core/service-probes.ts';
import {evidenceAnnotations} from '../core/evidence.ts';

const annotation = evidenceAnnotations({id: 'HAR-10', layer: 'U'});
const link = (url: string, scope: ResourceLink['scope']): ResourceLink => ({url, scope, label: 'Synthetic service'});
const local = link('https://anythingllm.fixture.local/', 'local');
const publicLink = link('https://anythingllm.magicstick.example.com/', 'public');

test('MOD-03 local service readiness does not probe the advertised public placeholder', annotation, async () => {
  const links = moduleResourceLinks('anythingllm', undefined, {httpRoutes: [
    {name: 'anythingllm-local', namespace: 'ai', accepted: true, hostnames: ['anythingllm.fixture.local']},
    {name: 'anythingllm-public', namespace: 'ai', accepted: true, hostnames: ['anythingllm.magicstick.example.com']},
    {name: 'anythingllm-not-ready', namespace: 'ai', accepted: false, hostnames: ['unready.fixture.local']},
  ]});
  expect(links.map(item => item.scope)).toEqual(['local', 'public']);
  const selected = moduleProbeLinks(links, 'https://fixture.local'), calls: string[] = [];
  const request = {get: async (url: string, options: Record<string, unknown>) => {
    calls.push(url);
    if (new URL(url).hostname.endsWith('.example.com')) throw new Error('getaddrinfo ENOTFOUND synthetic-public-host');
    expect(options).toMatchObject({ignoreHTTPSErrors: true, maxRedirects: 0, timeout: 1234, failOnStatusCode: false});
    return {status: () => 200, dispose: async () => {}};
  }} as unknown as APIRequestContext;
  expect(selected.map(item => new URL(item.url).hostname)).toEqual(['anythingllm.fixture.local']);
  await probeModuleServices(request, selected, 1234);
  expect(calls).toEqual([selected[0]!.url]);
  // Counterproof: the former all-links loop reaches the bogus public route.
  await expect(probeModuleServices(request, links, 1234)).rejects.toMatchObject({code: 'API', outcome: 'Failed', stage: 'module-ready'});
});

test('MOD-03 missing local routes fail without public fallback or borrowing a peer route', annotation, () => {
  const peer = link('https://anythingllm.monster.fixture.local/', 'local');
  const appliance = 'https://monster.fixture.local';
  for (const links of [[], [publicLink], [local], [link('https://monster.fixture.local/', 'local')]])
    expect(() => moduleProbeLinks(links, appliance)).toThrow('[API]');
  expect(moduleProbeLinks([local, peer, publicLink], appliance)).toEqual([peer]);
  expect(moduleProbeLinks([local, peer, publicLink], 'https://fixture.local')).toEqual([local]);
  expect(moduleProbeLinks([local, local, publicLink], 'https://fixture.local')).toEqual([local]);
});

test('MOD-03 public and direct connections retain their own advertised route checks', annotation, () => {
  expect(moduleProbeLinks([local, publicLink], 'https://dashboard.example.com')).toEqual([publicLink]);
  const direct = link('https://192.0.2.1:8443/', 'direct');
  expect(moduleProbeLinks([direct, local, publicLink], 'https://192.0.2.1')).toEqual([direct]);
  expect(() => moduleProbeLinks([direct], 'https://192.0.2.2')).toThrow('[API]');
  for (const url of ['http://anythingllm.fixture.local/', 'https://user:synthetic@anythingllm.fixture.local/', 'invalid'])
    expect(() => moduleProbeLinks([link(url, 'local')], 'https://fixture.local')).toThrow('[CONFIG]');
  for (const dashboard of ['http://fixture.local', 'https://fixture.local/path', 'invalid'])
    expect(() => moduleProbeLinks([local], dashboard)).toThrow('[CONFIG]');
});

test('MOD-03 functional TLS policy never accepts a failed HTTP response, DNS failure or timeout', annotation, async () => {
  await expect(probeModuleServices({get: async () => {throw new Error('No request expected');}} as unknown as APIRequestContext, [], 1000))
    .rejects.toMatchObject({code: 'API', outcome: 'Failed', stage: 'module-ready'});
  for (const status of [200, 302, 303, 401, 403, 404, 500, 503]) {
    let disposed = 0;
    const request = {get: async () => ({status: () => status, dispose: async () => {disposed++;}})} as unknown as APIRequestContext;
    const probe = probeModuleServices(request, [local], 1000);
    if ([200, 302, 303].includes(status)) await probe;
    else await expect(probe).rejects.toMatchObject({code: 'API', outcome: 'Failed', stage: 'module-ready'});
    expect(disposed).toBe(1);
  }
  for (const message of ['getaddrinfo ENOTFOUND service.fixture.local', 'Timeout 1000ms exceeded', 'ECONNREFUSED']) {
    const request = {get: async () => {throw new Error(message);}} as unknown as APIRequestContext;
    await expect(probeModuleServices(request, [local], 1000)).rejects.toMatchObject({code: 'API', outcome: 'Failed', stage: 'module-ready'});
  }
});
