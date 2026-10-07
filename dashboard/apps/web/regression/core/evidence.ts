/** Canonical catalog layers; environment is a separate axis, not a layer. */
export const testLayers = ['U', 'C', 'B', 'A', 'E', 'O', 'N'] as const;
export type TestLayer = typeof testLayers[number];
export type TestEnvironment = 'fixture' | 'live';
export interface Evidence {id: string; variant?: string; layer: TestLayer}
export const environmentFor = (layer: TestLayer): TestEnvironment => ['U', 'C', 'B'].includes(layer) ? 'fixture' : 'live';

/** Explicit metadata wins; file suffix is a fallback for older harness cases. */
export function fileLayer(file: string): TestLayer | undefined {
  const suffixes: Array<[string, TestLayer]> = [['.unit.spec.ts', 'U'], ['.contract.spec.ts', 'C'],
    ['.browser.spec.ts', 'B'], ['.api.spec.ts', 'A'], ['.e2e.spec.ts', 'E']];
  return suffixes.find(([suffix]) => file.endsWith(suffix))?.[1];
}

export function evidenceAnnotations(...items: Evidence[]) {
  return {annotation: items.map(item => ({type: 'regression', description: JSON.stringify(item)}))};
}

/** Record only completed evidence, not a whole scenario's final result for
 * every earlier assertion. Unreached dependent steps remain Blocked. */
export async function evidenceStep<T>(info:{annotations:Array<{type:string;description?:string}>},items:Evidence[],action:()=>Promise<T>):Promise<T> {
  const started=performance.now(),annotation={type:'regression-step',description:JSON.stringify({items,state:'running',durationMs:0})};
  info.annotations.push(annotation);
  try {
    const value=await action();
    annotation.description=JSON.stringify({items,state:'passed',durationMs:performance.now()-started});
    return value;
  } catch(error) {
    annotation.description=JSON.stringify({items,state:'failed',durationMs:performance.now()-started});
    throw error;
  }
}
