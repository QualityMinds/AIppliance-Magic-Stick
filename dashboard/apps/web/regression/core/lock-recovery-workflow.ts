import {join} from 'node:path';
import {lstat, rm} from 'node:fs/promises';
import {readPrivate, writePrivate} from './private-files.ts';
import {parseRegistration} from './lab-policy.ts';
import {parseRecoveryLock, type RecoveryLock} from './lock-recovery.ts';
import {requireSafe} from './errors.ts';

/** Recovery-only orchestration around the existing setup/AutomaticRecovery
 * adapters. No suite preparation, model stop, license fixture or test launch. */
export async function recoverLockWithSetup(inputs: string, targetUid: string, expected: RecoveryLock,
  execute: () => Promise<void>, stage: (step: 'recovery-access' | 'recovery-journal' | 'recovery-verified', index: number) => Promise<void> = async () => {}) {
  parseRecoveryLock(expected);
  const registration = parseRegistration(JSON.parse(await readPrivate(join(inputs, 'lab-registration.json'))));
  requireSafe(registration.applianceUid === targetUid, 'LAB');
  const request = join(inputs, '.setup-api-request.json'), result = join(inputs, '.setup-api-result.json');
  const base = {version: 1, dashboardUrl: registration.dashboardUrl, identityUrl: registration.identityUrl,
    usernameFile: 'username.txt', passwordFile: 'password.txt', caFile: 'appliance-ca.pem'};
  const call = async (fields: Record<string, unknown>) => {
    await rm(result, {force: true});
    await writePrivate(request, {...base, ...fields});
    await execute();
    return JSON.parse(await readPrivate(result));
  };
  try {
    await stage('recovery-access', 1);
    if (await lstat(join(inputs, '.setup-access-restore.json')).catch(() => undefined)) await call({mode: 'restore'});
    const facts = await call({mode: 'inspect'});
    requireSafe(facts.applianceUid === targetUid && facts.dashboardUrl === registration.dashboardUrl &&
      facts.identityUrl === registration.identityUrl, 'IDENTITY');
    await stage('recovery-journal', 2);
    const restored = await call({mode: 'recover-lock', reviewed: facts, approveAdminGrant: true, expectedLock: expected});
    requireSafe(Array.isArray(restored.recoveredRunIds) && restored.recoveredRunIds.length === 1 &&
      restored.recoveredRunIds[0] === expected.runId, 'CLEANUP');
    for (const name of ['.setup-access-restore.json', '.setup-bootstrap.kubeconfig'])
      requireSafe(!await lstat(join(inputs, name)).catch(() => undefined), 'RECOVERY');
    await stage('recovery-verified', 3);
    return expected.runId;
  } finally {
    // Durable restoration receipts and original failed reports are retained.
    await rm(request, {force: true}); await rm(result, {force: true});
  }
}
