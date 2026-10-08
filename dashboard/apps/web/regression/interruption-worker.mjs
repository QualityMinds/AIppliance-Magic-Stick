import {chromium} from '@playwright/test';
import {join} from 'node:path';
import {loadLabConfig} from './core/config.ts';
import {ResourceJournal} from './core/journal.ts';
import {LiveFoundation} from './core/live-foundation.ts';
import {requireSafe} from './core/errors.ts';

// Only the explicitly spawned test process is interrupted, at a durable UID
// barrier. No testserver restart, unrelated process or ambiguous create retry.
let browser, live;
let barrier = false;
try {
  requireSafe(process.send && process.env.REGRESSION_CONFIG &&
    /^\/private\/runs\/reg-[0-9a-f-]{36}$/.test(process.env.REGRESSION_RUN_DIR ?? ''), 'CONFIG');
  const config = await loadLabConfig(process.env.REGRESSION_CONFIG);
  const journal = await ResourceJournal.resume(join(process.env.REGRESSION_RUN_DIR, 'journal.json'), config.expected.applianceUid);
  browser = await chromium.launch({headless: true});
  live = await LiveFoundation.open(browser, config, journal);
  await live.createKey('interrupted-key');
  const model = await live.createModel('interrupted-cpu');
  await live.waitReady(model.client, model.uid, model.generation);
  requireSafe(journal.entries.length === 2 && journal.entries.every(item => item.state === 'owned' && item.uid), 'OWNERSHIP');
  await live.context.close(); await browser.close(); browser = undefined;
  barrier = true;
  process.send({event: 'journaled'});
  const heartbeat = setInterval(() => { void live.guard().catch(() => { process.exitCode = 2; clearInterval(heartbeat); }); }, 10_000);
  await new Promise(() => {});
} catch {
  if (process.send) process.send({event: 'blocked'});
  process.exitCode = 2;
} finally {
  if (!barrier) { try { await live?.close(); } catch { process.exitCode = 2; } }
  await browser?.close();
}
