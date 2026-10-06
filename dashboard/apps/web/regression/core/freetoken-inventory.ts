import type {ModelsPayload} from '@magicstick/dashboard-contracts';
import {requireSafe} from './errors.ts';

/** The capability catalog describes scheduler nodes, not physical VRAM
 * samples. Resolve the selected node against separate live GPU telemetry.
 * Unknown samples never fall back to CPU memory, another node, or capacity. */
export function freeTokenNodeCapacity(models:ModelsPayload,node:string) {
  const capability=models.computeTargets.freeTokenCapabilities;
  const device=capability?.devices?.find(item=>item.id === `node:${node}`);
  const target=models.computeTargets.targets.find(item=>item.id === 'nvidia-gpu');
  requireSafe(capability?.available && capability.supportedVendors?.includes('nvidia') &&
    target?.engines?.includes('FreeToken') && device?.supported && device.node === node,'CAPABILITY');
  const physical=(models.computeMemory?.devices ?? []).filter(item=>item.kind === 'gpu' &&
    item.computeTarget === 'nvidia-gpu' && item.nodes?.includes(node));
  const finite=(value:unknown):value is number=>typeof value === 'number' && Number.isFinite(value);
  requireSafe(physical.length > 0 && physical.every(item=>item.vendor === 'nvidia' && item.metricsAvailable === true &&
    item.freeToken?.id === device.id && item.freeToken.supported === true && finite(item.totalMi) && item.totalMi > 0 &&
    finite(item.freeMi) && finite(item.unreservedMi)) && finite(device.systemMemoryMi) && device.systemMemoryMi > 0 &&
    finite(device.systemAvailableMi) && Number.isSafeInteger(device.maxGpuCount) && Number(device.maxGpuCount) > 0,'CAPABILITY');
  return {capability,device,physical,
    gpuPhysicalMi:Math.floor(Math.min(...physical.map(item=>item.totalMi!))),
    gpuAvailableMi:Math.max(0,Math.floor(Math.min(...physical.flatMap(item=>[item.totalMi!,item.freeMi!,item.unreservedMi!])))),
    systemPhysicalMi:Math.floor(device.systemMemoryMi),
    systemAvailableMi:Math.max(0,Math.floor(Math.min(device.systemMemoryMi,device.systemAvailableMi))),
    maxGpuCount:Math.min(Number(device.maxGpuCount),physical.length)};
}
