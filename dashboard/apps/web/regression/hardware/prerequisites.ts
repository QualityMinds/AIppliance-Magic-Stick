import type {LabConfig} from '../core/config.ts';
import {HarnessError} from '../core/errors.ts';
import type {Provider} from '../core/borrowed-sharing.ts';

/** Check the registered physical-device pin before reading an optional vendor
 * module or borrowing its configuration. An absent AMD module on a NVIDIA-only
 * host is a hardware prerequisite, not an observer or ownership failure. */
export function requireGpuProvider(config:LabConfig,provider:Provider) {
  if(!config.gpu?.devices[provider])throw new HarnessError('GPU_PROVIDER','Blocked','gpu-backend');
}

export function pinnedGpuModules(config:LabConfig) {
  return (['amd','nvidia'] as const).filter(provider=>config.gpu?.devices[provider])
    .map(provider=>provider==='amd'?'amd-gpu':'gpu');
}
