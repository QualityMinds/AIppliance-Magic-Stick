import type {ModelsPayload} from '@magicstick/dashboard-contracts';

/** Public-safe, isolated four-card data. This is not physical GPU evidence. */
export const nvidiaUuids = Array.from({length: 4}, (_, index) => `GPU-00000000-0000-0000-0000-${String(index).padStart(12, '0')}`);
export const nvidiaSelection = (index: number, nodeUid = 'fixture-node-uid') => ({uuid: nvidiaUuids[index]!, nodeName: 'fixture-node', nodeUid});
export function fourNvidiaCards(free = [4, 4, 3, 4], dra = true): ModelsPayload {
  const total = 16, used = free.reduce((sum, value) => sum + 4 - value, 0);
  const pool = {total, used, free: total - used, scope: 'node' as const, node: 'fixture-node'};
  return {activations: [], models: [], presets: {}, computeTargets: {default: 'cpu', engineCatalog: Object.fromEntries(['VLLM', 'OLlama'].map(engine => [engine, {multiGpu: {computeTargets: ['nvidia-gpu'], maxDevices: 16, deploymentModes: ['single', 'split', 'replicated'], strategies: engine === 'VLLM' ? ['auto', 'tensor', 'pipeline'] : ['spread'], memoryBudgetScope: 'per-device' as const}}])), targets: [
    {id: 'cpu', kind: 'cpu', displayName: 'CPU', engines: ['VLLM', 'OLlama'], available: true},
    {id: 'nvidia-gpu', kind: 'gpu', displayName: 'NVIDIA GPU', engines: ['VLLM', 'OLlama'], available: true, slots: pool},
  ]}, computeMemory: {devices: nvidiaUuids.map((uuid, index) => ({id: `nvidia-${uuid}`, vendor: 'nvidia', kind: 'gpu',
    name: `NVIDIA RTX A6000 · 0000:0${index + 1}:00.0`, productName: 'NVIDIA RTX A6000', computeTarget: 'nvidia-gpu', nodes: ['fixture-node'],
    totalMi: 49152, unreservedMi: index === 2 ? 40960 : 49152, freeMi: 48128, metricsAvailable: true,
    ...(dra ? {gpuDevice: nvidiaSelection(index), gpuCapacityMi: 49152, gpuCapacitySource: 'nvidia-dra-inventory'} : {}),
    slots: dra ? {total: 4, used: 4 - free[index]!, free: free[index]!, scope: 'device' as const, uuid, node: 'fixture-node'} : pool,
  }))}};
}

/** Three DCGM totals and one inventory-only card, with identical physical capacities. */
export function fourNvidiaCardsWithMixedTelemetry(): ModelsPayload {
  const data = fourNvidiaCards();
  data.computeMemory!.devices!.forEach((card, index) => {
    if (index < 3) {
      card.totalMi = index === 1 ? 49141 : 49140;
      card.unreservedMi = Math.min(card.unreservedMi!, card.totalMi);
      card.metricsSource = 'dcgm';
    } else {
      card.metricsAvailable = false; card.metricsSource = 'dra-inventory'; card.freeMi = null;
    }
  });
  return data;
}

/** Different NVIDIA models/capacities; the fourth card has the smallest planning budget. */
export function heterogeneousNvidiaCards(): ModelsPayload {
  const data = fourNvidiaCardsWithMixedTelemetry();
  const products = ['NVIDIA RTX A6000', 'NVIDIA RTX A5000', 'NVIDIA RTX 6000 Ada', 'NVIDIA RTX A4000'];
  data.computeMemory!.devices!.forEach((card, index) => {
    card.productName = products[index]; card.name = `${products[index]} · 0000:0${index + 1}:00.0`;
  });
  Object.assign(data.computeMemory!.devices![1]!, {gpuCapacityMi: 24576, totalMi: 24564, unreservedMi: 20480, freeMi: 22500});
  Object.assign(data.computeMemory!.devices![3]!, {gpuCapacityMi: 16384, totalMi: 16384, unreservedMi: 12288});
  return data;
}
