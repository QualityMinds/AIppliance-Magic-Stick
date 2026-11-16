// SPDX-License-Identifier: BUSL-1.1
import {readFile} from 'node:fs/promises';
import {prepare, toolMode} from './prepare.mjs';

try {
  if (!process.env.LITELLM_API_KEY) throw new Error('The LiteLLM runtime credential is unavailable.');
  const model = (process.env.PI_MODEL || '').replace(/^(litellm|openai)\//, '');
  await prepare({agentDir: process.env.PI_CODING_AGENT_DIR, workspace: process.env.PI_WORKSPACE,
    modelsPath: '/catalog/pi-models.json', selectedModel: model});
  if (process.argv.includes('--tool-mode')) {
    const catalog = JSON.parse(await readFile('/catalog/catalog.json', 'utf8'));
    console.log(toolMode(catalog, model));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
