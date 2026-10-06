import {readFileSync, realpathSync} from 'node:fs';
import {sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {requireSafe} from './errors.ts';
import type {TestLayer} from './evidence.ts';

/** Goals come from the public catalogue, never a live test title or response.
 * A goal describes a case family; only the reported variant/layer was executed. */
export function parseCaseDescriptions(markdown: string): Readonly<Record<string, string>> {
  const descriptions: Record<string, string> = {};
  for (const match of markdown.matchAll(/^\| ([A-Z][A-Z0-9]+-\d{2}) \| ([^\r\n]+?) \| [UCBAEON+]+ \| P[012][^\r\n]*\|\s*$/gm)) {
    const id = match[1]!, description = match[2]!.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
    requireSafe(!Object.hasOwn(descriptions, id) && description.length > 0 && description.length <= 2000 &&
      !/[\x00-\x1f\x7f-\x9f]/.test(description), 'CONFIG');
    descriptions[id] = description;
  }
  requireSafe(Object.keys(descriptions).length > 0, 'CONFIG');
  return Object.freeze(descriptions);
}

function loadCaseDescriptions() {
  try {
    return parseCaseDescriptions(readFileSync(new URL('../../../../../docs/development/regression-test-catalog.md', import.meta.url), 'utf8'));
  } catch { requireSafe(false, 'CONFIG'); }
}

export const caseDescriptions = loadCaseDescriptions();
export function caseDescription(id: string): string {
  return caseDescriptions[id] ?? 'No description is available in the public test catalogue.';
}

/** Only literal, reviewed scenario names in public test source may be printed.
 * Interpolated/generated titles might contain model names or private values. */
export function staticScenarioTitles(source: string): ReadonlySet<string> {
  const titles = new Set<string>();
  // Intentionally accept only simple source literals. Escaped, concatenated or
  // interpolated expressions fall back to the catalogue, without evaluating JS.
  for (const match of source.matchAll(/^[ \t]*test\(\s*(?:'([^'\\\r\n]*)'|"([^"\\\r\n]*)"|`([^`\\\r\n]*)`)\s*,/gm)) {
    const title = match[1] ?? match[2] ?? match[3]!;
    if (title.length <= 500 && !title.includes('${') && !/[\x00-\x1f\x7f-\x9f]/.test(title)) titles.add(title);
  }
  return titles;
}

const sourceTitles = new Map<string, ReadonlySet<string>>();
const regressionSource = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
export function publicScenarioTitle(runtimeTitle: string, sourceFile: string): string | undefined {
  try {
    const file = realpathSync(sourceFile);
    if (!file.startsWith(regressionSource + sep) || !/\.(?:spec|cases)\.ts$/.test(file)) return undefined;
    let titles = sourceTitles.get(file);
    if (!titles) { titles = staticScenarioTitles(readFileSync(file, 'utf8')); sourceTitles.set(file, titles); }
    return [...titles].find(title => title === runtimeTitle);
  } catch { return undefined; }
}

export const layerDescriptions: Record<TestLayer, string> = {
  U: 'unit/component', C: 'API/render contract', B: 'fixture browser',
  A: 'live API/integration', E: 'live browser and independent observations',
  O: 'approved operational test', N: 'non-functional test',
};

export function durationDescription(durationMs: number): string {
  const seconds = Number.isFinite(durationMs) ? Math.max(0, durationMs) / 1000 : 0;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
}

const modeDescriptions: Record<string, string> = {
  selftest: 'Harness safety, input preparation and reporting; isolated fixtures only.',
  preflight: 'Verify HTTPS, login, appliance identity, deployed versions and idle state; read-only.',
  locktest: 'Verify exclusive lab locking, revision conflicts and current-generation polling.',
  foundations: 'Exercise safety faults, owned-resource cleanup and interrupted-run recovery.',
  'smoke-fast': 'Check authentication, keys, model lifecycle, status and logs at their owning unit/contract layer.',
  'smoke-fixtures': 'Check navigation, sessions, keys, model forms and logs in an isolated browser.',
  'session-smoke': 'Check real sign-in, unauthenticated access and sign-out.',
  'core-smoke': 'Check an owned CPU/Ollama model, dashboard controls, keys, logs and routed inference.',
  'phase2-readonly': 'Check model discovery through the installed API and dashboard; no product writes.',
  'phase2-models': 'Check owned CPU Ollama/vLLM and external-provider models, memory admission, editing and lifecycle.',
  'phase2-faults': 'Check a deliberately failing owned model and its actionable API/dashboard status.',
  'phase3-gpu': 'Check supported exclusive AMD/NVIDIA runtimes, physical binding, memory, logs and inference.',
  'phase3-validation': 'Check optional engine validation and its real GPU consumer.',
  'phase4-sharing': 'Check AMD DRA/NVIDIA time-slicing, concurrent models, slot exhaustion and restoration.',
};

export function modeDescription(mode: string): string {
  if (Object.hasOwn(modeDescriptions, mode)) return modeDescriptions[mode]!;
  if (/^phase[2-8]-fast$/.test(mode)) return 'Run the selected owning unit/component and contract checks; no appliance access.';
  if (/^phase[2-8]-fixtures$/.test(mode)) return 'Run the selected isolated browser checks; no appliance acceptance.';
  if (/^phase[5-8]-live$/.test(mode)) return 'Run the selected installed-appliance API/browser workflows with approved prerequisites and cleanup.';
  return 'Run the explicitly selected regression checks; missing prerequisites remain blocking.';
}
