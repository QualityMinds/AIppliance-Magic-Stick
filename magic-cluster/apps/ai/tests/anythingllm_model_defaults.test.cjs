// SPDX-License-Identifier: BUSL-1.1
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { modelDefaults, seed } = require('../anything-llm/base/model-bootstrap.cjs');

const chat = { defaultModel: 'default-chat', models: [
  { id: 'default-chat', contextWindow: 8192 },
  { id: 'selected-chat', contextWindow: 32768 },
] };
const embedding = { defaultModel: 'default-embedding', models: [{ id: 'default-embedding' }] };

test('new AnythingLLM installations receive real chat, context and embedding defaults', () => {
  assert.deepEqual(modelDefaults(chat, embedding, {}, {}), {
    LLM_PROVIDER: 'litellm', EMBEDDING_ENGINE: 'litellm', VECTOR_DB: 'qdrant',
    WHISPER_PROVIDER: 'local', TTS_PROVIDER: 'native',
    LITE_LLM_MODEL_PREF: 'default-chat', LITE_LLM_MODEL_TOKEN_LIMIT: '8192',
    EMBEDDING_MODEL_PREF: 'default-embedding',
  });
});

test('user model, context, provider and embedding choices are not overwritten', () => {
  const saved = { LLM_PROVIDER: 'litellm', LITE_LLM_MODEL_PREF: 'selected-chat',
    LITE_LLM_MODEL_TOKEN_LIMIT: '12000', EMBEDDING_MODEL_PREF: 'indexed-embedding' };
  const defaults = modelDefaults(chat, embedding, saved, {});
  assert.equal(defaults.LITE_LLM_MODEL_PREF, undefined);
  assert.equal(defaults.LITE_LLM_MODEL_TOKEN_LIMIT, undefined);
  assert.equal(defaults.EMBEDDING_MODEL_PREF, undefined);
  assert.equal(saved.LITE_LLM_MODEL_PREF, 'selected-chat');
  assert.equal(modelDefaults(chat, embedding, { LLM_PROVIDER: 'anthropic' }, {}).LITE_LLM_MODEL_PREF, undefined);
});

test('missing context uses the selected model metadata and conservative unknown limits', () => {
  assert.equal(modelDefaults(chat, embedding, { LITE_LLM_MODEL_PREF: 'selected-chat' }, {})
    .LITE_LLM_MODEL_TOKEN_LIMIT, '32768');
  assert.equal(modelDefaults(chat, embedding, { LITE_LLM_MODEL_PREF: 'removed-model' }, {})
    .LITE_LLM_MODEL_TOKEN_LIMIT, '4096');
  assert.equal(modelDefaults(chat, embedding, { LITE_LLM_MODEL_PREF: 'removed-model' }, {})
    .LITE_LLM_MODEL_PREF, undefined);
});

test('a fresh LiteLLM configuration rejects an unavailable default chat model', () => {
  assert.throws(() => modelDefaults({ defaultModel: 'missing', models: [] }, embedding, {}, {}),
    /catalogued default chat model/);
});

test('catalog changes preserve complete existing dotenv content, secrets and unrelated settings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anythingllm-defaults-test-'));
  try {
    const filename = path.join(directory, 'anythingllm.env');
    const previous = '# native settings\nLITE_LLM_MODEL_PREF="selected-chat"\n'
      + 'LITE_LLM_MODEL_TOKEN_LIMIT="12000"\nEMBEDDING_MODEL_PREF="indexed-embedding"\n'
      + 'AUTH_TOKEN="synthetic-test-token"\n';
    fs.writeFileSync(filename, previous);
    fs.writeFileSync(path.join(directory, 'chat-models.json'), JSON.stringify(chat));
    fs.writeFileSync(path.join(directory, 'embedding-models.json'), JSON.stringify(embedding));
    // Parsing is supplied by upstream dotenv in the runtime. This fixture
    // isolates persistence from that third-party dependency.
    const parse = () => ({ LITE_LLM_MODEL_PREF: 'selected-chat', LITE_LLM_MODEL_TOKEN_LIMIT: '12000',
      EMBEDDING_MODEL_PREF: 'indexed-embedding', AUTH_TOKEN: 'synthetic-test-token',
      LLM_PROVIDER: 'litellm', EMBEDDING_ENGINE: 'litellm', VECTOR_DB: 'qdrant',
      WHISPER_PROVIDER: 'local', TTS_PROVIDER: 'native' });
    const written = seed({ storageDir: directory, catalogDir: directory, env: {}, parse });
    assert.deepEqual(written, []);
    assert.equal(fs.readFileSync(filename, 'utf8'), previous);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('invalid catalog values do not modify an existing settings file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anythingllm-invalid-test-'));
  try {
    const filename = path.join(directory, 'anythingllm.env');
    fs.writeFileSync(filename, '# retain existing settings\n');
    fs.writeFileSync(path.join(directory, 'chat-models.json'), JSON.stringify({
      defaultModel: 'bad\nVALUE=injected', models: [{ id: 'bad\nVALUE=injected' }],
    }));
    fs.writeFileSync(path.join(directory, 'embedding-models.json'), JSON.stringify(embedding));
    assert.throws(() => seed({ storageDir: directory, catalogDir: directory, env: {}, parse: () => ({}) }),
      /Invalid catalog value/);
    assert.equal(fs.readFileSync(filename, 'utf8'), '# retain existing settings\n');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('startup removes every saved managed credential while preserving model preferences', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anythingllm-key-migration-'));
  try {
    const filename = path.join(directory, 'anythingllm.env');
    fs.writeFileSync(filename, '# retained\nLITE_LLM_MODEL_PREF="selected-chat"\n'
      + 'LITE_LLM_API_KEY="synthetic-old-master"\nexport LITE_LLM_API_KEY=synthetic-duplicate\n'
      + 'AUTH_TOKEN="synthetic-unrelated"\n');
    fs.writeFileSync(path.join(directory, 'chat-models.json'), JSON.stringify(chat));
    fs.writeFileSync(path.join(directory, 'embedding-models.json'), JSON.stringify(embedding));
    seed({ storageDir: directory, catalogDir: directory, env: {},
      parse: (text) => Object.fromEntries([...text.matchAll(/^(\w+)="?([^"\n]+)"?$/gm)]
        .map((match) => [match[1], match[2]])) });
    const text = fs.readFileSync(filename, 'utf8');
    assert(!text.includes('LITE_LLM_API_KEY'));
    assert(text.includes('LITE_LLM_MODEL_PREF="selected-chat"'));
    assert(text.includes('AUTH_TOKEN="synthetic-unrelated"'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('service selections seed their own chat, context and embedding defaults', () => {
  const embeddings = {...embedding, models: [...embedding.models, {id: 'selected-embedding'}]};
  const result = modelDefaults(chat, embeddings, {}, {
    MAGICSTICK_INITIAL_CHAT_MODEL: 'selected-chat', MAGICSTICK_INITIAL_EMBEDDING_MODEL: 'selected-embedding',
  });
  assert.equal(result.LITE_LLM_MODEL_PREF, 'selected-chat');
  assert.equal(result.LITE_LLM_MODEL_TOKEN_LIMIT, '32768');
  assert.equal(result.EMBEDDING_MODEL_PREF, 'selected-embedding');
});

test('stale or wrong-task service choices reject initialization instead of silently falling back', () => {
  for (const env of [
    {MAGICSTICK_INITIAL_CHAT_MODEL: 'removed'},
    {MAGICSTICK_INITIAL_CHAT_MODEL: 'default-embedding'},
    {MAGICSTICK_INITIAL_EMBEDDING_MODEL: 'removed'},
    {MAGICSTICK_INITIAL_EMBEDDING_MODEL: 'default-chat'},
  ]) assert.throws(() => modelDefaults(chat, embedding, {}, env), /catalog/);
});

test('changed service defaults never replace saved choices or an existing embedding index', () => {
  const saved = {LITE_LLM_MODEL_PREF: 'removed-chat', EMBEDDING_MODEL_PREF: 'indexed-embedding',
    LITE_LLM_MODEL_TOKEN_LIMIT: '12000'};
  const result = modelDefaults(chat, embedding, saved, {
    MAGICSTICK_INITIAL_CHAT_MODEL: 'different-unavailable-chat', MAGICSTICK_INITIAL_EMBEDDING_MODEL: 'different-unavailable-embedding',
  });
  assert.equal(result.LITE_LLM_MODEL_PREF, undefined);
  assert.equal(result.EMBEDDING_MODEL_PREF, undefined);
  assert.equal(result.LITE_LLM_MODEL_TOKEN_LIMIT, undefined);
});
