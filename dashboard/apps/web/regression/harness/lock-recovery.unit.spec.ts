import {test, expect} from '@playwright/test';
import {mkdtemp, rm, lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {exactRecoveryLock, parseRecoveryLock} from '../core/lock-recovery.ts';
import {recoverLockWithSetup} from '../core/lock-recovery-workflow.ts';
import {readPrivate, writePrivate} from '../core/private-files.ts';
import {HarnessError} from '../core/errors.ts';
import type {Lease} from '../core/lease.ts';
import {KubernetesProgress} from '../core/kubernetes-progress.ts';
import {saveReport} from '../core/report.ts';
import {newRunId} from '../core/journal.ts';
import {harnessFailure} from '../reporter.ts';
import {publicResult} from '../core/kubernetes-progress.ts';

const uid = '11111111-2222-3333-4444-555555555555';
const expected = {uid, resourceVersion: '42', runId: 'reg-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'};
const registration = {version: 1, kind: 'disposable-regression-lab', policyVersion: 1, id: uid,
  applianceUid: 'fixture-appliance', nodeUids: ['fixture-node'], dashboardUrl: 'https://dashboard.example.local',
  identityUrl: 'https://id.example.local', createdAt: '2026-10-13T12:00:00Z'};
const facts = {applianceUid: registration.applianceUid, dashboardUrl: registration.dashboardUrl, identityUrl: registration.identityUrl};
const lease = (now: number): Lease => ({apiVersion: 'coordination.k8s.io/v1', kind: 'Lease',
  metadata: {name: 'lab-lock', namespace: 'magicstick-regression', uid, resourceVersion: '42',
    labels: {'regression.magicstick.dev/appliance-uid': registration.applianceUid},
    annotations: {'regression.magicstick.dev/run-id': expected.runId}},
  spec: {holderIdentity: expected.runId, leaseDurationSeconds: 120, renewTime: new Date(now - 181_000).toISOString()}});
async function fixture(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'lock-recovery-'));
  try { await writePrivate(join(directory, 'lab-registration.json'), registration); await action(directory); }
  finally { await rm(directory, {recursive: true, force: true}); }
}

test('HAR-04 HAR-07 recovery binds the exact expired owner, UID, resource version and drain window', () => {
  const now = Date.now(), original = lease(now);
  expect(() => exactRecoveryLock(original, expected, now)).not.toThrow();
  for (const change of [{uid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}, {resourceVersion: '43'}])
    expect(() => exactRecoveryLock({...original, metadata: {...original.metadata, ...change}}, expected, now)).toThrow('[CONFLICT]');
  expect(() => exactRecoveryLock({...original, metadata: {...original.metadata, annotations: {}}}, expected, now)).not.toThrow();
  expect(() => exactRecoveryLock({...original, spec: {...original.spec, holderIdentity: ''}}, expected, now)).toThrow('[CONFLICT]');
  expect(() => exactRecoveryLock({...original, metadata: {...original.metadata, annotations: {'regression.magicstick.dev/run-id': newRunId()}}}, expected, now)).toThrow('[CONFLICT]');
  expect(() => exactRecoveryLock({...original, spec: {...original.spec, renewTime: new Date(now - 179_000).toISOString()}}, expected, now)).toThrow('[LOCK_STALE]');
  expect(() => exactRecoveryLock(undefined, expected, now)).toThrow('[CONFLICT]');
});

test('HAR-04 HAR-11 recovery snapshots never accept paths commands coercions or missing fields', () => {
  for (const value of [null, {}, {...expected, command: 'arbitrary'}, {...expected, resourceVersion: 42},
    {...expected, runId: '../foreign'}, {...expected, uid: 'different'}, {...expected, resourceVersion: '42\n'}])
    expect(() => parseRecoveryLock(value)).toThrow('[CONFIG]');
});

test('HAR-07 HAR-10 recovery-only workflow discovers identity, restores one journal and never prepares tests', async () => fixture(async directory => {
  const modes: string[] = [], stages: string[] = [];
  const execute = async () => {
    const request = JSON.parse(await readPrivate(join(directory, '.setup-api-request.json'))); modes.push(request.mode);
    expect(request).not.toHaveProperty('command'); expect(request).not.toHaveProperty('phases');
    if (request.mode === 'recover-lock') {
      expect(request.expectedLock).toEqual(expected); expect(request.approveAdminGrant).toBe(true);
      expect(request.reviewed).toEqual(facts);
    }
    await writePrivate(join(directory, '.setup-api-result.json'), {...facts,
      ...(request.mode === 'recover-lock' ? {recoveredRunIds: [expected.runId]} : {})});
  };
  expect(await recoverLockWithSetup(directory, registration.applianceUid, expected, execute,
    async stage => {stages.push(stage);})).toBe(expected.runId);
  expect(modes).toEqual(['inspect', 'recover-lock']);expect(stages).toEqual(['recovery-access', 'recovery-journal', 'recovery-verified']);
  expect(await lstat(join(directory, '.setup-api-request.json')).catch(() => undefined)).toBeUndefined();
}));

test('HAR-02 HAR-07 foreign registration and discovered installation abort before recovery', async () => fixture(async directory => {
  let calls = 0;
  await expect(recoverLockWithSetup(directory, 'foreign', expected, async () => {calls++;})).rejects.toMatchObject({code: 'LAB'});
  expect(calls).toBe(0);
  await expect(recoverLockWithSetup(directory, registration.applianceUid, expected, async () => {
    calls++; await writePrivate(join(directory, '.setup-api-result.json'), {...facts, applianceUid: 'foreign'});
  })).rejects.toMatchObject({code: 'IDENTITY'});
  expect(calls).toBe(1);
}));

test('HAR-06 HAR-07 missing or foreign restoration proof is Failed rather than a released lock', async () => fixture(async directory => {
  for (const ids of [[], [newRunId()]]) {
    await expect(recoverLockWithSetup(directory, registration.applianceUid, expected, async () => {
      await writePrivate(join(directory, '.setup-api-result.json'), {...facts, recoveredRunIds: ids});
    })).rejects.toMatchObject({code: 'CLEANUP', outcome: 'Failed'});
  }
}));

test('HAR-06 HAR-07 failed restoration is not retried and retains private access receipts', async () => fixture(async directory => {
  const receipt = join(directory, '.setup-access-restore.json');await writePrivate(receipt, {private: 'synthetic-receipt'});
  let calls = 0;
  await expect(recoverLockWithSetup(directory, registration.applianceUid, expected, async () => {
    calls++;throw new HarnessError('CLEANUP', 'Failed', 'cleanup');
  })).rejects.toMatchObject({code: 'CLEANUP', outcome: 'Failed'});
  expect(calls).toBe(1); expect(JSON.parse(await readPrivate(receipt))).toEqual({private: 'synthetic-receipt'});
}));

test('HAR-07 retained access restoration precedes discovery and leaves no temporary bootstrap authority', async () => fixture(async directory => {
  const receipt = join(directory, '.setup-access-restore.json');await writePrivate(receipt, {private: 'synthetic-receipt'});
  const modes: string[] = [];
  await recoverLockWithSetup(directory, registration.applianceUid, expected, async () => {
    const request = JSON.parse(await readPrivate(join(directory, '.setup-api-request.json')));modes.push(request.mode);
    if (request.mode === 'restore') await rm(receipt);
    await writePrivate(join(directory, '.setup-api-result.json'), {...facts, recoveredRunIds: [expected.runId]});
  });
  expect(modes).toEqual(['restore', 'inspect', 'recover-lock']);
}));

test('HAR-10 recovery progress has zero phases, a finite percentage and a portable failed report', async () => fixture(async directory => {
  const progress = new KubernetesProgress([]);
  expect(progress.snapshot().percent).toBe(0);
  progress.consume({version: 1, event: 'step-start', step: 'recovery-journal', index: 2, total: 3});
  expect(progress.snapshot().percent).toBe(33);expect(progress.snapshot(true).percent).toBe(100);
  await saveReport(directory, newRunId(), [{id: 'HAR-07', layer: 'A', environment: 'live', durationMs: 1,
    outcome: 'Failed', reason: 'CLEANUP'}], ['HAR-07'], 'unknown', 'recover', undefined, {recoveryFenceActive: true, recoveryAttempts: []});
  expect((await lstat(join(directory, 'report-artifacts.tar.gz'))).size).toBeGreaterThan(0);
  expect(JSON.parse(await readPrivate(join(directory, 'summary.json'))).recoveryFenceActive).toBe(true);
}));

test('HAR-07 HAR-10 recovery reports count one cleanup operation rather than a passed test suite', async () => fixture(async directory => {
  const runId=newRunId();
  await saveReport(directory,runId,[{id:'HAR-07',layer:'A',environment:'live',durationMs:1,outcome:'Passed',
    executionId:runId.slice(4).replaceAll('-','').slice(0,24),executionOutcome:'Passed'}],['HAR-07'],'unknown','recover');
  const summary=JSON.parse(await readPrivate(join(directory,'summary.json'))),result=publicResult(summary,{phases:[]});
  expect(result.executionCounts).toEqual({Passed:1,Failed:0,Blocked:0});expect(result.phases).toEqual([]);
  expect(summary.fullPhase0Accepted).toBe(false);
  expect(harnessFailure(new HarnessError('RECOVERY').message)).toMatchObject({code:'RECOVERY',outcome:'Blocked'});
  expect(harnessFailure(new HarnessError('AUTH').message)).toMatchObject({code:'AUTH',outcome:'Failed'});
  expect(harnessFailure('[RECOVERY] synthetic-private-error-body [outcome:Blocked]')).toBeUndefined();
}));
