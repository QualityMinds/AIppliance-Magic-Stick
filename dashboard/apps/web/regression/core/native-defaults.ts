import {canonical} from './borrowed-sharing.ts';
import {requireSafe} from './errors.ts';

/** A schema-defaulted field may appear during the native operator's initial
 * reconciliation. Existing intent stays exact; unknown fields or changed
 * values are never accepted as defaults. Arrays are always ordered/exact. */
export interface NativeSchema {type?:string;default?:unknown;properties?:Record<string,NativeSchema>}
export interface NativeBinding {uid:string;generation:number;initialSpec:Record<string,unknown>;spec:Record<string,unknown>;initialized:boolean}

/** Pin UID immediately. A pre-initialization generation can advance only after
 * the controller has observed it and its spec differs by declared defaults. */
export function advanceNativeBinding(previous:NativeBinding|undefined,current:{uid:string;generation:number;spec:Record<string,unknown>;observedGeneration?:number},schema:NativeSchema):NativeBinding|undefined {
  if(!previous)return {uid:current.uid,generation:current.generation,initialSpec:structuredClone(current.spec),spec:structuredClone(current.spec),
    initialized:current.observedGeneration===current.generation};
  requireSafe(current.uid===previous.uid,'OWNERSHIP');
  if(current.generation!==previous.generation) {
    requireSafe(!previous.initialized&&current.generation>previous.generation,'OWNERSHIP');
    if(current.observedGeneration!==current.generation)return undefined;
    requireSafe(nativeDefaultsOnly(previous.initialSpec,current.spec,schema),'CONFLICT');
    return {...previous,generation:current.generation,spec:structuredClone(current.spec),initialized:true};
  }
  requireSafe(canonical(previous.spec)===canonical(current.spec),'CONFLICT');
  return {...previous,initialized:previous.initialized||current.observedGeneration===current.generation};
}

export function nativeDefaultsOnly(before:unknown,after:unknown,schema:NativeSchema,depth=0):boolean {
  if(depth>32)return false;
  if(canonical(before)===canonical(after))return true;
  if(!before||!after||typeof before!=='object'||typeof after!=='object'||Array.isArray(before)||Array.isArray(after))return false;
  const original=before as Record<string,unknown>,current=after as Record<string,unknown>;
  for(const [key,value] of Object.entries(original)) {
    if(!Object.hasOwn(current,key)||!nativeDefaultsOnly(value,current[key],schema.properties?.[key]??{},depth+1))return false;
  }
  for(const [key,value] of Object.entries(current))if(!Object.hasOwn(original,key)) {
    const property=schema.properties?.[key];if(!property)return false;
    if(Object.hasOwn(property,'default')) {
      if(!nativeDefaultsOnly(property.default,value,property,depth+1))return false;
    } else if(property.type==='object'&&value!==null&&typeof value==='object'&&!Array.isArray(value)) {
      if(!nativeDefaultsOnly({},value,property,depth+1))return false;
    } else return false;
  }
  return true;
}
