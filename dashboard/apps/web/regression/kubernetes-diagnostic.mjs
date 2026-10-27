// Distinct entrypoint fails closed when an older pinned image is installed.
import {diagnosticSelection} from './core/diagnostic-selection.ts';
if(!process.env.REGRESSION_DIAGNOSTIC_SELECTION)throw new Error('Missing diagnostic selection.');
diagnosticSelection(process.env.REGRESSION_DIAGNOSTIC_SELECTION,
  (process.env.REGRESSION_PHASES??'').split(',').map(Number),process.env.REGRESSION_TEST_MODE,process.env.REGRESSION_OPERATION??'tests');
await import('./kubernetes.mjs');
