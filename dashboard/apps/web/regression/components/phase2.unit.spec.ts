import {test} from '@playwright/test';
import {evidenceAnnotations} from '../core/evidence.ts';
import {componentSuite} from './owning.ts';

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

test('MEM-01 owning model UI renders the estimator breakdown independently of download size', evidenceAnnotations(
  {id: 'MEM-01', variant: 'memory-component', layer: 'U'}), () => componentSuite(
  'src/FeatureParity.test.tsx',
  ['Models restores model-source controls, memory planning and registered models'],
));
