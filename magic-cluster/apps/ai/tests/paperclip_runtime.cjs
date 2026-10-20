// SPDX-License-Identifier: BUSL-1.1
// Run inside the pinned Paperclip release filesystem with the exact npm plugin
// and its dependencies installed. All Kubernetes responses and keys are local
// fixtures; this checks the real plugin/client/exec contract, not a live cluster.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {pathToFileURL} = require('node:url');
const {spawn, execFileSync} = require('node:child_process');

async function main() {
  const packageRoot = process.argv[2];
  const preload = process.argv[3] || '/etc/magicstick-paperclip/runtime-preload.cjs';
  require(preload);
  const packageRequire = createRequire(path.join(packageRoot, 'package.json'));
  const {WebSocketServer} = packageRequire('ws');
  const plugin = (await import(pathToFileURL(path.join(packageRoot, 'dist/plugin.js')))).default.definition;
  const manifestModule = await import(pathToFileURL(path.join(packageRoot, 'dist/manifest.js')));
  const manifest = manifestModule.default || manifestModule.manifest;
  assert.equal(manifest.version, '2026.1001.0');
  const {buildPaperclipEnv} = await import('/app/packages/adapter-utils/src/server-utils.ts');
  process.env.PAPERCLIP_API_URL = 'http://paperclip-check.ai.svc.cluster.local:3100';
  process.env.PAPERCLIP_RUNTIME_API_URL = 'https://browser.fixture.test';
  assert.equal(buildPaperclipEnv({id:'fixture-agent',companyId:'fixture-company'}).PAPERCLIP_API_URL,
    'http://paperclip-check.ai.svc.cluster.local:3100');

  const commands = [];
  const tlsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-kube-tls-'));
  const keyFile = path.join(tlsDirectory, 'fixture.key');
  const certFile = path.join(tlsDirectory, 'fixture.crt');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'], {stdio:'ignore'});
  const certificate = fs.readFileSync(certFile);
  const server = https.createServer({key:fs.readFileSync(keyFile),cert:certificate}, (req, res) => {
    if (req.url.includes('/sandboxes/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({metadata:{name:'fixture-sandbox'},status:{podName:'fixture-pod',conditions:[{type:'Ready',status:'True'}]}}));
    } else {res.writeHead(404); res.end();}
  });
  const sockets = new WebSocketServer({noServer:true, handleProtocols: protocols => protocols.has('v4.channel.k8s.io') ? 'v4.channel.k8s.io' : [...protocols][0]});
  server.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head, ws => {
    const command = new URL(req.url, 'http://fixture').searchParams.getAll('command');
    commands.push(command);
    const child = spawn(command[0], command.slice(1), {cwd:'/tmp', env:{PATH:process.env.PATH}, stdio:['ignore','pipe','pipe']});
    child.stdout.on('data', chunk => ws.send(Buffer.concat([Buffer.from([1]), chunk])));
    child.stderr.on('data', chunk => ws.send(Buffer.concat([Buffer.from([2]), chunk])));
    child.on('exit', code => {
      const status = code === 0 ? {status:'Success'} : {status:'Failure',details:{causes:[{reason:'ExitCode',message:String(code)}]}};
      ws.send(Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify(status))]));
    });
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const kubeconfig = JSON.stringify({apiVersion:'v1',kind:'Config',clusters:[{name:'fixture',cluster:{server:`https://127.0.0.1:${server.address().port}`,'certificate-authority-data':certificate.toString('base64')}}],users:[{name:'fixture',user:{token:'synthetic-kubernetes-key'}}],contexts:[{name:'fixture',context:{cluster:'fixture',user:'fixture'}}],'current-context':'fixture'});
  const config = {inCluster:false,kubeconfig,backend:'sandbox-cr',adapterType:'opencode_local'};
  const customCwd = '/tmp/paperclip workspace \' quoted';
  fs.mkdirSync('/workspace', {recursive:true});
  fs.mkdirSync(customCwd, {recursive:true});
  try {
    const realized = await plugin.onEnvironmentRealizeWorkspace({workspace:{remotePath:'/tmp'}});
    assert.equal(realized.cwd, '/workspace');
    assert.equal(realized.metadata.remoteCwd, '/workspace');
    // Environment probes can execute before a workspace has been realized.
    for (const [cwd, remoteCwd] of [['/tmp', realized.cwd], [customCwd, realized.cwd], [undefined, undefined]]) {
      const result = await plugin.onEnvironmentExecute({config,companyId:'fixture-company',lease:{providerLeaseId:'fixture-sandbox',metadata:{backend:'sandbox-cr',namespace:'fixture-namespace',podName:'fixture-pod',remoteCwd}},cwd,command:'sh',args:['-c','printf "%s\\n%s" "$PWD" "$FIXTURE_VALUE"'],env:{FIXTURE_VALUE:"literal ' quote; $(echo forbidden)"},timeoutMs:10000});
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.timedOut, false);
      assert.equal(result.stdout, `${cwd === customCwd ? customCwd : '/workspace'}\nliteral ' quote; $(echo forbidden)`);
    }
    await assert.rejects(() => plugin.onEnvironmentExecute({config,lease:{providerLeaseId:'fixture-sandbox',metadata:{backend:'sandbox-cr',namespace:'fixture-namespace',podName:'fixture-pod',remoteCwd:'/workspace'}},cwd:'relative-path',command:'pwd',timeoutMs:10000}), /absolute path/);
    assert.equal(commands.length, 3);
  } finally {
    sockets.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(customCwd, {recursive:true, force:true});
    fs.rmSync(tlsDirectory, {recursive:true, force:true});
  }
  if (process.env.PAPERCLIP_TEST_SERVER_URL) {
    const base = process.env.PAPERCLIP_TEST_SERVER_URL;
    const health = await fetch(`${base}/api/health`).then(r => r.json());
    assert.equal(health.version, '2026.1001.0');
    assert.equal(health.deploymentMode, 'local_trusted');
    const installed = await fetch(`${base}/api/plugins`).then(r => r.json());
    const kube = installed.find(p => p.pluginKey === 'paperclip.kubernetes-sandbox-provider');
    assert.equal(kube.version, '2026.1001.0');
    assert.equal(kube.status, 'ready');
    // The real parent started the worker through its restricted environment.
    assert.equal(installed.filter(p => p.pluginKey === kube.pluginKey).length, 1);
  }
  console.log('Paperclip native server/plugin compatibility checks passed');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
