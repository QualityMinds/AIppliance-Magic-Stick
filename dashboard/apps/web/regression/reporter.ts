import type {FullResult, Reporter, TestCase, TestResult} from '@playwright/test/reporter';
import {join} from 'node:path';
import {HarnessError, reasons, type ReasonCode} from './core/errors.ts';
import {saveReport, type CaseResult} from './core/report.ts';

export default class SafeReporter implements Reporter {
  private cases: CaseResult[] = [];
  private unexpected = false;
  onError() { this.unexpected = true; process.stderr.write('Harness infrastructure error; no raw live details were printed.\n'); }
  onTestEnd(test: TestCase, result: TestResult) {
    const ids = [...new Set(test.title.match(/[A-Z]+-\d{2}/g) ?? [])];
    const code = result.errors.map(error => error.message?.match(/\[([A-Z_]+)\]/)?.[1])
      .find(value => value && Object.hasOwn(reasons, value)) as ReasonCode | undefined;
    const outcome = result.status === 'passed' ? (result.retry > 0 ? 'Flaky' : 'Passed') : result.status === 'skipped' ? 'Skipped' :
      code && code !== 'DEADLINE' && code !== 'CLEANUP' ? 'Blocked' : 'Failed';
    for (const id of ids) this.cases.push({id, outcome, layer: process.env.REGRESSION_MODE === 'selftest' ? 'fixture' : 'live',
      durationMs: result.duration, ...(code ? {reason: code} : outcome === 'Failed' ? {reason: 'UNEXPECTED' as const} : {})});
    process.stdout.write(`${ids.join(', ') || 'Unmapped test'}: ${outcome}${code ? ` (${code})` : ''}\n`);
    if (!ids.length) this.unexpected = true;
  }
  async onEnd(result: FullResult) {
    const directory = process.env.REGRESSION_RUN_DIR, runId = process.env.REGRESSION_RUN_ID;
    if (!directory || !runId) throw new HarnessError('CONFIG');
    const required = process.env.REGRESSION_MODE === 'selftest' ? Array.from({length: 11}, (_, index) => `HAR-${String(index + 1).padStart(2, '0')}`) :
      process.env.REGRESSION_MODE === 'locktest' ? ['HAR-04', 'HAR-08', 'HAR-09'] :
      process.env.REGRESSION_MODE === 'ownedtest' ? ['HAR-05', 'HAR-06', 'HAR-07'] :
      process.env.REGRESSION_MODE === 'recover' ? ['HAR-07'] :
      process.env.REGRESSION_MODE === 'smoke' ? ['LIFE-01', 'ROUTE-01', 'LIFE-03', 'LIFE-04', 'LIFE-06'] : ['HAR-01', 'HAR-02', 'HAR-03'];
    const summary = await saveReport(directory, runId, this.cases, required, process.env.REGRESSION_SOURCE_REVISION);
    process.stdout.write(`Private report: ${join(directory, 'summary.txt')}\n`);
    return {status: !summary.acceptable || this.unexpected || result.status !== 'passed' ? 'failed' as const : 'passed' as const};
  }
}
