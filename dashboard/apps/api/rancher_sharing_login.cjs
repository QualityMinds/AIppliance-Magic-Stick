// SPDX-License-Identifier: MIT
// Private stdin/stdout pipe used by rancher_sharing_test.py, never a console report.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const {base, password, names} = JSON.parse(input);
  if (new URL(base).hostname !== 'localhost') throw new Error('Local test URL required.');
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  const cookies = {};
  try {
    for (const name of names) {
      const context = await browser.newContext({ignoreHTTPSErrors: true});
      const page = await context.newPage();
      await page.goto(base + '/');
      await page.locator('#username').fill(name);
      await page.locator('#password').fill(password);
      await page.locator('#kc-login').click();
      await page.waitForURL(url => url.origin === base && url.pathname === '/');
      const values = await context.cookies(base);
      if (!values.some(value => value.name === 'MagicStickAccessToken')) throw new Error('No authenticated session cookie.');
      cookies[name] = values.map(value => value.name + '=' + value.value).join('; ');
      await context.close();
    }
    process.stdout.write(JSON.stringify(cookies));
  } finally {await browser.close();}
})().catch(() => {console.error('Local Keycloak/Envoy browser login failed; no credentials are logged.'); process.exitCode = 1;});
