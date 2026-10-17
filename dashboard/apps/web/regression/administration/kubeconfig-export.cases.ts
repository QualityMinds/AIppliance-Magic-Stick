import {test, type BrowserContext, type Download, type Page} from '@playwright/test';
import {atStage, requireProof as requireSafe} from '../core/errors.ts';
import {parseKubeconfig} from '../core/oidc-exec.ts';
import {poll} from '../core/poll.ts';
import {bounded, withCleanup} from '../core/run-lifecycle.ts';

const maximumBytes = 64 * 1024;
const normalized = (text: string) => text.replace(/\r\n/g, '\n');

/** Never use text equality assertions: their diffs would publish kubeconfig
 * contents. Comparing the entire current export also rejects another user's
 * stale kubeconfig for the same cluster, issuer and certificate authorities. */
export function assertCurrentKubeconfig(content: string, expected: string, identityOrigin: string) {
  requireSafe(Buffer.byteLength(content) > 0 && Buffer.byteLength(content) < maximumBytes &&
    Buffer.byteLength(expected) < maximumBytes && normalized(content) === normalized(expected), 'API');
  return parseKubeconfig(content, identityOrigin);
}

export async function kubernetesAccessRow(page: Page, origin: string, username: string, timeoutMs: number) {
  requireSafe(/^[a-z0-9-]{1,63}$/.test(username), 'CONFIG');
  await page.goto(origin + '/#/kubernetes-access', {timeout: timeoutMs});
  await page.getByPlaceholder('Username, name, or email').fill(username, {timeout: timeoutMs});
  await page.getByRole('button', {name: 'Search', exact: true}).click({timeout: timeoutMs});
  // The strong label is the display name; the small label can include email.
  // Match the complete username field, not a prefix or the display name.
  const identity = page.locator('td small').filter({hasText: new RegExp('^' + username + '(?: · |$)')});
  const row = page.getByRole('row').filter({has: identity});
  await row.waitFor({state: 'visible', timeout: timeoutMs});
  requireSafe(await row.count() === 1, 'API');
  return row;
}

export async function verifyRevokedAccessUi(context: BrowserContext, origin: string, username: string, timeoutMs: number) {
  await test.step('Verify removed Kubernetes access and disabled exports in the Dashboard', async () => {
    const page = await context.newPage();
    try {
      const row = await kubernetesAccessRow(page, origin, username, timeoutMs);
      requireSafe(await row.getByText('No access', {exact: true}).isVisible() &&
        await row.getByRole('button', {name: 'Download Kubeconfig', exact: true}).isDisabled() &&
        await row.getByRole('button', {name: 'Copy to Clipboard', exact: true}).isDisabled(), 'API');
    } finally {await page.close();}
  });
}

async function readDownload(download: Download, filename: string, expected: string, identityOrigin: string) {
  try {
    requireSafe(download.suggestedFilename() === filename && await download.failure() === null, 'API');
    const stream = await download.createReadStream();
    requireSafe(stream, 'API');
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const value of stream) {
        const chunk = Buffer.from(value); size += chunk.length;
        requireSafe(size < maximumBytes, 'API'); chunks.push(chunk);
      }
    } finally { stream.destroy(); }
    assertCurrentKubeconfig(Buffer.concat(chunks).toString('utf8'), expected, identityOrigin);
  } finally { await download.delete(); }
}

/** The caller supplies a dedicated, real admin context accepting private
 * downloads. Nothing is attached to the report; files are consumed/deleted and
 * the clipboard is cleared before closing the private context. */
export async function verifyKubeconfigExport(context: BrowserContext, input: {
  origin: string; identityOrigin: string; username: string; userId: string;
  expected: {filename: string; content: string}; timeoutMs: number;
}) {
  const {origin, identityOrigin, username, userId, expected, timeoutMs} = input;
  await atStage('kubeconfig-export', async () => {
    assertCurrentKubeconfig(expected.content, expected.content, identityOrigin);
    const page = await context.newPage();
    await withCleanup(async () => {
      const row = await kubernetesAccessRow(page, origin, username, timeoutMs);
      const endpoint = origin + `/api/kubernetes-access/${encodeURIComponent(userId)}/kubeconfig`;
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin});
      await test.step('Copy the current kubeconfig only after API and clipboard acknowledgement', () => atStage('kubeconfig-copy', () =>
        bounded(async () => {
          await page.evaluate(() => navigator.clipboard.writeText(''));
          const response = page.waitForResponse(value => value.url() === endpoint && value.request().method() === 'GET', {timeout: timeoutMs});
          const [result] = await Promise.all([response, row.getByRole('button', {name: 'Copy to Clipboard', exact: true}).click({timeout: timeoutMs})]);
          requireSafe(result.status() === 200, 'API');
          await page.getByText(`Kubeconfig copied for ${username}. It contains no token or password.`, {exact: true})
            .waitFor({state: 'visible', timeout: timeoutMs});
          await poll(() => page.evaluate(text => navigator.clipboard.readText().then(value => value.replace(/\r\n/g, '\n') === text), normalized(expected.content)),
            Boolean, {timeoutMs, intervalMs: 50, stage: 'kubeconfig-copy'});
          const copied = await page.evaluate(() => navigator.clipboard.readText());
          assertCurrentKubeconfig(copied, expected.content, identityOrigin);
          await page.evaluate(() => navigator.clipboard.writeText(''));
        }, timeoutMs, 'kubeconfig-copy', () => page.close())));
      await test.step('Download and verify the actual private kubeconfig file, not the success notice', () => atStage('kubeconfig-download', () =>
        bounded(async () => {
          const response = page.waitForResponse(value => value.url() === endpoint && value.request().method() === 'GET', {timeout: timeoutMs});
          // Install every listener before clicking. An HTTP failure must not
          // become a leaked promise waiting for a download that never exists.
          const downloaded = page.waitForEvent('download', {timeout: timeoutMs}); downloaded.catch(() => {});
          const [result] = await Promise.all([response, row.getByRole('button', {name: 'Download Kubeconfig', exact: true}).click({timeout: timeoutMs})]);
          requireSafe(result.status() === 200, 'API');
          await readDownload(await downloaded, expected.filename, expected.content, identityOrigin);
        }, timeoutMs, 'kubeconfig-download', () => page.close())));
    }, async () => {
      if (!page.isClosed()) {
        try { await page.evaluate(() => navigator.clipboard.writeText('')); }
        finally { await page.close(); }
      }
    });
  });
}
