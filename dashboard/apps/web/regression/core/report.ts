import type {ReasonCode} from './errors.ts';
import {reasons, requireSafe} from './errors.ts';
import {writePrivate} from './private-files.ts';
import {join} from 'node:path';

export type Outcome = 'Passed' | 'Failed' | 'Blocked' | 'Skipped' | 'Not run' | 'Flaky';
export interface CaseResult {id: string; outcome: Outcome; layer: 'fixture' | 'live'; durationMs: number; reason?: ReasonCode}

export function summarize(required: string[], cases: CaseResult[]) {
  const missing = required.filter(id => !cases.some(item => item.id === id));
  const counts = Object.fromEntries(['Passed', 'Failed', 'Blocked', 'Skipped', 'Not run', 'Flaky'].map(
    outcome => [outcome, cases.filter(item => item.outcome === outcome).length]));
  const acceptable = required.length > 0 && cases.length > 0 && missing.length === 0 &&
    required.every(id => cases.filter(item => item.id === id).every(item => item.outcome === 'Passed')) &&
    cases.every(item => item.outcome === 'Passed');
  return {acceptable, required: required.length, selected: cases.length, executed: cases.filter(item => ['Passed', 'Failed', 'Flaky'].includes(item.outcome)).length,
    counts, missing};
}

function xml(value: string) { return value.replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[char]!)); }

/** Allowlisted output only. Never serialize a Playwright response, error or attachment. */
export async function saveReport(directory: string, runId: string, cases: CaseResult[], required: string[], sourceRevision = 'unknown') {
  requireSafe(/^reg-[0-9a-f-]{36}$/.test(runId), 'CONFIG');
  const safe = cases.map(item => {
    requireSafe(/^[A-Z]+-\d{2}$/.test(item.id), 'CONFIG');
    requireSafe(['Passed', 'Failed', 'Blocked', 'Skipped', 'Not run', 'Flaky'].includes(item.outcome) &&
      ['fixture', 'live'].includes(item.layer) && Number.isFinite(item.durationMs) && item.durationMs >= 0, 'CONFIG');
    const reason = item.reason && Object.hasOwn(reasons, item.reason) ? item.reason : undefined;
    return {id: item.id, outcome: item.outcome, layer: item.layer, durationMs: Math.max(0, Math.round(item.durationMs)), ...(reason ? {reason} : {})};
  });
  const summary = summarize(required, safe);
  const revision = /^[0-9a-f]{40,64}$/.test(sourceRevision) ? sourceRevision : 'unknown';
  const liveScope = process.env.REGRESSION_MODE === 'locktest' ? 'live lease, revision and Flux-polling safety; no product configuration change' :
    process.env.REGRESSION_MODE === 'ownedtest' ? 'live API-key ownership and cleanup subset; no model/app lifecycle acceptance' :
    process.env.REGRESSION_MODE === 'smoke' ? 'live run-owned CPU Ollama lifecycle and routed inference; no GPU/global setting changes' :
    process.env.REGRESSION_MODE === 'recover' ? 'explicit recovery of one journal-owned run; no new model/app resources' :
    'read-only live preflight';
  await writePrivate(join(directory, 'summary.json'), {version: 1, runId, sourceRevision: revision,
    scope: safe.some(item => item.layer === 'live') ? liveScope : 'isolated harness fixtures; no appliance acceptance',
    fullPhase0Accepted: false,
    ...summary, cases: safe});
  const missing = summary.missing.map(id => ({id, outcome: 'Not run' as const, layer: 'live' as const, durationMs: 0}));
  const entries = [...safe, ...missing];
  const suite = entries.map(item => {
    const failed = item.outcome !== 'Passed';
    const detail = 'reason' in item && item.reason ? reasons[item.reason] : item.outcome;
    return `<testcase classname="${item.layer}" name="${xml(item.id)}" time="${(item.durationMs / 1000).toFixed(3)}">` +
      (failed ? `<failure type="${xml(item.outcome)}" message="${xml(detail)}"/>` : '') + '</testcase>';
  }).join('\n');
  await writePrivate(join(directory, 'junit.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="magicstick-phase-0" tests="${entries.length}" failures="${entries.filter(item => item.outcome !== 'Passed').length}">\n${suite}\n</testsuite>\n`);
  await writePrivate(join(directory, 'summary.txt'), `Magic Stick selected regression cases: ${summary.acceptable ? 'PASSED' : 'NOT ACCEPTED'}\n` +
    'Full Phase 0 gate: NOT ASSESSED\n' +
    `Scope: ${safe.some(item => item.layer === 'live') ? liveScope : 'isolated fixtures only'}\n` +
    `Selected: ${summary.selected}; executed: ${summary.executed}; missing: ${summary.missing.length}\n` +
    safe.map(item => `${item.id}: ${item.outcome}${item.reason ? ` (${item.reason})` : ''}`).join('\n') + '\n');
  return summary;
}

/** Defense in depth for explicitly reviewed text; reports use allowlisting instead. */
export function redact(value: unknown, secrets: string[] = []): unknown {
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /authorization|cookie|password|secret|token|credential|storageState|license|invitation/i.test(key) ? '[REDACTED]' : redact(item, secrets)]));
  if (typeof value !== 'string') return value;
  let text = value;
  for (const secret of secrets.filter(item => item.length > 0)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s"<>]+/g, '[URL REDACTED]');
}
