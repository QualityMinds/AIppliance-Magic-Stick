import {environmentFor, type TestLayer} from '../core/evidence.ts';
import {requireSafe} from '../core/errors.ts';
import {freeTokenRegressionEnabled} from '../core/engine-policy.ts';

export type RemainingPhase = 5 | 6 | 7 | 8;
export type LiveGate = 'applications' | 'identity' | 'license' | 'federation' | 'maintenance' | 'network' | 'channel' | 'cache' | 'reboot' | 'mesh' | 'companion' | 'realtime' | 'repeat' | 'supply-chain';
export interface P0Definition {id:string; phase:RemainingPhase; layers:TestLayer[]; group:string; gate?:LiveGate}
const row = (phase:RemainingPhase,id:string,layers:string,group:string,gate?:LiveGate):P0Definition =>
  ({phase,id,layers:layers.split('') as TestLayer[],group,...(gate ? {gate} : {})});

/** Finite P0 catalogue, not a list of passing test titles. Live evidence always
 * remains separate from isolated API/worker/component tests. */
const definitions:P0Definition[] = [
  row(5,'MOD-03','AE','modules','applications'), row(5,'MOD-04','AE','modules','applications'),
  row(5,'MOD-06','UCAE','modules','applications'), row(5,'MOD-09','UCB','modules'), row(5,'MOD-10','UCAE','credentials','identity'),
  row(5,'APP-02','AE','apps','applications'), row(5,'APP-05','CAE','apps','applications'),
  row(5,'APP-06','AE','apps','applications'), row(5,'APP-07','UCAE','credentials','applications'),
  row(5,'APP-09','UCA','apps','applications'), row(5,'APP-10','UAE','apps','applications'),
  row(5,'ACL-01','CAE','access','identity'), row(5,'ACL-02','UCAE','access','identity'),
  row(5,'ACL-04','UCAE','access','applications'), row(5,'ACL-06','UCA','access','identity'),
  row(5,'USER-02','UCAE','users','identity'), row(5,'USER-03','UCAE','users','identity'),
  row(5,'USER-04','UCA','users','identity'), row(5,'USER-05','UCAE','users','identity'),
  row(5,'K8S-02','CAE','kubernetes','identity'), row(5,'K8S-03','CA','kubernetes','identity'),
  row(5,'K8S-04','UCBO','kubernetes','identity'), row(5,'K8S-05','UCAE','kubernetes','identity'), row(5,'K8S-06','UCAE','kubernetes','identity'),
  row(5,'LIC-01','UCAB','licensing'), row(5,'LIC-02','UCAE','licensing','license'), row(5,'LIC-03','UCA','licensing','license'),
  row(5,'LIC-04','UCAE','licensing','license'), row(5,'LIC-08','UC','licensing'),
  row(5,'SSO-01','UCBA','federation'), row(5,'SSO-02','UCAE','federation','federation'),
  row(5,'SSO-04','CAE','federation','federation'), row(5,'SSO-05','UCAO','federation','federation'),
  row(5,'AUTH-03','UCA','authentication'), row(5,'AUTH-04','CAE','authentication','identity'),
  row(5,'AUTH-05','UCA','authentication'), row(5,'AUTH-08','UAE','users','identity'), row(5,'AUTH-10','UCB','authentication'),
  row(5,'KEY-02','UCBA','keys'), row(5,'KEY-04','UCA','keys'), row(5,'KEY-05','UCA','keys'), row(5,'LOG-03','UCA','logs','identity'),

  row(6,'HOST-01','UCBA','host'), row(6,'HOST-02','UCBE','host'), row(6,'HOST-03','UC','host'),
  row(6,'HOST-04','UCAO','host','maintenance'), row(6,'HOST-05','UCO','host','maintenance'), row(6,'HOST-08','UCB','host'),
  row(6,'GPUHOST-01','UCBE','gpu-host'), row(6,'GPUHOST-02','UCB','gpu-host'),
  row(6,'GPUHOST-05','UCAEO','gpu-host','maintenance'), row(6,'GPUHOST-06','UCAO','gpu-host','maintenance'),
  row(6,'GPUHOST-07','UCAO','gpu-host','maintenance'), row(6,'GPUHOST-08','UC','gpu-host'),
  row(6,'NET-02','UCB','network'), row(6,'NET-03','UCB','network'), row(6,'NET-05','CAEO','network','network'),
  row(6,'NET-06','UCO','network','network'), row(6,'NET-07','UCO','network','network'), row(6,'NET-08','UC','network'),
  row(6,'UPD-04','UC','updates'), row(6,'UPD-05','CAO','updates','maintenance'), row(6,'UPD-06','UC','updates'), row(6,'UPD-07','UCO','updates','maintenance'),
  row(6,'CHANNEL-02','UCB','channel'), row(6,'CHANNEL-04','UC','channel'), row(6,'CHANNEL-05','UC','channel'),
  row(6,'CHANNEL-06','CAEO','channel','channel'), row(6,'CHANNEL-07','UCO','channel','channel'), row(6,'CHANNEL-08','UCAO','channel','channel'),
  row(6,'CACHE-02','UCAB','cache'), row(6,'CACHE-03','UCB','cache'), row(6,'CACHE-04','UCAEO','cache','cache'),
  row(6,'CACHE-05','UC','cache'), row(6,'CACHE-06','UCA','cache','cache'), row(6,'CACHE-07','UCA','cache','cache'),
  row(6,'BOOT-01','UCB','host'), row(6,'BOOT-02','CAO','boot','reboot'), row(6,'BOOT-03','CAO','boot','reboot'),
  row(6,'BOOT-04','UCAO','boot','reboot'), row(6,'BOOT-05','UC','boot'),

  row(7,'MESH-01','UCBAE','mesh'), row(7,'MESH-03','UCAE','mesh','mesh'), row(7,'MESH-04','UCAE','mesh','mesh'),
  row(7,'MESH-05','UCA','mesh','mesh'), row(7,'MESH-06','UCA','mesh','mesh'), row(7,'MESH-07','UCAE','mesh','mesh'),
  row(7,'MESH-09','CA','companion','companion'), row(7,'RT-01','UCBAE','realtime','realtime'),
  row(7,'RT-02','UCA','realtime','realtime'), row(7,'RT-03','CA','realtime','realtime'),
  row(7,'RT-04','UCA','realtime','realtime'), row(7,'RT-08','UCAE','realtime','realtime'),

  row(8,'SEC-01','UCA','security'), row(8,'SEC-02','UCB','security'), row(8,'SEC-03','UCA','supply-chain','supply-chain'),
  row(8,'SEC-04','CA','security'), row(8,'UX-02','UBE','forms'), row(8,'PERF-02','UCAN','repeat','repeat'),
];
export const remainingVariants:Record<string,P0Definition> = Object.fromEntries(definitions.map(definition =>
  [`p${definition.phase}-${definition.id.toLowerCase()}`,definition]));
/** Keep historical definitions readable, but do not execute or require an
 * experimental engine's dedicated cache scenario in the normal campaign. */
export const remainingVariantEnabled=(definition:P0Definition)=>freeTokenRegressionEnabled || definition.id !== 'CACHE-07';
export const remainingPhases = [5,6,7,8] as const;
export function remainingPhase(mode?:string):RemainingPhase|undefined {
  return /^phase[5-8](?:-fast|-fixtures|-live)?$/.test(mode ?? '') || mode === 'phase6-drill' ? Number(mode![5]) as RemainingPhase : undefined;
}
export const hostDrillIds=definitions.filter(item=>item.phase === 6 && item.gate && item.id !== 'CACHE-07').map(item=>item.id);
export function remainingRequirements(mode:string,selectedId=mode === 'phase6-drill' ? process.env.REGRESSION_REMAINING_CASE : undefined) {
  const phase = remainingPhase(mode); if (!phase) return undefined;
  if(mode === 'phase6-drill')requireSafe(selectedId && hostDrillIds.includes(selectedId),'CONFIG');
  const layers = mode.endsWith('-fast') ? ['U','C'] : mode.endsWith('-fixtures') ? ['B'] :
    mode.endsWith('-live') || mode === 'phase6-drill' ? ['A','E','O','N'] : undefined;
  const required=Object.entries(remainingVariants).filter(([,definition]) => remainingVariantEnabled(definition) && definition.phase === phase && (!selectedId || definition.id === selectedId))
    .flatMap(([variant,definition]) => definition.layers.filter(layer => !layers || layers.includes(layer))
      .map(layer => ({id:definition.id,variant,layer,environment:environmentFor(layer),phase,priority:'P0' as const,
        group:definition.group,...(definition.gate ? {gate:definition.gate} : {})})));
  if(mode === `phase${phase}`)required.push({id:'HAR-03',variant:'final-idle',layer:'A',environment:'live',phase,priority:'P0',group:'final-baseline'});
  return required;
}
export const remainingIds = (mode?:string,selectedId?:string) => mode && remainingRequirements(mode,selectedId) ?
  [...new Set(remainingRequirements(mode,selectedId)!.map(item=>item.id))] : undefined;
export function remainingCoverage(mode:string,cases:Array<{id:string;variant?:string;layer:string;environment?:string;outcome:string}>) {
  const required=remainingRequirements(mode) ?? [];
  const missingLayers=required.filter(item=>!cases.some(proof=>proof.id === item.id && proof.variant === item.variant &&
    proof.layer === item.layer && proof.environment === item.environment && proof.outcome === 'Passed'));
  return {complete:required.length > 0 && missingLayers.length === 0 && cases.length > 0 && cases.every(item=>item.outcome === 'Passed'),missingLayers};
}
export function validateRemainingRegistry() {
  requireSafe(definitions.length === new Set(Object.keys(remainingVariants)).size,'CONFIG');
  for(const item of definitions) requireSafe(/^[A-Z][A-Z0-9]+-\d{2}$/.test(item.id) && item.layers.length > 0 &&
    new Set(item.layers).size === item.layers.length && item.layers.every(layer=>'UCBAEON'.includes(layer)),'CONFIG');
}
