import type {ComputeMemoryDevice} from '@magicstick/dashboard-contracts';

/** UI eligibility only; the API/controller repeat the current inventory check. */
export const matchingNvidiaCards = (a: ComputeMemoryDevice, b: ComputeMemoryDevice) =>
  Boolean(a.productName && b.productName && a.productName !== 'NVIDIA GPU' && b.productName !== 'NVIDIA GPU' && a.totalMi && b.totalMi)
  && a.gpuDevice?.nodeUid === b.gpuDevice?.nodeUid && a.gpuDevice?.nodeName === b.gpuDevice?.nodeName
  && a.productName === b.productName && a.totalMi === b.totalMi;
