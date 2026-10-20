import {test} from '@playwright/test';
import {evidenceAnnotations} from '../core/evidence.ts';
import {componentSuite} from './owning.ts';

test('DISC-01 model names are validated before local or external creation', evidenceAnnotations(
  {id: 'DISC-01', variant: 'model-name-component', layer: 'U'}), () => componentSuite('src/NvidiaCards.test.tsx', [
    'validates VLLM model names and prevents duplicate or invalid writes',
    'validates OLlama model names and prevents duplicate or invalid writes',
    'uses the same name validation for external providers',
]));

test('ENG-09 shared configuration preserves saved intent and explicit resets', evidenceAnnotations(
  {id: 'ENG-09', variant: 'local-configuration-component', layer: 'U'}), () => componentSuite('src/LocalModelConfigurationCore.test.ts', [
    'preserves unchanged, changed and reverted legacy VLLM settings',
    'preserves unchanged, changed and reverted legacy OLlama settings',
    'keeps GPU identities stable despite reordered fields and changed display names',
]));

test('ENG-07 discovery discards asynchronous results from a previous engine or target', evidenceAnnotations(
  {id: 'ENG-07', variant: 'late-discovery-component', layer: 'U'}), () => componentSuite('src/ModelDiscovery.test.tsx', [
    'discards a late search result after switching engine and retains the common name',
    'discards a late artifact response after changing hardware',
]));

test('DISC-01 ENG-07 owning create form keeps engine and provider drafts isolated', evidenceAnnotations(
  {id: 'DISC-01', variant: 'create-choice-component', layer: 'U'},
  {id: 'ENG-07', variant: 'engine-switch-component', layer: 'U'}), () => componentSuite(
  'src/RealtimeModelForm.test.tsx',
  ['switches between local engines and external providers without leaking Realtime settings'],
));

test('DISC-03 owning discovery applies the selected base metadata to its direct artifact', evidenceAnnotations(
  {id: 'DISC-03', variant: 'hf-search-component', layer: 'U'}), () => componentSuite(
  'src/ModelDiscovery.test.tsx',
  ['uses the selected base model context when its quantization has no context metadata'],
));

test('LIFE-07 MEM-06 owning edit form preserves identity and an in-flight memory draft', evidenceAnnotations(
  {id: 'LIFE-07', variant: 'edit-component', layer: 'U'},
  {id: 'MEM-06', variant: 'slider-component', layer: 'U'}), () => componentSuite(
  'src/ModelEdit.test.tsx',
  ['keeps identity fixed and saves only changed runtime parameters',
    'keeps the memory slider mounted while its changed budget is re-estimated'],
));

test('LIFE-08 owning model draft remains disabled until a valid actual change exists', evidenceAnnotations(
  {id: 'LIFE-08', variant: 'dirty-component', layer: 'U'}), () => componentSuite(
  'src/pages/ModelDraft.test.tsx',
  ['CPU Ollama draft starts collapsed, survives polling and disables unchanged, reverted or invalid saves'],
));

test('ENG-03 MEM-05 owning controls expose supported KV choices and explicit risk semantics', evidenceAnnotations(
  {id: 'ENG-03', variant: 'kv-component', layer: 'U'},
  {id: 'MEM-05', variant: 'risk-component', layer: 'U'}), () => componentSuite(
  'src/Offloading.test.tsx',
  ['offers compatible cache formats and recalculates for the selected value',
    'warns but permits explicit risk acceptance when host RAM cannot be verified'],
));

test('MEM-01 owning model UI renders matching group totals independently of host RAM and download size', evidenceAnnotations(
  {id: 'MEM-01', variant: 'memory-component', layer: 'U'}), async () => {
  await componentSuite('src/FeatureParity.test.tsx', ['Models restores model-source controls, memory planning and registered models']);
  await componentSuite('src/ModelMemorySettings.test.tsx', [
    'shows every vLLM GPU component for the same 2-GPU group as the calculator',
    'shows every vLLM GPU component for the same 4-GPU group as the calculator',
    'keeps Ollama single-device cache components and runtime reserve unchanged',
    'keeps a replicated copy at its full per-copy budget instead of multiplying it twice',
    'sums offloaded shares but reserves host runtime and download only once for a split Pod',
    'separates serving RAM and startup range without multiplying a split Pod by GPUs',
    'preserves saved host RAM and clamps only an explicit recommendation to capacity',
    'shows unknown RAM without offering a fabricated recommendation',
    'shows per-copy host RAM and one explicit combined recommendation for replication',
  ]);
  await componentSuite('src/NvidiaCards.test.tsx', [
    'uses startup RAM defaults for VLLM groups and preserves a manual host budget',
    'uses startup RAM defaults for OLlama groups and preserves a manual host budget',
  ]);
});


test('DISC-01 owning automatic task detection preserves unknown and per-reference manual choices', evidenceAnnotations(
  {id: 'DISC-01', variant: 'model-task-component', layer: 'U'}), () => componentSuite('src/ModelDiscovery.test.tsx', [
    'requires an explicit task when metadata is unknown and discards it for a different model',
]));
