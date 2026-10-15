import {test,expect} from '@playwright/test';
import {validationSession} from './validation-session.ts';

test('HW-06 UI pages close before long GPU work and fresh terminal pages are not reused across engines',async()=>{
  const events:string[]=[];let sequence=0,active=0;
  const open=async()=>{const id=++sequence;active++;events.push(`open-${id}`);return {id,close:async()=>{active--;events.push(`close-${id}`);}};};
  for(const engine of ['OLlama','VLLM']) {
    const accepted=await validationSession(open,async page=>{expect(active).toBe(1);events.push(`request-${page.id}`);return {engine,id:page.id};},
      async request=>{expect(active).toBe(0);events.push(`completed-${request.id}`);},
      async(page,request)=>{expect(active).toBe(1);expect(page.id).toBe(request.id+1);events.push(`inspect-${page.id}`);});
    expect(accepted.engine).toBe(engine);expect(active).toBe(0);
  }
  expect(events).toEqual(['open-1','request-1','close-1','completed-1','open-2','inspect-2','close-2',
    'open-3','request-3','close-3','completed-3','open-4','inspect-4','close-4']);
});

test('HW-06 an unsuccessful request is not retried and a page-close error cannot hide its original failure',async()=>{
  const primary=new Error('request failed');let opened=0,closed=0,completed=0;
  await expect(validationSession(async()=>{opened++;return {close:async()=>{closed++;throw new Error('close failed');}};},
    async()=>{throw primary;},async()=>{completed++;},async()=>{})).rejects.toBe(primary);
  expect({opened,closed,completed}).toEqual({opened:1,closed:1,completed:0});
});

test('HW-06 a failed native completion never opens a success page or repeats the submitted validation',async()=>{
  const primary=new Error('native validation failed');let opened=0,closed=0,requests=0,inspections=0;
  await expect(validationSession(async()=>{opened++;return {close:async()=>{closed++;}};},
    async()=>{requests++;return {requestId:'owned-request'};},async()=>{throw primary;},async()=>{inspections++;})).rejects.toBe(primary);
  expect({opened,closed,requests,inspections}).toEqual({opened:1,closed:1,requests:1,inspections:0});
});

test('HW-06 terminal UI failure remains visible and teardown cannot replace it or trigger another GPU request',async()=>{
  const primary=new Error('UI result failed');let opened=0,closed=0,requests=0,completed=0;
  await expect(validationSession(async()=>{const id=++opened;return {close:async()=>{closed++;if(id===2)throw new Error('close failed');}};},
    async()=>{requests++;return {};},async()=>{completed++;},async()=>{throw primary;})).rejects.toBe(primary);
  expect({opened,closed,requests,completed}).toEqual({opened:2,closed:2,requests:1,completed:1});
});
