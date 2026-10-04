// SPDX-License-Identifier: BUSL-1.1
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');

const chart = path.resolve(__dirname, '../../instances/paperclip');
const preload = path.join(chart, 'files/runtime-preload.cjs');
const {transform} = require(preload);

test('changed upstream compatibility files fail before code is patched', () => {
  for (const kind of ['manifest', 'plugin']) {
    assert.throws(() => transform(kind, '// upstream changed\n'), /checksum changed/);
  }
});

test('only the Kubernetes worker inherits the preload, without parent secrets', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-worker-test-'));
  try {
    fs.mkdirSync(path.join(directory, 'dist'));
    const worker = path.join(directory, 'dist/worker.js');
    fs.writeFileSync(worker, 'process.send({args:process.execArgv,secret:process.env.PAPERCLIP_TEST_PARENT_SECRET});');
    const {fork} = require('node:child_process');
    process.env.PAPERCLIP_TEST_PARENT_SECRET = 'synthetic-parent-only';
    for (const name of ['@paperclipai/plugin-kubernetes', 'some-other-plugin']) {
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({name, version:'2026.1001.0'}));
      const child = fork(worker, [], {execArgv: [], env: {PATH: process.env.PATH}, stdio:['ignore','ignore','pipe','ipc']});
      const [message] = await once(child, 'message');
      child.disconnect();
      await once(child, 'exit');
      assert.equal(message.secret, undefined);
      assert.equal(message.args.includes(preload), name === '@paperclipai/plugin-kubernetes');
    }
  } finally {
    delete process.env.PAPERCLIP_TEST_PARENT_SECRET;
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

for (const oldVersion of ['2026.707.0', '2026.1001.0']) {
  test(`readiness upgrades ${oldVersion} and preserves a user's agent model`, async () => {
    let plugin = {id:'synthetic-plugin', pluginKey:'paperclip.kubernetes-sandbox-provider', version:oldVersion, status:'ready'};
    const installs = [];
    const updates = [];
    const server = http.createServer(async (req, res) => {
      let payload = '';
      for await (const chunk of req) payload += chunk;
      let body;
      if (req.url === '/api/plugins/install') {
        installs.push(JSON.parse(payload));
        plugin = {...plugin, version:installs.at(-1).version};
        body = plugin;
      } else if (req.url === '/api/plugins') body = [plugin];
      else if (req.url === '/api/health') body = {status:'ok'};
      else if (req.url === '/api/adapters') body = [{type:'opencode_local', disabled:false}];
      else if (req.url === '/api/companies') body = [{id:'fixture-company'}];
      else if (req.url.endsWith('/agents')) body = [{id:'fixture-agent', adapterType:'opencode_local', adapterConfig:{model:'litellm/user-selected', bootstrapPromptTemplate:'My instructions'}, desiredSkills:[]}];
      else if (req.method === 'PATCH') {updates.push(JSON.parse(payload)); body = {id:'fixture-agent'};}
      else if (req.url.endsWith('/heartbeat-runs')) body = [];
      else {res.writeHead(404); res.end(); return;}
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body));
    });
    await new Promise(resolve => server.listen(3100, '127.0.0.1', resolve));
    const template = fs.readFileSync(path.join(chart, 'templates/instance.yaml'), 'utf8');
    const marker = '        - |\n          const fs = require("fs");\n';
    const script = 'const fs = require("fs");\n' + template.split(marker)[1].split('\n      env:')[0]
      .split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
    const child = spawn(process.execPath, ['-e', script], {env:{PATH:process.env.PATH, POD_IP:'127.0.0.2', PAPERCLIP_INSTANCE_NAME:'fixture', PAPERCLIP_DEFAULT_OPENCODE_MODEL:'litellm/default-chat'}, stdio:['ignore','pipe','pipe']});
    let log = '';
    child.stdout.on('data', chunk => {log += chunk;});
    child.stderr.on('data', chunk => {log += chunk;});
    try {
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => {clearInterval(poll); reject(new Error(log));}, 8000);
        const poll = setInterval(() => {
          if (log.includes('gateway proxy listening')) {clearInterval(poll); clearTimeout(deadline); resolve();}
        }, 20);
      });
      assert.equal(installs.length, oldVersion === '2026.1001.0' ? 0 : 1);
      if (installs.length) assert.deepEqual(installs[0], {packageName:'@paperclipai/plugin-kubernetes', version:'2026.1001.0', isLocalPath:false});
      assert.equal(updates.length, 1);
      assert.equal(updates[0].adapterConfig.model, 'litellm/user-selected');
      assert.match(updates[0].adapterConfig.bootstrapPromptTemplate, /My instructions/);
    } finally {
      child.kill(); await once(child, 'exit');
      await new Promise(resolve => server.close(resolve));
    }
  });
}
