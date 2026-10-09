import type {ComputeMemoryDevice} from '@magicstick/dashboard-contracts';

export const nvidiaPhysicalCapacityMi = (card: Pick<ComputeMemoryDevice, 'gpuCapacityMi' | 'gpuCapacitySource' | 'totalMi'>) =>
  card.gpuCapacitySource === 'nvidia-dra-inventory' ? card.gpuCapacityMi : card.totalMi;

/** UI eligibility only; the API/controller repeat the current inventory check. */
export const nvidiaCardMismatch = (a: ComputeMemoryDevice, b: ComputeMemoryDevice): string | undefined => {
  if (!a.gpuDevice?.nodeUid || !b.gpuDevice?.nodeUid || !a.gpuDevice.nodeName || !b.gpuDevice.nodeName)
    return 'GPU node identity could not be verified';
  if (a.gpuDevice.nodeUid !== b.gpuDevice.nodeUid || a.gpuDevice.nodeName !== b.gpuDevice.nodeName)
    return 'Requires GPUs on the same node';
  const aInventory = a.gpuCapacitySource === 'nvidia-dra-inventory', bInventory = b.gpuCapacitySource === 'nvidia-dra-inventory';
  if (aInventory !== bInventory) return 'GPU inventory capacity could not be verified';
  // DCGM free + used can differ from ResourceSlice capacity (or another sample).
  // Require known capacity from the same source, not equal card models or sizes.
  const aCapacity = nvidiaPhysicalCapacityMi(a), bCapacity = nvidiaPhysicalCapacityMi(b);
  if (typeof aCapacity !== 'number' || !Number.isFinite(aCapacity) || aCapacity <= 0
    || typeof bCapacity !== 'number' || !Number.isFinite(bCapacity) || bCapacity <= 0)
    return 'Physical GPU capacity could not be verified';
};

export const matchingNvidiaCards = (a: ComputeMemoryDevice, b: ComputeMemoryDevice) => !nvidiaCardMismatch(a, b);
