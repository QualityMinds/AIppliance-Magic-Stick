import {test} from '@playwright/test';
import {evidenceAnnotations} from '../core/evidence.ts';
import {componentSuite} from './owning.ts';

test('NAV-03 [p1:navigation-component] owning App component suite proves non-mutating navigation', () =>
  componentSuite('src/App.test.tsx', ['shows power controls only inside the selected Computer power tab']));
test('LIFE-03 LIFE-04 owning component lifecycle uses the CPU/Ollama saved settings', evidenceAnnotations(
  {id: 'LIFE-03', variant: 'lifecycle-stop-component', layer: 'U'}, {id: 'LIFE-04', variant: 'lifecycle-start-component', layer: 'U'}), () =>
  componentSuite('src/ModelLifecycle.test.tsx', ['stops and starts OLlama on cpu without deleting or changing its settings']));
test('KEY-01 KEY-03 owning named-key component clears the secret and selects the exact revoked ID', evidenceAnnotations(
  {id: 'KEY-01', variant: 'key-create-component', layer: 'U'}, {id: 'KEY-03', variant: 'key-revoke-component', layer: 'U'}), () =>
  componentSuite('src/pages/ApiAccessPage.test.tsx', ['creates a one-time key, clears its secret and revokes only the selected metadata ID']));
test('LOG-01 LOG-06 owning log component preserves bounded streams and inert output', evidenceAnnotations(
  {id: 'LOG-01', variant: 'logs-component', layer: 'U'}, {id: 'LOG-06', variant: 'logs-inert-component', layer: 'U'}), () =>
  componentSuite('src/ModelLogs.test.tsx', ['opens bounded current and previous Pod output', 'renders HTML-like long log output as inert text']));
test('UX-02 [p1:forms-component] owning CPU/Ollama edit component protects the unsaved draft', () =>
  componentSuite('src/pages/ModelDraft.test.tsx', ['CPU Ollama draft starts collapsed, survives polling']));
