import {test, expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {recordedApi} from '../fixtures/api-client.ts';

test('LOG-01 [p1:logs-contract] shared API uses the bounded logs endpoint and preserves stream metadata', async () => {
  const payload = {model: 'fixture-cpu', tailLines: 300, pods: [{name: 'fixture-pod', containers: [{name: 'server', kind: 'application', logs: [{previous: false, text: 'ready'}]}]}]};
  const {api, requests} = recordedApi(payload); expect(await api.modelLogs('fixture-cpu')).toEqual(payload);
  expect(requests[0]?.path).toBe('/api/models/fixture-cpu/logs'); expect(requests[0]?.init.method).toBe('GET');
});

function backendLogContracts() {
  // Existing owning Python tests execute the actual backend extracted from its YAML.
  // stdio stays private; SafeReporter never includes subprocess diagnostics.
  execFileSync('python3', ['-m', 'unittest', 'test_model_logs.ModelLogsTests'], {
    cwd: resolve('../../../magic-cluster/apps/dashboard'), timeout: 60_000, stdio: 'pipe', maxBuffer: 512 * 1024,
  });
}

test('LOG-05 [p1:log-transport-contract] actual backend uses Accept */* only for Kubernetes logs', () => {
  backendLogContracts();
});
test('LOG-06 [p1:log-sanitization-contract] actual backend strips ANSI/control bytes and bounds unavailable streams', () => {
  backendLogContracts();
});
