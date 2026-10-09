import {test, expect} from '@playwright/test';
import {GpuScenario} from '../core/gpu-scenario.ts';
import {requireSafe} from '../core/errors.ts';
import {poll} from '../core/poll.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {installedReadyUi, logsUi} from './live-ui.ts';
import {matchingNvidiaCards} from '../../src/NvidiaGpuSelection.ts';
import type {GpuModelFixture} from '../core/config.ts';

const phase = process.env.REGRESSION_MODE === 'phase4-sharing' ? 4 : 3;
const mode = phase === 4 ? 'shared' : 'exclusive';
// Reuses the registered lab, Lease, reviewed small models and cleanup journal.
// A lab without enough matching cards remains Blocked, never a synthetic pass.
for (const deployment of ['split', 'replicated'] as const) for (const engine of ['VLLM', 'OLlama'] as const) for (const count of [2, 4]) {
  const replicated=deployment === 'replicated',id=replicated?'MGPU-02':'MGPU-01';
  const variant = `p${phase}-${replicated?'replicated':'multigpu'}-${engine === 'VLLM' ? 'vllm' : 'ollama'}-${count}`;
  test(`${id} ${engine} ${count} GPUs ${deployment} ${mode}: placement, inference, memory, stop/start and restore`, evidenceAnnotations(
    ...(['A', 'E', 'O'] as const).map(layer => ({id, variant, layer}))), async ({browser}, info) => {
    let scenario: GpuScenario | undefined;
    try {
      scenario = await GpuScenario.open(browser, info.workerIndex);
      const s = scenario, fixture = s.config.gpu!.models[engine === 'VLLM' ? 'nvidiaVllm' : 'nvidiaOllama'];
      requireSafe(fixture && (await s.state('nvidia')).draAvailable, 'PREREQUISITE');
      const inventory = await s.inventory();
      requireSafe(inventory.devices.filter(d => d.vendor === 'nvidia').length >= count, 'CAPABILITY');
      await s.transition('nvidia', mode, 2, 'dra');
      const baseline = await s.live.api.models();
      const cards = (baseline.computeMemory?.devices ?? []).filter(d => d.gpuDevice?.nodeUid === s.config.gpu!.nodeUid && d.slots?.scope === 'device');
      const compatible = cards.filter(d => cards[0] && matchingNvidiaCards(cards[0], d)).slice(0, count);
      requireSafe(compatible.length === count && compatible.every(d => d.metricsAvailable && Number(d.freeMi) > 0 && (d.slots?.free ?? 0) > 0), 'CAPABILITY');
      const runtime: GpuModelFixture = {...fixture, gpuDevices: compatible.map(d => d.gpuDevice!), systemMemoryMi: 16400,
        gpuDeployment:deployment, ...(engine === 'VLLM' && !replicated ? {vllm: {parallelism: 'auto'}} : {vllm:undefined})};
      const first = await s.create(`mg${count}-${engine === 'VLLM' ? 'v' : 'o'}`, runtime, true);
      await s.ready(first); // independently resolves every ResourceClaim against current ResourceSlices, then routes inference
      const page = await s.live.context.newPage(); await s.openModels(page); await installedReadyUi(page, first.client.name);
      await logsUi(s, page, first);
      if(replicated) {
        const logs=await first.client.logs(); expect(logs.replicas).toHaveLength(count);
        await Promise.all(Array.from({length:count},()=>s.inference.chat(first.client.name)));
        const entries=((await first.client.models()).models ?? []).filter(m=>m.id === first.client.name); expect(entries).toHaveLength(1);
      }
      await poll(() => s.live.api.models(), payload => compatible.every(before => {
        const after = payload.computeMemory?.devices?.find(d => d.gpuDevice?.uuid === before.gpuDevice!.uuid);
        return after?.metricsAvailable && typeof after.freeMi === 'number' && after.freeMi < Number(before.freeMi) - 32;
      }), {timeoutMs: 120_000, intervalMs: 2000, stage: 'gpu-binding'});
      const assertSlots = async (used: number) => {
        await poll(() => s.live.api.models(), payload => cards.every(before => {
          const after = payload.computeMemory?.devices?.find(d => d.gpuDevice?.uuid === before.gpuDevice!.uuid);
          return after?.slots?.used === (compatible.some(d => d.id === before.id) ? used : 0);
        }), {timeoutMs: 120_000, intervalMs: 1000, stage: 'gpu-slots'});
      };
      await assertSlots(1);
      if (mode === 'shared') {
        const second = await s.create(`mg${count}-peer`, runtime, true); await s.ready(second); await assertSlots(2);
        await Promise.all([s.inference.chat(first.client.name), s.inference.chat(second.client.name)]);
        await s.remove(second); await assertSlots(1);
      }
      await s.lifecycle(first, 'edit'); await assertSlots(1);
      await s.lifecycle(first, 'stop'); await assertSlots(0);
      await s.lifecycle(first, 'start'); await assertSlots(1);
      const saved = (await first.client.models()).activations.find(item => item.metadata?.uid === first.uid);
      expect(saved?.spec?.local?.gpuDevices).toEqual(expect.arrayContaining(runtime.gpuDevices!));
      await s.remove(first); await assertSlots(0);
    } finally {if (scenario) await scenario.close();}
  });
}
