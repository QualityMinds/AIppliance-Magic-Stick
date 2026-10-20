// SPDX-License-Identifier: BUSL-1.1
// Run inside the pinned AnythingLLM image, with seeded /app/server/storage
// and anythingllm.env mounted at /app/server/.env. No real model is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const nativeRequire = createRequire('/app/server/package.json');

async function main() {
  nativeRequire('dotenv').config({ path: '/app/server/.env' });
  const selected = process.argv[2] === 'preserved';
  const expected = selected ? 'selected-chat' : 'default-chat';
  assert.equal(process.env.LITE_LLM_MODEL_PREF, expected);
  assert.equal(process.env.LITE_LLM_MODEL_TOKEN_LIMIT, selected ? '12000' : '8192');
  assert.equal(process.env.EMBEDDING_MODEL_PREF, selected ? 'selected-embedding' : 'default-embedding');

  const requests = [];
  const server = http.createServer(async (request, response) => {
    let input = '';
    for await (const chunk of request) input += chunk;
    const body = JSON.parse(input);
    requests.push({ path: request.url, body, authorization: request.headers.authorization });
    if (request.url === '/embeddings') {
      const vector = [0.25, 0.5, 0.75];
      const embedding = body.encoding_format === 'base64'
        ? Buffer.from(Float32Array.from(vector).buffer).toString('base64') : vector;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ object: 'list', data: [
        { object: 'embedding', index: 0, embedding },
      ], usage: { prompt_tokens: 1, total_tokens: 1 } }));
    } else if (request.url === '/chat/completions' && body.stream) {
      response.setHeader('Content-Type', 'text/event-stream');
      response.end('data: ' + JSON.stringify({
        id: 'synthetic-stream', object: 'chat.completion.chunk', created: 1, model: expected,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture response' }, finish_reason: null }],
      }) + '\n\ndata: [DONE]\n\n');
    } else if (request.url === '/chat/completions') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ id: 'synthetic-chat', object: 'chat.completion',
        created: 1, model: expected, choices: [{ index: 0,
          message: { role: 'assistant', content: 'fixture response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    // Managed connections are supplied separately from editable preferences.
    process.env.LITE_LLM_BASE_PATH = 'http://127.0.0.1:' + server.address().port;
    process.env.LITE_LLM_API_KEY = 'synthetic-runtime-key';
    const { LiteLLM } = nativeRequire('./utils/AiProviders/liteLLM');
    const { LiteLLMEmbedder } = nativeRequire('./utils/EmbeddingEngines/liteLLM');
    const adapter = new LiteLLM(new LiteLLMEmbedder());
    const messages = [{ role: 'user', content: 'Synthetic runtime check' }];
    assert.equal(adapter.promptWindowLimit(), selected ? 12000 : 8192);
    assert.equal((await adapter.getChatCompletion(messages)).textResponse, 'fixture response');
    const stream = await adapter.streamGetChatCompletion(messages);
    let streamed = '';
    for await (const chunk of stream) streamed += chunk.choices?.[0]?.delta?.content || '';
    assert.equal(streamed, 'fixture response');
    assert.deepEqual(await adapter.embedTextInput('Synthetic embedding check'), [0.25, 0.5, 0.75]);
    assert.deepEqual(requests.map(({ path }) => path),
      ['/chat/completions', '/chat/completions', '/embeddings']);
    assert(requests.every(({ authorization }) => authorization === 'Bearer synthetic-runtime-key'));
    assert(requests.slice(0, 2).every(({ body }) => body.model === expected));
    assert.equal(requests[2].body.model, process.env.EMBEDDING_MODEL_PREF);

    if (!selected) {
      // This is the same native writer used after a settings change in the GUI.
      process.env.LITE_LLM_MODEL_PREF = 'selected-chat';
      process.env.LITE_LLM_MODEL_TOKEN_LIMIT = '12000';
      process.env.EMBEDDING_MODEL_PREF = 'selected-embedding';
      nativeRequire('./utils/helpers/updateENV').dumpENV();
      const saved = nativeRequire('dotenv').parse(fs.readFileSync('/app/server/.env'));
      assert.equal(saved.LITE_LLM_MODEL_PREF, 'selected-chat');
      assert.equal(saved.LITE_LLM_MODEL_TOKEN_LIMIT, '12000');
      assert.equal(saved.EMBEDDING_MODEL_PREF, 'selected-embedding');
    }
    console.log('AnythingLLM native chat, SSE, embedding and ' +
      (selected ? 'recreated-container preferences' : 'settings persistence') + ' verified with synthetic responses');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
