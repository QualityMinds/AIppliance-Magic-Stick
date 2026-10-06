import type {LabConfig} from '../core/config.ts';
import {environmentFor, type TestLayer} from '../core/evidence.ts';
import {requireSafe} from '../core/errors.ts';
import {requirePhase1Profile} from './phase1-p0.ts';

type Definition = {id:string; layers:readonly TestLayer[]};
const row = (id:string,layers:readonly TestLayer[]): Definition => ({id,layers});
/** Finite installed mixed-node GPU matrix. Intel and reboot acceptance are
 * separate, explicit hardware/maintenance gates, never synthetic live passes. */
export const phase3Variants = {
  'p3-inventory':row('HW-01',['U','C','A','E']),
  'p3-mixed-vendor':row('HW-02',['U','C','A','E']),
  'p3-readiness':row('HW-03',['U','C','A','B']),
  'p3-validation-single':row('HW-06',['U','C','A','E']),
  'p3-validation-all':row('HW-06',['C','A','E']),
  'p3-identity':row('HW-08',['U','C','B','A']),
  'p3-memory-denominators':row('MEM-04',['U','C','B','A','E']),
  'p3-memory-unknown':row('MEM-08',['U','C','B','A']),
  'p3-unified-memory':row('MEM-09',['U','C','A','E']),
  'p3-slot-ring':row('SLOT-01',['U','C','A','E']),
  'p3-pending-slot':row('SLOT-02',['U','C','A']),
  'p3-kv-controls':row('ENG-03',['U','C']),
  'p3-amd-ollama':row('ENG-01',['C','A','E']),
  'p3-amd-vllm':row('ENG-01',['C','A','E']),
  'p3-nvidia-ollama':row('ENG-01',['C','A','E']),
  'p3-nvidia-vllm':row('ENG-01',['C','A','E']),
  'p3-kv-amd-ollama':row('ENG-03',['A','E']),
  'p3-kv-amd-vllm':row('ENG-03',['A','E']),
  'p3-kv-nvidia-ollama':row('ENG-03',['A','E']),
  'p3-kv-nvidia-vllm':row('ENG-03',['A','E']),
  'p3-gpu-logs':row('LOG-01',['U','C','A','E']),
  'p3-route':row('ROUTE-01',['A']),
  'p3-ft-capability':row('FT-01',['U','C','A','E']),
  'p3-ft-telemetry':row('FT-02',['U','C','B','A','E']),
  'p3-ft-runtime':row('FT-03',['C','A']),
  'p3-ft-whole-device':row('FT-04',['U','C','A','E']),
  'p3-ft-vram':row('FT-05',['U','C','B','A','E']),
  'p3-ft-ram':row('FT-06',['U','C','B','A','E']),
  'p3-ft-edit':row('FT-08',['U','C','A','E']),
  'p3-ft-lifecycle':row('FT-09',['U','C','A','E']),
  'p3-ft-discovery':row('DISC-08',['U','C','A','E']),
  'p3-restoration':row('HAR-08',['U','A']),
} as const;

export const phase4Variants = {
  'p4-defaults':row('SHR-01',['U','C','B']),
  'p4-dirty-confirmation':row('SHR-02',['U','B','E']),
  'p4-nvidia-transition':row('SHR-03',['C','A','E','O']),
  'p4-amd-transition':row('SHR-04',['C','A','E','O']),
  'p4-rbac-admission':row('SHR-05',['U','C','A']),
  'p4-amd-pair':row('SHR-06',['A','O']),
  'p4-nvidia-pair':row('SHR-06',['A','O']),
  'p4-amd-same-engine':row('SHR-06',['A','O']),
  'p4-nvidia-same-engine':row('SHR-06',['A','O']),
  'p4-provider-independence':row('SHR-07',['U','C','A','O']),
  'p4-invalid-intent':row('SHR-08',['U','C','A','B']),
  'p4-custom-config':row('SHR-09',['U','C','B']),
  'p4-dra-unavailable':row('SHR-11',['U','C','B']),
  'p4-reload':row('SHR-12',['A','E','O']),
  'p4-other-consumers':row('SLOT-03',['U','C','A']),
  'p4-full':row('SLOT-04',['U','C','A','E']),
  'p4-draft-refresh':row('SLOT-05',['U','B','A','E']),
  'p4-release':row('SLOT-06',['U','C','A','E']),
  'p4-edit-own-slot':row('SLOT-07',['U','C','A','E']),
  'p4-last-slot-race':row('SLOT-09',['U','C','A']),
  'p4-restoration':row('HAR-08',['U','C','A']),
  'p4-cdi-identity':row('BOOT-04',['U','C']),
  'p4-stale-checkpoint':row('BOOT-05',['U','C']),
} as const;
export type GpuVariant = keyof typeof phase3Variants | keyof typeof phase4Variants;

const requirements = (variants:Record<string,Definition>,phase:number) => Object.entries(variants).flatMap(([variant,definition]) =>
  definition.layers.map(layer => ({id:definition.id,variant,layer,environment:environmentFor(layer),priority:'P0' as const,phase,
    parameterSet:phase === 3 ? 'installed-exclusive-amd-nvidia' : 'installed-sharing-amd-nvidia'})));
export const phase3Requirements = requirements(phase3Variants,3);
export const phase4Requirements = requirements(phase4Variants,4);
export const gpuRequirements = (phase:3|4) => phase === 3 ? phase3Requirements : phase4Requirements;
/** Fixed diagnostic subset only; canonical phase4 never selects this case. */
export const phase4SharingCases = {
  remaining:{ids:['SLOT-03','SHR-07','SLOT-09','SHR-12','HAR-08'],grep:'SLOT-03|SHR-07|SLOT-09|SHR-12|HAR-08'},
} as const;
export const gpuModePhase = (mode?:string):3|4|undefined => /^phase[34](?:-|$)/.test(mode ?? '') ? Number(mode![5]) as 3|4 : undefined;
export function gpuModeIds(mode?:string,gpuCase?:string) {
  if(gpuCase) {
    requireSafe(mode === 'phase4-sharing' && Object.hasOwn(phase4SharingCases,gpuCase),'CONFIG');
    return [...phase4SharingCases[gpuCase as keyof typeof phase4SharingCases].ids];
  }
  const phase = gpuModePhase(mode); if (!phase) return undefined;
  const fixture = mode?.endsWith('-fast') ? ['U','C'] : mode?.endsWith('-fixtures') ? ['B'] : undefined;
  const selected = gpuRequirements(phase).filter(item => !fixture || fixture.includes(item.layer));
  const live = mode?.endsWith('-validation') ? selected.filter(item => item.id === 'HW-06' && ['A','E'].includes(item.layer)) :
    mode?.endsWith('-gpu') ? selected.filter(item => item.id !== 'HW-06' && ['A','E','O'].includes(item.layer)) :
    mode?.endsWith('-sharing') ? selected.filter(item => ['A','E','O'].includes(item.layer)) : selected;
  return [...new Set(live.map(item => item.id))];
}
export const gpuIds = (phase:3|4,layers?:readonly TestLayer[]) => [...new Set(gpuRequirements(phase)
  .filter(item => !layers || layers.includes(item.layer)).map(item => item.id))];
export function gpuCoverage(phase:3|4,cases:Array<{id:string;layer:string;variant?:string;environment?:string;outcome:string}>) {
  const missingLayers = gpuRequirements(phase).filter(required => !cases.some(item => item.id === required.id && item.variant === required.variant &&
    item.layer === required.layer && item.environment === required.environment && item.outcome === 'Passed'));
  return {complete:cases.length > 0 && cases.every(item => item.outcome === 'Passed') && missingLayers.length === 0,missingLayers};
}
export function requireGpuProfile(config:LabConfig) {
  if(config.gpu?.selection === 'available-providers')requireSafe(config.registrationFile && config.lock && config.modelCleanupKubeconfig,'PREREQUISITE');
  else requirePhase1Profile(config);
  const gpu = config.gpu;
  requireSafe(gpu?.acknowledgeSharingTransitions === true && config.caFile && config.inferenceUrl,'PREREQUISITE');
  requireSafe(Object.values(gpu.devices).length > 0 && Object.values(gpu.devices).every(device=>
    device.id === `${gpu.nodeUid}/${device.pciAddress}`),'CONFIG');
  if(gpu.devices.amd && gpu.devices.nvidia)requireSafe(gpu.devices.amd.id !== gpu.devices.nvidia.id &&
    gpu.devices.amd.pciAddress !== gpu.devices.nvidia.pciAddress,'CONFIG');
}
