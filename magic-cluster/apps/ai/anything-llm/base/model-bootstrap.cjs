// SPDX-License-Identifier: BUSL-1.1
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
class BootstrapError extends Error {}

function modelDefaults(chat, embedding, saved, env) {
  const defaults = {
    LLM_PROVIDER: env.LLM_PROVIDER || 'litellm',
    EMBEDDING_ENGINE: env.EMBEDDING_ENGINE || 'litellm',
    VECTOR_DB: env.VECTOR_DB || 'qdrant',
    WHISPER_PROVIDER: env.WHISPER_PROVIDER || 'local',
    TTS_PROVIDER: env.TTS_PROVIDER || 'native',
  };
  const provider = saved.LLM_PROVIDER || defaults.LLM_PROVIDER;
  if (provider === 'litellm') {
    const modelId = saved.LITE_LLM_MODEL_PREF || chat.defaultModel;
    const selected = (chat.models || []).find((model) => model.id === modelId);
    if (!saved.LITE_LLM_MODEL_PREF && !selected) {
      throw new BootstrapError('A catalogued default chat model is required for a new LiteLLM configuration');
    }
    defaults.LITE_LLM_MODEL_PREF = modelId;
    defaults.LITE_LLM_MODEL_TOKEN_LIMIT = String(
      Number.isSafeInteger(selected?.contextWindow) && selected.contextWindow > 0
        ? selected.contextWindow : 4096
    );
  }
  if ((saved.EMBEDDING_ENGINE || defaults.EMBEDDING_ENGINE) === 'litellm'
      && (embedding.models || []).some((model) => model.id === embedding.defaultModel)) {
    defaults.EMBEDDING_MODEL_PREF = embedding.defaultModel;
  }
  // Existing preferences, including an unavailable selected model, remain
  // explicit user intent. In particular, never switch an embedding index.
  return Object.fromEntries(Object.entries(defaults).filter(
    ([key, value]) => !saved[key] && value !== undefined && value !== ''
  ));
}

function seed({ storageDir = process.env.STORAGE_DIR, catalogDir = '/catalog',
                env = process.env, parse } = {}) {
  if (!storageDir) throw new BootstrapError('STORAGE_DIR is required');
  const parseEnv = parse || createRequire('/app/server/package.json')('dotenv').parse;
  const filename = path.join(storageDir, 'anythingllm.env');
  fs.mkdirSync(storageDir, { recursive: true });
  const original = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';
  // This managed credential always comes from the instance Secret. Remove
  // persisted copies (including the pre-upgrade master key) on every start.
  const previous = original.replace(/^[ \t]*(?:export[ \t]+)?LITE_LLM_API_KEY[ \t]*=[ \t]*(?:"(?:\\.|[^"\\])*"|'[^']*'|`[^`]*`|[^\r\n]*)(?:[ \t]*#[^\r\n]*)?(?:\r?\n|$)/gm, '');
  const saved = parseEnv(previous);
  const chat = JSON.parse(fs.readFileSync(path.join(catalogDir, 'chat-models.json'), 'utf8'));
  const embedding = JSON.parse(fs.readFileSync(path.join(catalogDir, 'embedding-models.json'), 'utf8'));
  const missing = modelDefaults(chat, embedding, saved, env);
  const additions = Object.entries(missing).map(([key, value]) => {
    // Model ids become dotenv values, never executable shell input.
    if (typeof value !== 'string' || /[\r\n\0"\\]/.test(value)) {
      throw new BootstrapError('Invalid catalog value for ' + key);
    }
    return key + '=' + JSON.stringify(value);
  });
  if (!fs.existsSync(filename) || additions.length || original !== previous) {
    const separator = previous && !previous.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(filename, previous + separator + additions.join('\n') + '\n', { mode: 0o600 });
  }
  fs.chmodSync(filename, 0o600);
  return Object.keys(missing);
}

module.exports = { modelDefaults, seed };
if (require.main === module) {
  try {
    seed();
    console.log('AnythingLLM persistent settings initialized; existing preferences retained');
  } catch (error) {
    // No dotenv values, credentials or parse-error excerpts enter logs.
    console.error('AnythingLLM model bootstrap failed: '
      + (error instanceof BootstrapError ? error.message : error.name));
    process.exitCode = 1;
  }
}
