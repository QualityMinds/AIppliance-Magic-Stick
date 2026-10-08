import {HarnessError, requireSafe, reasons, type ReasonCode} from './errors.ts';
import {readPrivate} from './private-files.ts';

export const setupStages = ['request', 'tls', 'login', 'discovery', 'kubernetes-access', 'oidc-session',
  'bootstrap-file', 'lab-bootstrap', 'run-recovery', 'license-fixtures', 'license-validation'] as const;
export const setupDetails = ['ENOENT', 'EACCES', 'ENOSPC', 'TYPE_ERROR', 'SYNTAX_ERROR', 'ERR_FAILED',
  'ERR_BLOCKED_BY_CLIENT', 'ERR_CONNECTION_REFUSED', 'ERR_NAME_NOT_RESOLVED', 'ERR_CERT_AUTHORITY_INVALID',
  'ERR_HTTP2_PROTOCOL_ERROR'] as const;
export interface PreparationDiagnostic {
  version: 1;
  outcome: 'Passed' | 'Failed' | 'Blocked';
  reason?: ReasonCode;
  setupStage?: typeof setupStages[number];
  detail?: typeof setupDetails[number];
  recoveredRunIds?:string[];
}

/** An allowlisted envelope, not a log forwarding channel. Discard all extra
 * keys and unknown detail strings even in private aggregate reports. */
export function parsePreparationDiagnostic(value: unknown): PreparationDiagnostic {
  const item = value as Partial<PreparationDiagnostic> | null;
  requireSafe(item && item.version === 1 && ['Passed', 'Failed', 'Blocked'].includes(item.outcome ?? ''), 'CONFIG');
  return {version: 1, outcome: item.outcome!,
    ...(item.reason && Object.hasOwn(reasons, item.reason) ? {reason: item.reason} : {}),
    ...(setupStages.includes(item.setupStage!) ? {setupStage: item.setupStage} : {}),
    ...(setupDetails.includes(item.detail!) ? {detail: item.detail} : {}),
    ...(Array.isArray(item.recoveredRunIds)&&item.recoveredRunIds.length>0&&item.recoveredRunIds.length<=64&&
      item.recoveredRunIds.every(id=>/^reg-[0-9a-f-]{36}$/.test(id))?{recoveredRunIds:[...new Set(item.recoveredRunIds)]}:{})};
}

export async function preparationDiagnostic(): Promise<PreparationDiagnostic | undefined> {
  const failed = process.env.REGRESSION_PREPARATION_FAILED;
  if (!failed&&!process.env.REGRESSION_PREPARATION_DIAGNOSTIC) return undefined;
  const outcome = failed === 'Failed' ? 'Failed' : 'Blocked';
  const filename = process.env.REGRESSION_PREPARATION_DIAGNOSTIC;
  if (!filename) return {version: 1, outcome, reason: 'PREREQUISITE'}; // Older launchers remain safe.
  let value: PreparationDiagnostic;
  try {
    requireSafe(/^\/private\/\.preparation-[a-zA-Z0-9]{6}$/.test(filename), 'PRIVATE_FILE');
    value = parsePreparationDiagnostic(JSON.parse(await readPrivate(filename)));
    requireSafe(failed?value.outcome===outcome:value.outcome==='Passed','CONFIG');
  }
  catch { return {version: 1, outcome: 'Failed', reason: 'CONFIG'}; }
  return value;
}

/** A failed bootstrap is one failure, not hundreds of product failures for
 * checks that could not start. Its dependent live cases remain Blocked. */
export async function requirePreparation() {
  const diagnostic = await preparationDiagnostic();
  if (diagnostic&&diagnostic.outcome!=='Passed') throw new HarnessError(diagnostic.outcome === 'Failed' ? 'DEPENDENCY' : diagnostic.reason ?? 'PREREQUISITE', 'Blocked');
}

export function preparationDescription(diagnostic: PreparationDiagnostic) {
  return `Automatic preparation: ${diagnostic.outcome}`+(diagnostic.outcome==='Passed'?'':` (${diagnostic.reason ?? 'PREREQUISITE'})`) +
    (diagnostic.setupStage ? `; setup stage: ${diagnostic.setupStage}` : '') +
    (diagnostic.detail ? `; detail: ${diagnostic.detail}` : '') + '.'+
    (diagnostic.recoveredRunIds?.length?` Previous interrupted run automatically restored (${diagnostic.recoveredRunIds.length}); original test outcomes retained.`:'');
}
