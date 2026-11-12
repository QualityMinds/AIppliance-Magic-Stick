import {test,expect} from '@playwright/test';
import type {ModulesPayload} from '@magicstick/dashboard-contracts';
import {serviceMatrix,requireServiceMatrix,serviceStages,serviceStageEvidence,servicesRequirements} from '../core/service-matrix.ts';

const fixture=():ModulesPayload=>({modules:{},catalogJson:{modules:{
  basis:{activationMode:'static'},dashboard:{activationMode:'moduleactivation'},gpu:{activationMode:'moduleactivation'},
  'amd-gpu':{activationMode:'moduleactivation'},'intel-gpu':{activationMode:'moduleactivation'},
  litellm:{activationMode:'moduleactivation'},'model-catalog':{activationMode:'moduleactivation'},
  'anything-llm':{activationMode:'moduleactivation',requires:['litellm','model-catalog'],uninstallPolicy:'keep-data'},
  'openclaw-operator':{activationMode:'moduleactivation',requires:['basis']},
  'hermes-operator':{activationMode:'moduleactivation',requires:['basis']},
  'pi-coding':{activationMode:'moduleactivation',requires:['litellm']},
  'future-service':{activationMode:'moduleactivation',requires:[]},
},applications:{
  openclaw:{requiredModules:['openclaw-operator','litellm']},hermes:{requiredModules:['hermes-operator']},
  'pi-coding':{requiredModules:['pi-coding','litellm']},'future-app':{requiredModules:['future-service']},
}}});

test('MOD-01 separate service inventory includes every eligible catalog entry and records protected/Hermes exclusions',()=>{
  const inventory=serviceMatrix(fixture());
  expect(inventory.entries.map(row=>row.kind+':'+row.id)).toEqual([
    'application:future-app','application:openclaw','application:pi-coding',
    'module:anything-llm','module:future-service','module:openclaw-operator','module:pi-coding',
  ]);
  for(const id of ['gpu','amd-gpu','intel-gpu','dashboard','basis','litellm','model-catalog'])
    expect(inventory.excluded).toContainEqual({kind:'module',id,reason:'PROTECTED_MODULE'});
  expect(inventory.excluded).toContainEqual({kind:'application',id:'hermes',reason:'SEPARATE_HERMES'});
  expect(inventory.excluded).toContainEqual({kind:'module',id:'hermes-operator',reason:'SEPARATE_HERMES'});
  expect(inventory.entries.find(row=>row.id==='anything-llm')?.uninstallPolicy).toBe('keep-data');
});

test('MOD-01 unknown adapters remain blocked inventory rows rather than silently missing or passed',()=>{
  const inventory=serviceMatrix(fixture(),{'module:anything-llm':{installation:{state:'supported'}}});
  const future=inventory.entries.find(row=>row.kind==='application'&&row.id==='future-app')!;
  for(const stage of serviceStages)expect(future.capabilities[stage]).toEqual({state:'blocked',code:'ADAPTER_UNREVIEWED'});
  const reviewed=inventory.entries.find(row=>row.kind==='module'&&row.id==='anything-llm')!;
  expect(reviewed.capabilities.installation).toEqual({state:'supported'});
  expect(reviewed.capabilities.access.state).toBe('blocked');
  expect(()=>serviceMatrix(fixture(),{'application:absent':{}})).toThrow('[CONFIG]');
});

test('MOD-01 service matrix validates catalog dependencies without accepting missing or duplicate module references',()=>{
  const missing=fixture();missing.catalogJson!.applications!.openclaw!.requiredModules=['foreign'];
  expect(()=>serviceMatrix(missing)).toThrow('[CONFIG]');
  const duplicate=fixture();duplicate.catalogJson!.applications!.openclaw!.requiredModules=['litellm','litellm'];
  expect(()=>serviceMatrix(duplicate)).toThrow('[CONFIG]');
  expect(()=>serviceMatrix({modules:{}})).toThrow('[PREREQUISITE]');
});

test('HAR-10 staged service requirements preserve order, existing case IDs and exact live layers',()=>{
  expect(serviceStages).toEqual(['installation','access']);
  const matrix=serviceMatrix(fixture()),requirements=servicesRequirements(matrix);
  const valid=new Set(['MOD-03','MOD-04','APP-02','APP-05','APP-07','APP-10','ACL-01','ACL-02','ACL-04','ACL-06']);
  expect(requirements.every(row=>valid.has(row.id)&&row.phase===5&&row.environment==='live'&&['A','E'].includes(row.layer))).toBe(true);
  expect(new Set(requirements.map(row=>`${row.id}/${row.variant}/${row.layer}`)).size).toBe(requirements.length);
  const module=matrix.entries.find(row=>row.kind==='module')!;
  expect(serviceStageEvidence('installation',module).map(row=>row.id)).toEqual(['MOD-03','MOD-03','MOD-04','MOD-04']);
  expect(requirements.some(row=>['MOD-06','APP-06','APP-09'].includes(row.id))).toBe(false);
  for(const entry of matrix.entries)for(const stage of serviceStages)
    expect(requirements.some(row=>row.variant?.startsWith(`p5-services-${entry.kind}-${entry.id}-${stage}-`))).toBe(true);
  const onlyOne=requirements.filter(row=>row.variant?.includes(matrix.entries[0]!.id));
  expect(onlyOne.length).toBeLessThan(requirements.length);
});

test('MOD-01 inapplicable provider routes stay explicit without synthetic passing evidence',()=>{
  const matrix=serviceMatrix(fixture(),{'module:openclaw-operator':{
    installation:{state:'supported'},access:{state:'not-applicable',code:'INSTANCE_PROVIDER'},
  }});
  const entry=matrix.entries.find(row=>row.id==='openclaw-operator')!;
  expect(serviceStageEvidence('access',entry)).toEqual([]);
  expect(serviceStageEvidence('installation',entry)).toHaveLength(4);
  expect(matrix.entries).toContainEqual(entry);
});

test('MOD-01 saved service matrices cannot omit Pi, add foreign identities or self-approve an unsupported adapter',()=>{
  const expected=serviceMatrix(fixture());
  expect(requireServiceMatrix(structuredClone(expected),expected)).toEqual(expected);
  const omitted=structuredClone(expected);omitted.entries=omitted.entries.filter(row=>row.id!=='pi-coding');
  const foreign=structuredClone(expected);foreign.entries[0]!.id='foreign';
  const forged=structuredClone(expected);forged.entries[0]!.capabilities.access={state:'supported'};
  const dependencies=structuredClone(expected);dependencies.entries[0]!.requiredModules=[];
  for(const value of [omitted,foreign,forged,dependencies,{...expected,extra:'unreviewed'}])
    expect(()=>requireServiceMatrix(value,expected)).toThrow('[CONFLICT]');
  const unknownCapability=structuredClone(expected);
  (unknownCapability.entries[0]!.capabilities.access as unknown)={state:'supported',runScript:'foreign'};
  expect(()=>servicesRequirements(unknownCapability)).toThrow('[CONFIG]');
  const missingStage=structuredClone(expected);
  delete (missingStage.entries[0]!.capabilities as Partial<typeof missingStage.entries[0]['capabilities']>).access;
  expect(()=>servicesRequirements(missingStage)).toThrow('[CONFIG]');
});
