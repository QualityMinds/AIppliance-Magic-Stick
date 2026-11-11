import type {HardwareGpuDevice} from '@magicstick/dashboard-contracts';
import type {GpuScenario} from '../core/gpu-scenario.ts';
import {canonical} from '../core/borrowed-sharing.ts';
import {HarnessError,requireSafe} from '../core/errors.ts';
import {poll} from '../core/poll.ts';
import type {GpuValidationObservation} from '../core/gpu-validation-diagnostic.ts';

type Options={timeoutMs?:number;intervalMs?:number;observe?:(value:GpuValidationObservation)=>Promise<void>};
const generation=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0?Number(v):null;
const identity=(devices:HardwareGpuDevice[])=>canonical(devices.map(d=>({id:d.id,vendor:d.vendor,module:d.module,
  pci:d.pciAddress,node:d.node,nodeUid:d.nodeUid,bootId:d.bootId})).sort((a,b)=>a.id.localeCompare(b.id)));

/** Read-only convergence against the already borrowed intent. Status/RV updates
 * may converge; a replaced identity or changed spec/generation is never adopted.
 * This does not retry an HTTP write or make a stale rejection into a pass. */
export async function waitValidationConfiguration(s:GpuScenario,selected:HardwareGpuDevice[],
  select:(devices:HardwareGpuDevice[])=>HardwareGpuDevice[],options:Options={}) {
  const expectedIdentity=identity(selected);let attempt=0;
  const observe=async(value:GpuValidationObservation)=>{try{await options.observe?.(value);}catch{/* Optional telemetry cannot replace the safety outcome. */}};
  return poll(async()=>{
    const observation:GpuValidationObservation={attempt:++attempt,state:'waiting',modules:[]};
    try {
      const devices=select((await s.inventory()).devices);
      if(identity(devices)!==expectedIdentity)throw new HarnessError('IDENTITY','Failed','gpu-validation');
      for(const provider of ['amd','nvidia'] as const) {
        const physical=devices.filter(d=>d.vendor===provider);if(!physical.length)continue;
        const module=provider==='amd'?'amd-gpu':'gpu',entry=s.sharing.entries.find(e=>e.provider===provider);
        requireSafe(entry?.state==='borrowed'&&typeof entry.uid==='string'&&entry.uid.length>0&&
          generation(entry.generation)!==null,'OWNERSHIP');
        const current=await s.live.observer.get('moduleactivations.appliance.magicstick.dev',s.config.expected.applianceNamespace,module);
        const sameIdentity=current.metadata.uid===entry.uid&&!current.metadata.deletionTimestamp&&
          physical.every(d=>d.module===module);
        const sameIntent=current.metadata.generation===entry.generation&&canonical(current.spec)===canonical(entry.lastSpec);
        const ready=current.status?.observedGeneration===entry.generation&&current.status.phase==='Ready'&&
          current.status.conditions?.some(c=>c.type==='Ready'&&c.status==='True'&&
            (c.observedGeneration??current.status?.observedGeneration)===entry.generation)===true;
        observation.modules.push({provider,expectedGeneration:generation(entry.generation),currentGeneration:generation(current.metadata.generation),
          observedGeneration:generation(current.status?.observedGeneration),inventoryGenerations:physical.map(d=>generation(d.activationGeneration)),
          identityMatches:sameIdentity,intentMatches:sameIntent,ready});
        if(!sameIdentity)throw new HarnessError('IDENTITY','Failed','gpu-validation');
        if(!sameIntent||physical.some(d=>generation(d.activationGeneration)!==null&&d.activationGeneration!>entry.generation))
          throw new HarnessError('CONFLICT','Failed','gpu-validation');
      }
      observation.state=observation.modules.every(m=>m.ready&&m.inventoryGenerations.every(g=>g===m.expectedGeneration))?'ready':'waiting';
      await observe(observation);
      return {devices,ready:observation.state==='ready'};
    }catch(error) {
      observation.state='failed';await observe(observation);
      throw error;
    }
  },value=>value.ready,{timeoutMs:options.timeoutMs??90_000,intervalMs:options.intervalMs??1000,stage:'gpu-validation'})
    .then(value=>value.devices);
}
