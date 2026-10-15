import {expect, test} from '@playwright/test';
import {assertGatewayStable, gatewayProcessSnapshot, gatewaySnapshot} from '../core/gateway-stability.ts';
import type {KubeObject} from '../core/observer.ts';

function proxy(uid = 'proxy-uid', restarts = 0): KubeObject {
  return {metadata: {uid, namespace: 'envoy-gateway-system', name: 'synthetic-private-name', labels: {
    'app.kubernetes.io/managed-by': 'envoy-gateway', 'app.kubernetes.io/component': 'proxy',
  }}, status: {phase: 'Running', conditions: [{type: 'Ready', status: 'True'}], containerStatuses: [{
    name: 'envoy', containerID: `containerd://${uid}`, ready: true, restartCount: restarts, state: {running: {}},
  }]}};
}

test('MOD-03 MOD-04 APP-02 route churn keeps the same healthy gateway processes, including setup proxy', async () => {
  const previous = gatewayProcessSnapshot([proxy('identity'), proxy('setup', 2)]);
  const reordered = gatewayProcessSnapshot([proxy('setup', 2), proxy('identity')]);
  expect(() => assertGatewayStable(previous, reordered)).not.toThrow();
  const calls: unknown[][] = [];
  expect(await gatewaySnapshot({list: async (...args) => {calls.push(args); return [proxy()];}})).toMatchObject({
    version: 1, processes: [{uid: 'proxy-uid', restarts: 0, ready: true}],
  });
  expect(calls).toEqual([['pods', 'envoy-gateway-system']]);
  expect(JSON.stringify(previous)).not.toContain('synthetic-private-name');
});

test('MOD-03 MOD-04 APP-02 rejects a recovered exit139, OOM, replacement, scale change or unready proxy', () => {
  const before = gatewayProcessSnapshot([proxy()]);
  for (const change of [
    (pod: KubeObject) => {pod.status!.containerStatuses![0]!.restartCount = 1;},
    (pod: KubeObject) => {pod.status!.containerStatuses![0]!.lastState = {terminated: {exitCode: 139}};},
    (pod: KubeObject) => {pod.status!.containerStatuses![0]!.lastState = {terminated: {exitCode: 137, reason: 'OOMKilled'}};},
    (pod: KubeObject) => {pod.metadata.uid = 'replacement';},
    (pod: KubeObject) => {pod.status!.containerStatuses![0]!.containerID = 'containerd://new-process';},
    (pod: KubeObject) => {pod.status!.containerStatuses![0]!.ready = false;},
    (pod: KubeObject) => {pod.status!.conditions![0]!.status = 'False';},
    (pod: KubeObject) => {pod.status!.containerStatuses![0]!.state = {waiting: {reason: 'CrashLoopBackOff'}};},
    (pod: KubeObject) => {pod.metadata.deletionTimestamp = '2026-01-01T00:00:00Z';},
  ]) {
    const pod = proxy(); change(pod);
    expect(() => assertGatewayStable(before, gatewayProcessSnapshot([pod]))).toThrow('[stage:gateway-ready]');
  }
  expect(() => assertGatewayStable(before, gatewayProcessSnapshot([proxy(), proxy('extra')]))).toThrow('[API]');
});

test('MOD-03 MOD-04 APP-02 missing or unavailable gateway observation fails rather than silently passing', async () => {
  const unrelated = proxy(); unrelated.metadata.labels!['app.kubernetes.io/component'] = 'controller';
  for (const pods of [[], [unrelated], [proxy(), proxy()]]) {
    await expect(gatewaySnapshot({list: async () => pods})).rejects.toMatchObject({
      code: 'API', outcome: 'Failed', stage: 'gateway-ready',
    });
  }
  const malformed = proxy(); delete malformed.status!.containerStatuses![0]!.restartCount;
  expect(() => gatewayProcessSnapshot([malformed])).toThrow('[API]');
  await expect(gatewaySnapshot({list: async () => {throw new Error('synthetic-private-token');}})).rejects.toThrow('[stage:gateway-ready]');
  const historical = proxy('existing', 1); historical.status!.containerStatuses![0]!.lastState = {terminated: {exitCode: 139}};
  const baseline = await gatewaySnapshot({list: async () => [historical]});
  expect(() => assertGatewayStable(baseline, structuredClone(baseline))).not.toThrow();
});
