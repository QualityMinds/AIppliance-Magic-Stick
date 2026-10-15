import {test,expect} from '@playwright/test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawn} from 'node:child_process';
import {createServer} from 'node:https';
import {browserDnsArguments,labDnsAddress,labDnsPlan} from '../core/browser-dns.ts';
import {writePrivate} from '../core/private-files.ts';

test('HAR-02 service DNS uses exact appliance origins without capturing a nested peer',()=>{
  const plan={version:1,mappings:[{suffix:'anythingllm.appliance.local',address:'192.0.2.10',exact:true},
    {suffix:'hermes.appliance.local',address:'192.0.2.10'}]};
  expect(labDnsAddress(plan,'anythingllm.appliance.local')).toBe('192.0.2.10');
  expect(labDnsAddress(plan,'run.hermes.appliance.local.')).toBe('192.0.2.10');
  for(const host of ['monster.appliance.local','id.monster.appliance.local','anythingllm.appliance.local.evil.test','other.local'])
    expect(labDnsAddress(plan,host)).toBeUndefined();
  expect(browserDnsArguments(plan)[0]).toContain('MAP anythingllm.appliance.local 192.0.2.10');
  for(const mappings of [[{suffix:'bad.local,MAP * x',address:'192.0.2.10'}],
    [{suffix:'a.local',address:'192.0.2.10',exact:false}],
    [{suffix:'a.local',address:'192.0.2.10'},{suffix:'a.local',address:'192.0.2.11'}],
    [{suffix:'a..local',address:'192.0.2.10'}],[{suffix:'a.local',address:'127.0.0.1;command'}]])
    expect(()=>labDnsPlan({version:1,mappings})).toThrow('[CONFIG]');
});

async function child(directory:string,code:string,trust?:string) {
  return await new Promise<string>((resolve,reject)=>{
    const env:NodeJS.ProcessEnv={...process.env,REGRESSION_INPUT_DIR:directory,REGRESSION_RUN_DIR:join(directory,'run'),NODE_OPTIONS:'--import='+new URL('../core/lab-dns.mjs',import.meta.url).href};
    delete env.NODE_EXTRA_CA_CERTS;
    if(trust)env.NODE_EXTRA_CA_CERTS=trust;
    const processChild=spawn(process.execPath,['--input-type=module','-e',code],{env,stdio:['ignore','pipe','pipe']});
    let output='';processChild.stdout.on('data',chunk=>{output+=chunk;});
    processChild.stderr.resume();
    const timeout=setTimeout(()=>{processChild.kill('SIGKILL');reject(new Error('Synthetic DNS child deadline'));},20_000);
    processChild.once('error',error=>{clearTimeout(timeout);reject(error);});
    processChild.once('exit',status=>{clearTimeout(timeout);status===0?resolve(output):reject(new Error('Synthetic DNS child failed'));});
  });
}

test('HAR-02 Playwright API resolves ready mDNS service names but still rejects untrusted or wrong-host TLS',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'regression-dns-'));
  let server:ReturnType<typeof createServer>|undefined;
  try {
    const key=join(directory,'key.pem'),cert=join(directory,'ca.pem');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,
      '-subj','/CN=Synthetic Regression DNS','-days','1','-addext','basicConstraints=critical,CA:TRUE',
      '-addext','subjectAltName=DNS:service.fixture.local'],{stdio:'pipe'});
    server=createServer({key:await readFile(key),cert:await readFile(cert)},(_request,response)=>{response.end('synthetic-ok');});
    await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
    const port=(server.address() as {port:number}).port;
    await writePrivate(join(directory,'browser-dns.json'),{version:1,mappings:[{suffix:'fixture.local',address:'127.0.0.1',exact:true}]});
    const register=new URL('../core/browser-dns.ts',import.meta.url).href;
    const code=`import {request} from '@playwright/test';
      import {registerRuntimeDnsOrigins} from ${JSON.stringify(register)};
      await registerRuntimeDnsOrigins(['https://service.fixture.local','https://wrong.fixture.local','https://foreign.example.test'],'https://fixture.local');
      const api=await request.newContext(); const results=[];
      for(const host of ['service.fixture.local','wrong.fixture.local']) {
        try {const result=await api.get('https://'+host+':'+${port},{timeout:5000});results.push(result.status()===200);}
        catch {results.push(false);}
      } await api.dispose(); console.log(JSON.stringify(results));`;
    expect(JSON.parse(await child(directory,code,cert))).toEqual([true,false]);
    expect(JSON.parse(await child(directory,code))).toEqual([false,false]);
    const original=JSON.parse(await readFile(join(directory,'browser-dns.json'),'utf8'));
    expect(original.mappings).toHaveLength(1);
    const plan=JSON.parse(await readFile(join(directory,'run','runtime-dns.json'),'utf8'));
    expect(plan.mappings.map((item:{suffix:string})=>item.suffix).sort()).toEqual(['fixture.local','service.fixture.local','wrong.fixture.local']);
    expect(labDnsAddress(plan,'monster.fixture.local')).toBeUndefined();
  }finally {
    if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
    await rm(directory,{recursive:true,force:true});
  }
});
