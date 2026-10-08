import {test, expect} from '@playwright/test';
import {join} from 'node:path';
import {loadLabConfig} from '../core/config.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import {ResourceJournal} from '../core/journal.ts';
import {poll} from '../core/poll.ts';
import {requireSafe} from '../core/errors.ts';
import {hasRuntimeCrashLoop} from '../core/owned-model.ts';
import {requirePhase2Profile} from '../profiles/phase2-p0.ts';
import {evidenceAnnotations} from '../core/evidence.ts';

function literalPattern(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

test('LIFE-12 NAV-06 run-owned CPU failure exposes its real bounded stage and never Ready', evidenceAnnotations(
  {id: 'LIFE-12', variant: 'failure-model', layer: 'A'},
  {id: 'LIFE-12', variant: 'failure-model', layer: 'E'},
  {id: 'NAV-06', variant: 'live-failure-status', layer: 'A'}), async ({browser}) => {
  requireSafe(process.env.REGRESSION_CONFIG && process.env.REGRESSION_RUN_DIR, 'CONFIG');
  const config = await loadLabConfig(process.env.REGRESSION_CONFIG); requirePhase2Profile(config);
  const journal = await ResourceJournal.resume(join(process.env.REGRESSION_RUN_DIR, 'journal.json'), config.expected.applianceUid);
  const live = await LiveFoundation.open(browser, config, journal);
  let created: Awaited<ReturnType<typeof live.createModel>> | undefined;
  try {
    const fixture = config.phase2!.failureModel;
    const models = await live.api.models();
    const capacities = (models.computeMemory?.devices ?? [])
      .filter(device => device.computeTarget === 'cpu' || device.id === 'cpu')
      .map(device => device.unreservedMi)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    requireSafe(capacities.length > 0 && fixture.memoryRequiredMi <= Math.max(...capacities), 'CAPABILITY');
    // The intentionally missing manifest cannot supply a RAM estimate. Opt in
    // for this bounded failure fixture only, so the runtime failure is exercised.
    created = await live.createModel('failure', journal, fixture, {allowMemoryRisk: true});
    const failed = await poll(() => live.modelState(created!.client, created!.uid), state => {
      const phase = String(state.item?.status?.phase ?? '');
      const message = String(state.item?.status?.message ?? '');
      return phase === 'Degraded' && state.observed?.status?.conditions?.some(condition =>
        condition.type === 'Ready' && condition.status === 'False' && condition.reason === 'ModelRuntimeCrashLoop' &&
        condition.observedGeneration === state.observed?.metadata.generation) === true &&
        state.pods.some(hasRuntimeCrashLoop) && message.toLowerCase().includes(fixture.expectedReason.toLowerCase()) &&
        !state.models.models?.some(model => model.id === created!.client.name);
    }, {timeoutMs: 900_000, intervalMs: 2000, stage: 'model-failure'});
    requireSafe(failed.item?.status?.phase === 'Degraded' && failed.item.spec?.enabled === true &&
      failed.item.status?.progress !== 100 && !failed.pods.some(pod => pod.status?.conditions?.some(condition =>
        condition.type === 'Ready' && condition.status === 'True')), 'API');
    const page = await live.context.newPage();
    try {
      await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
      const card = page.locator('.panel').filter({hasText: created.client.name});
      await expect(card.getByText('Degraded', {exact: true})).toBeVisible();
      // The progress label can repeat the same cause. Assert the card's actual
      // status paragraph, not an ambiguous text locator across both elements.
      await expect(card.locator('p.muted').filter({hasText: new RegExp(literalPattern(fixture.expectedReason), 'i')})).toBeVisible();
      await expect(card.getByText('Ready', {exact: true})).toHaveCount(0);
      await expect(card.getByText('100%', {exact: true})).toHaveCount(0);
    } finally { await page.close(); }
  } finally { await live.close(); }
});
