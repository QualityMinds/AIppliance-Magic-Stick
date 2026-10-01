import {spawn, execFileSync} from 'node:child_process';
import {mkdtemp, rm, readFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join, resolve} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {loadLabConfig} from './core/config.ts';
import {HarnessError, requireSafe} from './core/errors.ts';
import {ResourceJournal, newRunId} from './core/journal.ts';
import {privateDirectory, writePrivate} from './core/private-files.ts';
import {saveReport} from './core/report.ts';

process.umask(0o077);
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const mode = process.argv[2], runId = newRunId();
const output = resolve(process.env.REGRESSION_OUTPUT_DIR ?? '.regression/runs');
const directory = join(output, runId);
const required = mode === 'locktest' ? ['HAR-04', 'HAR-08', 'HAR-09'] : mode === 'ownedtest' ? ['HAR-05', 'HAR-06', 'HAR-07'] :
  mode === 'smoke' ? ['LIFE-01', 'ROUTE-01', 'LIFE-03', 'LIFE-04', 'LIFE-06'] :
  mode === 'recover' ? ['HAR-07'] : ['HAR-01', 'HAR-02', 'HAR-03'];
let home, child;

try {
  requireSafe(['selftest', 'preflight', 'locktest', 'ownedtest', 'smoke', 'recover', 'typecheck', 'cleanup-plan'].includes(mode), 'CONFIG');
  await privateDirectory(output); await privateDirectory(directory);
  const environment = {...process.env, REGRESSION_MODE: mode, REGRESSION_RUN_ID: runId, REGRESSION_RUN_DIR: directory};
  home = await mkdtemp(join(tmpdir(), 'magicstick-browser-'));
  if (process.platform === 'linux') environment.HOME = home;
  if (mode === 'preflight' || mode === 'locktest' || mode === 'ownedtest' || mode === 'smoke' || mode === 'recover' || mode === 'cleanup-plan') {
    requireSafe(process.env.REGRESSION_CONFIG, 'CONFIG');
    const config = await loadLabConfig(process.env.REGRESSION_CONFIG);
    if (mode === 'cleanup-plan') {
      requireSafe(process.argv[3], 'CONFIG');
      const journal = await ResourceJournal.resume(resolve(process.argv[3]), config.expected.applianceUid);
      await writePrivate(join(directory, 'recovery-plan.json'), {version: 1, runId: journal.runId, mutationsEnabled: false, entries: journal.recoveryPlan()});
      console.log(`Read-only recovery plan saved (${journal.recoveryPlan().length} remaining entries). Nothing was removed.`);
      process.exitCode = journal.recoveryPlan().length ? 2 : 0;
    } else if (mode === 'recover') {
      const journalPath = process.argv[3];
      requireSafe(typeof journalPath === 'string' && /^\/private\/runs\/reg-[0-9a-f-]{36}\/journal\.json$/.test(journalPath), 'CONFIG');
      const recovered = await ResourceJournal.resume(journalPath, config.expected.applianceUid);
      requireSafe(recovered.recoveryPlan().length > 0, 'CONFIG');
      environment.REGRESSION_RECOVERY_JOURNAL = journalPath;
    } else {
      await ResourceJournal.create(join(directory, 'journal.json'), runId, config.expected.applianceUid);
    }
    if (mode !== 'cleanup-plan') {
      if (config.caFile) {
        requireSafe(process.platform === 'linux', 'CONFIG');
        const bundle = await readFile(config.caFile, 'utf8');
        requireSafe(bundle.length < 256 * 1024 && !bundle.includes('PRIVATE KEY'), 'TLS');
        const certificates = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
        requireSafe(certificates.length > 0 && certificates.length < 20, 'TLS');
        const database = join(home, '.pki/nssdb'); await mkdir(database, {recursive: true, mode: 0o700});
        execFileSync('certutil', ['-N', '--empty-password', '-d', `sql:${database}`], {stdio: 'pipe'});
        for (const [index, certificate] of certificates.entries()) {
          const parsed = new X509Certificate(certificate);
          requireSafe(parsed.ca && Date.parse(parsed.validFrom) <= Date.now() && Date.parse(parsed.validTo) > Date.now(), 'TLS');
          const filename = join(home, `ca-${index}.pem`); await writePrivate(filename, certificate);
          execFileSync('certutil', ['-A', '-d', `sql:${database}`, '-n', `magicstick-lab-${index}`, '-t', 'C,,', '-i', filename], {stdio: 'pipe'});
        }
        environment.NODE_EXTRA_CA_CERTS = config.caFile;
      }
    }
  }
  if (mode !== 'cleanup-plan') {
    const arguments_ = mode === 'typecheck' ? ['exec', 'tsc', '-p', 'regression/tsconfig.json'] :
      ['exec', 'playwright', 'test', '--config', 'regression/playwright.config.ts'];
    child = spawn('pnpm', arguments_, {env: environment, stdio: 'inherit'});
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child?.kill(signal));
    process.exitCode = await new Promise(resolveExit => {
      child.once('error', () => resolveExit(2));
      child.once('close', (code, signal) => resolveExit(signal ? 2 : code ?? 2));
    });
  }
} catch (error) {
  const reason = error instanceof HarnessError ? error.code : 'UNEXPECTED';
  console.error(new HarnessError(reason).message);
  try {
    await saveReport(directory, runId, required.map(id => ({id, outcome: 'Blocked', layer: 'live', durationMs: 0, reason})), required,
      process.env.REGRESSION_SOURCE_REVISION);
    console.log(`Private report: ${join(directory, 'summary.txt')}`);
  } catch { console.error('A safe report could not be written; check private-directory permissions.'); }
  process.exitCode = 2;
} finally { if (home) await rm(home, {recursive: true, force: true}); }
