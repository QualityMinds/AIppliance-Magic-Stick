// SPDX-License-Identifier: BUSL-1.1
import {mkdir, readFile, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export async function prepare({agentDir, workspace, modelsPath, selectedModel}) {
  const catalog = JSON.parse(await readFile(modelsPath, 'utf8'));
  const model = catalog.providers?.litellm?.models?.find(item => item.id === selectedModel);
  if (!model) throw new Error('The selected chat model is unavailable. Start it in Models or choose an available model.');
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0
    || !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) {
    throw new Error('The selected chat model has invalid token limits.');
  }
  await mkdir(agentDir, {recursive: true, mode: 0o700});
  await mkdir(workspace, {recursive: true});
  const settingsPath = join(agentDir, 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Unable to read existing Pi settings.json. Repair the settings before restarting.');
  }
  // Preserve user settings and sessions; only the managed model and its budgets change.
  settings.defaultProvider = 'litellm';
  settings.defaultModel = selectedModel;
  settings.compaction = {
    ...settings.compaction,
    reserveTokens: Math.min(model.maxTokens, Math.max(1, Math.floor(model.contextWindow / 4))),
    keepRecentTokens: Math.min(20000, Math.max(1, Math.floor(model.contextWindow / 4))),
    modelOverrides: {
      ...settings.compaction?.modelOverrides,
      ...Object.fromEntries(catalog.providers.litellm.models.map(item => [`litellm/${item.id}`, {
        reserveTokens: Math.min(item.maxTokens, Math.max(1, Math.floor(item.contextWindow / 4))),
        keepRecentTokens: Math.min(20000, Math.max(1, Math.floor(item.contextWindow / 4))),
      }])),
    },
  };
  await writeFile(`${settingsPath}.tmp`, JSON.stringify(settings, null, 2) + '\n', {mode: 0o600});
  await rename(`${settingsPath}.tmp`, settingsPath);
  // Pi reloads this file through /model. The projected catalog can update in place.
  await rm(join(agentDir, 'models.json'), {force: true});
  await symlink(modelsPath, join(agentDir, 'models.json'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const model = (process.env.PI_MODEL || '').replace(/^(litellm|openai)\//, '');
  if (!process.env.LITELLM_API_KEY) {
    console.error('The LiteLLM runtime credential is unavailable.');
    process.exitCode = 1;
  } else {
    prepare({agentDir: process.env.PI_CODING_AGENT_DIR, workspace: process.env.PI_WORKSPACE,
      modelsPath: '/catalog/pi-models.json', selectedModel: model}).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
