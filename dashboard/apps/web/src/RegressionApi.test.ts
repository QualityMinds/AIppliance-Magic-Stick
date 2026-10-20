import {describe,expect,it,vi} from 'vitest';
import {MagicStickApi,ApiError} from '@magicstick/dashboard-api-client';

describe('Shared regression API contract',()=>{
  it('sends the selected immutable test mode without silently upgrading a non-destructive request',async()=>{
    const fetch=vi.fn().mockImplementation(async()=>new Response('{}',{headers:{'content-type':'application/json'}}));
    const client=new MagicStickApi({fetch});
    for(const testMode of ['non-destructive','full'] as const)await client.startRegression('a'.repeat(32),[3],testMode);
    expect(fetch.mock.calls.map(call=>JSON.parse(call[1].body).testMode)).toEqual(['non-destructive','full']);
  });
  it('requests only exact revision-bound cleanup over the normal authenticated CSRF transport',async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response('{}',{headers:{'content-type':'application/json'}}));
    const client=new MagicStickApi({baseUrl:'https://dashboard.example.local',fetch,getAccessToken:async()=>'synthetic-test-token'});
    await client.recoverRegressionLock('a'.repeat(32),'11111111-2222-3333-4444-555555555555:42');
    const [url,options]=fetch.mock.calls[0]!;
    expect(url).toBe('https://dashboard.example.local/api/regression/recover-lock');expect(options.method).toBe('POST');
    expect(options.headers.get('Authorization')).toBe('Bearer synthetic-test-token');
    expect(options.headers.get('X-MagicStick-CSRF')).toBe('dashboard');
    expect(JSON.parse(options.body)).toEqual({requestId:'a'.repeat(32),expectedLockRevision:'11111111-2222-3333-4444-555555555555:42',acknowledgeCleanup:true});
  });
  it('uses the regular authenticated and CSRF-protected intent path without client Job writes',async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response('{}',{headers:{'content-type':'application/json'}}));
    const client=new MagicStickApi({baseUrl:'https://dashboard.example.local',fetch,getAccessToken:async()=>'synthetic-test-token'});
    await client.startRegression('a'.repeat(32));
    const [url,options]=fetch.mock.calls[0]!;
    expect(url).toBe('https://dashboard.example.local/api/regression/runs');
    expect(options.method).toBe('POST');expect(options.credentials).toBe('omit');
    expect(options.headers.get('Authorization')).toBe('Bearer synthetic-test-token');
    expect(options.headers.get('X-MagicStick-CSRF')).toBe('dashboard');
    expect(JSON.parse(options.body)).toEqual({requestId:'a'.repeat(32),acknowledgeDisruption:true});
  });
  it('downloads the bounded report through authenticated API transport rather than an uncredentialed anchor',async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response('filtered-report',{headers:{'content-type':'application/gzip'}}));
    const client=new MagicStickApi({fetch,getAccessToken:async()=>'synthetic-test-token'});
    expect(await (await client.downloadRegression('regression-'+'a'.repeat(32))).text()).toBe('filtered-report');
    const [url,options]=fetch.mock.calls[0]!;expect(url).toBe('/api/regression/runs/regression-'+'a'.repeat(32)+'/archive');
    expect(options.headers.get('Authorization')).toBe('Bearer synthetic-test-token');expect(options.cache).toBe('no-store');
  });
  it('sends an explicit single or non-consecutive phase selection without changing the normal start transport',async()=>{
    const fetch=vi.fn().mockImplementation(async()=>new Response('{}',{headers:{'content-type':'application/json'}}));
    const client=new MagicStickApi({fetch});
    await client.startRegression('a'.repeat(32),[3]);
    await client.startRegression('b'.repeat(32),[3,5]);
    for(const [index,phases] of [[0,[3]],[1,[3,5]]] as const) {
      const [url,options]=fetch.mock.calls[index]!;
      expect(url).toBe('/api/regression/runs');expect(options.method).toBe('POST');
      expect(options.headers.get('X-MagicStick-CSRF')).toBe('dashboard');
      expect(JSON.parse(options.body)).toEqual({requestId:(index?'b':'a').repeat(32),acknowledgeDisruption:true,phases});
    }
  });
  it('keeps same-origin cookies for the Web client and returns a safe unavailable-report error',async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response('private upstream body',{status:409}));
    const client=new MagicStickApi({fetch});
    await expect(client.downloadRegression('fixture','junit')).rejects.toThrow(ApiError);
    expect(fetch.mock.calls[0]![1].credentials).toBe('same-origin');
    await expect(client.downloadRegression('fixture','html')).rejects.not.toThrow('private upstream body');
  });
});
