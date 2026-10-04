import {test, expect} from '@playwright/test';
import type {CpuScenario} from '../core/cpu-scenario.ts';
import {activation} from '../core/owned-model.ts';
import {requireSafe} from '../core/errors.ts';

/** Registered inside one explicit serial workflow; not standalone cross-file dependencies. */
export function registerModelDraft(s: CpuScenario) {
  const title = s.title;
  test(title('UX-02', 'model-form-defaults', 'owned edit defaults and unchanged, changed, reverted and invalid drafts survive refresh'), async () => {
    const {heartbeat, config, context, model, name, uid, generation, editedContextWindow} = s;
    await heartbeat(); requireSafe(config.smokeModel, 'CONFIG'); const page = await context!.newPage();
    try {
      await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
      await page.getByRole('button', {name: `Edit ${name}`}).click();
      const dialog = page.getByRole('dialog', {name: `Edit Model · ${name}`}), field = dialog.getByLabel('Context Size');
      const save = dialog.getByRole('button', {name: 'Save changes'});
      await expect(field).toHaveValue(String(config.smokeModel.contextWindow)); await expect(save).toBeDisabled();
      const advanced = dialog.locator('details').filter({has: page.locator('summary').filter({hasText: /^Advanced$/})});
      await expect(advanced).toHaveCount(1); expect(await advanced.getAttribute('open')).toBeNull();
      await field.fill(String(editedContextWindow())); await expect(save).toBeEnabled();
      await page.waitForResponse(response => new URL(response.url()).pathname === '/api/models' && response.request().method() === 'GET', {timeout: 25_000});
      await expect(field).toHaveValue(String(editedContextWindow()));
      await field.fill(String(config.smokeModel.contextWindow)); await expect(save).toBeDisabled();
      await field.fill('0'); await expect(save).toBeDisabled();
      await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
    } finally { await page.close(); }
    const current = activation(await model.models(), name);
    requireSafe(current?.metadata?.uid === uid && current.metadata.generation === generation &&
      current.spec?.local?.contextWindow === config.smokeModel.contextWindow, 'API');
  });
}
