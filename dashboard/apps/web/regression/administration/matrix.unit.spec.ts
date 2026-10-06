import {test,expect} from '@playwright/test';
import {remainingCoverage,remainingIds,remainingPhases,remainingRequirements,remainingVariants,validateRemainingRegistry} from '../profiles/remaining-p0.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {readFile} from 'node:fs/promises';

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
    expect(remainingIds(mode)?.length).toBe(Object.values(remainingVariants).filter(item=>item.phase === phase).length+1);
    expect(remainingCoverage(mode,passed.filter(item=>item.variant !== 'final-idle')).complete).toBe(false);
    const fast=remainingRequirements(mode+'-fast')!;
    expect(fast.every(item=>['U','C'].includes(item.layer) && item.environment === 'fixture')).toBe(true);
    expect(remainingCoverage(mode,fast.map(item=>({...item,outcome:'Passed'}))).complete).toBe(false);
  }
});

test('HAR-10 every remaining variant retains its stable P0 catalogue ID and exact declared layers',evidenceAnnotations({id:'HAR-10',layer:'U'}),async()=>{
  const catalog=await readFile('../../../docs/development/regression-test-catalog.md','utf8');
  const rows=Object.fromEntries([...catalog.matchAll(/^\| ([A-Z0-9]+-\d{2}) \| .*? \| ([UCBAEON+]+) \| P0[^\n]*$/gm)]
    .map(match=>[match[1],match[2]!.split('+').sort().join('')]));
  expect(Object.keys(remainingVariants)).toHaveLength(99);
  for(const item of Object.values(remainingVariants))expect(rows[item.id],item.id).toBe([...item.layers].sort().join(''));
});
