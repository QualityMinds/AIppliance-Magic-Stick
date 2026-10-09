// SPDX-License-Identifier: BUSL-1.1
// Run in the digest-pinned official OpenCode sandbox image with networking
// disabled and a generated paperclip-opencode-providers.json as argv[2].
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-opencode-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    if (req.url !== '/v1/chat/completions') {res.writeHead(404); res.end(); return;}
    const body = JSON.parse(data);
    requests.push({authorization:req.headers.authorization,body});
    const reply = {id:'synthetic-completion',object:'chat.completion.chunk',created:1,model:'synthetic-chat',choices:[{index:0,delta:{content:'Synthetic response.'},finish_reason:null}]};
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(`data: ${JSON.stringify(reply)}\n\ndata: ${JSON.stringify({...reply,choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    config.provider.litellm.options.baseURL = `http://127.0.0.1:${server.address().port}/v1`;
    const filename = path.join(directory, 'opencode.json');
    fs.writeFileSync(filename, JSON.stringify({...config,model:'litellm/synthetic-chat',small_model:'litellm/synthetic-chat',autoupdate:false}));
    const env = {...process.env,OPENAI_API_KEY:'synthetic-litellm-key',OPENCODE_CONFIG:filename,
      OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',
      OPENCODE_DISABLE_AUTOUPDATE:'true',XDG_CONFIG_HOME:directory,XDG_DATA_HOME:directory,XDG_CACHE_HOME:directory};
    assert.equal(execFileSync('opencode',['--version'],{env,encoding:'utf8'}).trim(), '1.18.21');
    assert.match(execFileSync('opencode',['models','litellm'],{env,encoding:'utf8',timeout:20000}), /litellm\/synthetic-chat/);
    const spec = path.join(directory, 'runtime-command.json');
    fs.writeFileSync(spec, JSON.stringify({command:'node',args:['-e','console.log(process.env.PAPERCLIP_API_URL)']}));
    assert.equal(execFileSync('/usr/local/bin/paperclip-agent-shim',['-spec',spec],{env:{...env,PAPERCLIP_API_URL:'http://synthetic-callback:3100'},encoding:'utf8'}).trim(), 'http://synthetic-callback:3100');
    const child = spawn('opencode',['run','--format','json','--model','litellm/synthetic-chat','Reply with one sentence.'],{env,cwd:directory,stdio:['ignore','pipe','pipe']});
    let output = '';
    child.stdout.on('data', b => {output += b;});
    child.stderr.on('data', b => {output += b;});
    const timeout = setTimeout(() => child.kill('SIGKILL'), 45000);
    const code = await new Promise((resolve,reject) => {child.once('exit',resolve); child.once('error',reject);});
    clearTimeout(timeout);
    assert.equal(code, 0, output);
    assert.match(output, /Synthetic response/);
    assert.ok(requests.length > 0);
    for (const request of requests) {
      assert.equal(request.authorization, 'Bearer synthetic-litellm-key');
      assert.equal(request.body.model, 'synthetic-chat');
      assert.equal(request.body.stream, true);
    }
    console.log('Paperclip OpenCode native model, LiteLLM request and shim checks passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory,{recursive:true,force:true});
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
