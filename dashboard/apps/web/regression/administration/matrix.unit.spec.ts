import {test,expect} from '@playwright/test';
import {remainingCoverage,remainingIds,remainingPhases,remainingRequirements,remainingVariants,remainingLayers,validateRemainingRegistry} from '../profiles/remaining-p0.ts';
import {evidenceAnnotations,fileLayer} from '../core/evidence.ts';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';

test('HAR-10 remaining P0 selections are finite, unique and require their exact layer/environment',evidenceAnnotations({id:'HAR-10',layer:'U'}),()=>{
  validateRemainingRegistry();
  for(const phase of remainingPhases) {
    const mode=`phase${phase}`,required=remainingRequirements(mode)!;
    expect(required.length).toBeGreaterThan(0);
    expect(new Set(required.map(item=>`${item.variant}/${item.layer}`)).size).toBe(required.length);
    const passed=required.map(item=>({...item,outcome:'Passed'}));
    expect(remainingCoverage(mode,passed).complete).toBe(true);
    expect(remainingCoverage(mode,passed.slice(1)).complete).toBe(false);
    expect(remainingCoverage(mode,passed.map(item=>({...item,environment:'fixture'}))).complete).toBe(false);
    expect(remainingCoverage(mode,[...passed,{...passed[0]!,outcome:'Blocked'}]).complete).toBe(false);
    expect(remainingCoverage(mode,[...passed,{...passed[0]!,outcome:'Skipped'}]).complete).toBe(false);
    expect(remainingCoverage(mode,[...passed,{...passed[0]!,outcome:'Flaky'}]).complete).toBe(false);
    expect(remainingIds(mode)?.length).toBe(new Set(Object.values(remainingVariants).filter(item=>remainingLayers(item).length && item.phase === phase).map(item=>item.id)).size+1);
    expect(remainingCoverage(mode,passed.filter(item=>item.variant !== 'final-idle')).complete).toBe(false);
    const fast=remainingRequirements(mode+'-fast')!;
    expect(fast.every(item=>['U','C'].includes(item.layer) && item.environment === 'fixture')).toBe(true);
    expect(remainingCoverage(mode,fast.map(item=>({...item,outcome:'Passed'}))).complete).toBe(false);
  }
  const deferred=['MOD-03','MOD-04','MOD-10','APP-02','APP-05','APP-06','APP-07','APP-09','APP-10','ACL-01','ACL-02','ACL-04','ACL-06'];
  const live=remainingRequirements('phase5-live')!,full=remainingRequirements('phase5')!;
  for(const id of deferred) {
    expect(live.some(item=>item.id===id),id).toBe(false);
    expect(()=>remainingRequirements('phase5-live',id),id).toThrow('[CONFIG]');
    const isolated=Object.values(remainingVariants).filter(item=>item.id===id).flatMap(item=>item.layers).filter(layer=>'UCB'.includes(layer));
    expect(full.filter(item=>item.id===id).map(item=>item.layer)).toEqual(isolated);
  }
  for(const id of ['MOD-06','USER-02','AUTH-03','KEY-02','LIC-04','K8S-05'])expect(live.some(item=>item.id===id),id).toBe(true);
  expect(live.find(item=>item.id==='MOD-06')?.gate).toBe('gpu-profile');
  const discovered=JSON.parse(execFileSync(process.execPath,['node_modules/@playwright/test/cli.js','test',
    '--config','regression/playwright.config.ts','--list','--reporter=json'],{
    env:{...process.env,REGRESSION_MODE:'phase5-live',REGRESSION_REMAINING_CASE:''},encoding:'utf8',timeout:30_000,maxBuffer:2*1024*1024,
  }));
  const titles:string[]=[];
  const visit=(suite:{suites?:any[];specs?:Array<{title:string}>})=>{titles.push(...(suite.specs??[]).map(spec=>spec.title));for(const child of suite.suites??[])visit(child);};
  visit(discovered);
  for(const id of deferred)expect(titles.some(title=>title.startsWith(id+' ')),id).toBe(false);
  for(const id of ['MOD-06','USER-02','LIC-04','K8S-05'])expect(titles.some(title=>title.startsWith(id+' ')),id).toBe(true);
});

test('HAR-10 every remaining variant retains its stable P0 catalogue ID and exact declared layers',evidenceAnnotations({id:'HAR-10',layer:'U'}),async()=>{
  const catalog=await readFile('../../../docs/development/regression-test-catalog.md','utf8');
  const rows=Object.fromEntries([...catalog.matchAll(/^\| ([A-Z0-9]+-\d{2}) \| .*? \| ([UCBAEON+]+) \| P0[^\n]*$/gm)]
    .map(match=>[match[1],match[2]!.split('+').sort().join('')]));
  // CACHE-07 was retired with FreeToken; keep the remaining finite matrix intact.
  expect(Object.keys(remainingVariants)).toHaveLength(100);
  for(const item of Object.values(remainingVariants))for(const layer of item.layers)expect(rows[item.id],item.id).toContain(layer);
  // The Docker-host session gate is deliberately not a Kubernetes phase.
  // Discover its real selected tests without executing hooks/containers, rather
  // than dropping the catalogue's browser layer or crediting it to Phase 5.
  const isolated=JSON.parse(execFileSync(process.execPath,['node_modules/@playwright/test/cli.js','test',
    '--config','regression/playwright.config.ts','--list','--reporter=json'],{
    env:{...process.env,REGRESSION_MODE:'auth-sessions'},encoding:'utf8',timeout:30_000,maxBuffer:2*1024*1024,
  }));
  const dedicated=new Map<string,Set<string>>();
  type DiscoverySuite={suites?:DiscoverySuite[];specs?:Array<{title:string;file:string}>};
  const visit=(suite:DiscoverySuite)=>{
    for(const spec of suite.specs??[]) {
      const layer=fileLayer(spec.file);expect(layer).toBe('B');
      for(const id of new Set(spec.title.match(/\b[A-Z][A-Z0-9]+-\d{2}\b/g)??[])) {
        expect(rows[id],id).toContain(layer);
        const layers=dedicated.get(id)??new Set<string>();layers.add(layer!);dedicated.set(id,layers);
      }
    }
    for(const child of suite.suites??[])visit(child);
  };
  visit(isolated);expect(dedicated.size).toBeGreaterThan(0);
  for(const id of new Set(Object.values(remainingVariants).map(item=>item.id))) {
    const layers=[...new Set([...Object.values(remainingVariants).filter(item=>item.id===id).flatMap(item=>item.layers),
      ...(dedicated.get(id)??[])])].sort().join('');
    expect(rows[id],id).toBe(layers);
  }
});
