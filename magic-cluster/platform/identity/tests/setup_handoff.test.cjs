const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(0, 'utf8');

function jsonResponse(value) {
  return {
    ok: true,
    type: 'basic',
    headers: {get: () => 'application/json'},
    json: async () => value,
  };
}

function makePage(handoffResponses, options = {}) {
  const elements = Object.fromEntries(
    ['status', 'message', 'claim', 'config', 'done', 'recovery', 'recoveryUnavailable',
      'handoff', 'login', 'claimForm', 'setupForm']
      .map(name => [name, {hidden: name !== 'status', disabled: name === 'login',
        listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; }}]),
  );
  const timers = [];
  const visits = [];
  const storage = new Map();
  const requests = [];
  const statuses = options.statuses || [{phase: 'Completed'}];
  const context = {
    document: {querySelector: selector => elements[selector.slice(1)], cookie: ''},
    FormData: function () { return [
      ['password', 'a-long-test-password'],
      ['passwordConfirm', 'a-long-test-password'],
      ['mdnsDomain', 'magicstick.local'],
    ]; },
    crypto: {getRandomValues: data => data.fill(0xab)},
    history: {replaceState() {}},
    location: {pathname: '/', hash: '', assign: url => visits.push(url)},
    sessionStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    URLSearchParams,
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout() {},
    fetch: async path => {
      requests.push(path);
      if (path === '/setup/api/status') return jsonResponse(statuses.shift() || {phase: 'Completed'});
      if (path === '/setup/api/complete') return jsonResponse({
        recoveryUsername: 'recovery-test',
        recoveryCode: 'one-time-test-code',
        dashboardURL: 'https://magicstick.local/',
      });
      if (path === '/setup/api/handoff') {
        const response = handoffResponses.shift();
        if (response instanceof Error) throw response;
        assert.ok(response, 'unexpected handoff poll');
        return response;
      }
      if (path === 'https://magicstick.local/') return {type: 'opaque'};
      throw new Error('unexpected request: ' + path);
    },
  };
  elements.setupForm.querySelector = () => ({disabled: false});
  return {context, elements, timers, visits, requests};
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

async function testLocalRouteHandoff() {
  const page = makePage([
    jsonResponse({dashboardURL: 'https://magicstick.local/', dashboardReady: false}),
    jsonResponse({dashboardURL: 'https://magicstick.local/', dashboardReady: true}),
    {type: 'opaqueredirect'},
  ]);
  vm.runInNewContext(source, page.context);
  await flush();
  assert.equal(page.elements.done.hidden, false);
  assert.equal(page.elements.recovery.hidden, true);
  assert.equal(page.elements.recoveryUnavailable.hidden, false);
  assert.equal(page.elements.login.disabled, true);
  assert.deepEqual(page.visits, []);
  assert.equal(page.timers.length, 1);

  await page.timers.shift()();
  assert.equal(page.elements.login.disabled, true,
    'a ready backend must not redirect while the setup route still owns /');
  await page.timers.shift()();
  assert.equal(page.elements.login.disabled, false);
  assert.deepEqual(page.visits, [], 'recovery credentials must remain visible until user clicks');
  page.elements.login.listeners.click();
  assert.deepEqual(page.visits, ['https://magicstick.local/']);
}

async function testDirectSetupGatewayCloses() {
  const page = makePage([
    jsonResponse({dashboardURL: 'https://magicstick.local/', dashboardReady: true}),
    new Error('direct setup gateway closed'),
  ]);
  page.context.location.pathname = '/setup';
  vm.runInNewContext(source, page.context);
  await flush();
  assert.equal(page.elements.login.disabled, true);
  await page.timers.shift()();
  assert.equal(page.elements.login.disabled, false,
    'the direct setup page must enable login after its listener closes');
  assert.ok(page.requests.includes('https://magicstick.local/'));
}

async function testSuccessfulCompletionKeepsRecoveryVisible() {
  const page = makePage([
    jsonResponse({dashboardURL: 'https://magicstick.local/', dashboardReady: false}),
    {type: 'opaqueredirect'},
  ], {statuses: [{phase: 'Pending'}, {phase: 'Claimed', installationId: 'a1b2c3d4'}]});
  vm.runInNewContext(source, page.context);
  await flush();
  await page.elements.setupForm.listeners.submit({
    preventDefault() {}, target: page.elements.setupForm,
  });
  await flush();
  assert.equal(page.elements.done.hidden, false);
  assert.equal(page.elements.recovery.hidden, false);
  assert.match(page.elements.recovery.textContent, /one-time-test-code/);
  assert.equal(page.elements.login.disabled, true);
  assert.deepEqual(page.visits, []);
  await page.timers.shift()();
  assert.equal(page.elements.login.disabled, false);
  assert.match(page.elements.recovery.textContent, /one-time-test-code/);
}

Promise.resolve()
  .then(testLocalRouteHandoff)
  .then(testDirectSetupGatewayCloses)
  .then(testSuccessfulCompletionKeepsRecoveryVisible)
  .catch(error => { console.error(error); process.exitCode = 1; });
