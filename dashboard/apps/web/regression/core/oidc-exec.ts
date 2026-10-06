import {spawn,spawnSync} from 'node:child_process';
import {lstat,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {request,Agent} from 'node:https';
import type {BrowserContext} from '@playwright/test';
import type {LabConfig} from './config.ts';
import {HarnessError,requireSafe} from './errors.ts';

interface OidcConfig {server:string;ca:Buffer;issuer:string;client:string;issuerCa:string}
export function inspectOidcConfig(value:unknown,identityOrigin:string):OidcConfig {
  requireSafe(value && typeof value === 'object','API');const config=value as Record<string,any>;
  requireSafe(config.apiVersion === 'v1' && config.kind === 'Config' && config.clusters?.length === 1 && config.users?.length === 1 && config.contexts?.length === 1,'API');
  const cluster=config.clusters[0].cluster,user=config.users[0].user,context=config.contexts[0];
  requireSafe(cluster && /^https:\/\//.test(cluster.server) && !cluster['insecure-skip-tls-verify'] && cluster['certificate-authority-data'] &&
    Object.keys(user).join(',') === 'exec' && user.exec.command === 'kubectl' && user.exec.apiVersion === 'client.authentication.k8s.io/v1' &&
    user.exec.args?.slice(0,2).join(',') === 'oidc-login,get-token' && user.exec.args.length === 7 && !user.exec.env &&
    context.context.cluster === config.clusters[0].name && context.context.user === config.users[0].name && config['current-context'] === context.name,'API');
  const args:string[]=user.exec.args.slice(2);const allowed=['--oidc-issuer-url=','--oidc-client-id=','--oidc-pkce-method=','--certificate-authority-data=','--token-cache-storage='];
  requireSafe(args.every(arg=>allowed.some(prefix=>arg.startsWith(prefix))) && allowed.every(prefix=>args.filter(arg=>arg.startsWith(prefix)).length === 1),'API');
  const get=(prefix:string)=>args.find(arg=>arg.startsWith(prefix))!.slice(prefix.length);
  const issuer=get('--oidc-issuer-url=');requireSafe(new URL(issuer).origin === identityOrigin && get('--oidc-pkce-method=') === 'S256' &&
    get('--token-cache-storage=') === 'keyring','API');
  const server=new URL(cluster.server);requireSafe(!server.username && !server.password && !server.search && !server.hash && server.pathname === '/','API');
  const ca=Buffer.from(cluster['certificate-authority-data'],'base64');requireSafe(ca.includes(Buffer.from('BEGIN CERTIFICATE')),'TLS');
  return {server:server.origin,ca,issuer,client:get('--oidc-client-id='),issuerCa:get('--certificate-authority-data=')};
}

export function parseKubeconfig(content:string,identityOrigin:string) {
  requireSafe(content.length < 64*1024 && !/\b(?:token|password|client-secret|refresh-token):/.test(content),'API');
  const result=spawnSync('python3',['-c','import sys,json,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))'],{input:content,encoding:'utf8',timeout:5000,maxBuffer:128*1024});
  requireSafe(result.status === 0,'API');return inspectOidcConfig(JSON.parse(result.stdout),identityOrigin);
}

/** Run the actual approved kubelogin exec plugin using its documented PKCE
 * authcode flow. Token/keyring output remains in memory only. CLI flags verified
 * against https://github.com/int128/kubelogin/blob/master/docs/usage.md. */
export async function executeOidc(context:BrowserContext,lab:LabConfig,oidc:OidcConfig,plugin:{filename:string;sha256:string}) {
  requireSafe(plugin.filename === '/inputs/kubectl-oidc_login' && /^[a-f0-9]{64}$/.test(plugin.sha256),'CONFIG');
  const stat=await lstat(plugin.filename);requireSafe(stat.isFile() && !stat.isSymbolicLink() && stat.size < 64*1024*1024 && !(stat.mode & 0o077) && stat.mode & 0o100,'PRIVATE_FILE');
  requireSafe(createHash('sha256').update(await readFile(plugin.filename)).digest('hex') === plugin.sha256,'CONFIG');
  const child=spawn(plugin.filename,['get-token',`--oidc-issuer-url=${oidc.issuer}`,`--oidc-client-id=${oidc.client}`,
    `--certificate-authority-data=${oidc.issuerCa}`,'--oidc-pkce-method=S256','--token-cache-storage=none','--skip-open-browser',
    '--grant-type=authcode','--authentication-timeout-sec=180'],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,
      KUBERNETES_EXEC_INFO:JSON.stringify({apiVersion:'client.authentication.k8s.io/v1',kind:'ExecCredential',spec:{interactive:true}})}});
  let stdout='',stderr='',authStarted=false,login:Promise<void>|undefined;
  const result=new Promise<string>((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new HarnessError('AUTH'));},190_000);
    child.stdout.on('data',(chunk:Buffer)=>{stdout+=chunk.toString();if(stdout.length > 64*1024)child.kill('SIGKILL');});
    child.stderr.on('data',(chunk:Buffer)=>{
      stderr+=chunk.toString();if(stderr.length > 32*1024){child.kill('SIGKILL');return;}
      const candidate=stderr.match(/https:\/\/[^\s\x1b<>"']+/)?.[0];if(!candidate || authStarted)return;
      try {
        const url=new URL(candidate),redirect=new URL(url.searchParams.get('redirect_uri') ?? '');
        requireSafe(url.origin === lab.identityUrl && url.searchParams.get('client_id') === oidc.client && url.searchParams.get('response_type') === 'code' &&
          url.searchParams.get('code_challenge_method') === 'S256' && ['http://localhost:8000','http://localhost:18000','http://127.0.0.1:8000','http://127.0.0.1:18000'].includes(redirect.origin),'AUTH');
        authStarted=true;login=(async()=>{
          const page=await context.newPage();
          try {
            await page.route(redirect.origin+'/**',async route=>{requireSafe(route.request().method() === 'GET' && new URL(route.request().url()).origin === redirect.origin,'AUTH');await route.continue();});
            await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:lab.loginTimeoutMs});
            requireSafe(new URL(page.url()).origin === redirect.origin,'AUTH');
          } finally {await page.close();}
        })();login.catch(()=>child.kill('SIGKILL'));
      } catch {child.kill('SIGKILL');}
    });
    child.on('error',()=>{clearTimeout(timer);reject(new HarnessError('PREREQUISITE'));});
    child.on('close',async code=>{
      clearTimeout(timer);
      try {requireSafe(code === 0 && authStarted && login,'AUTH');await login;const response=JSON.parse(stdout);
        requireSafe(response.kind === 'ExecCredential' && response.apiVersion === 'client.authentication.k8s.io/v1' && typeof response.status?.token === 'string' &&
          response.status.token.length < 32*1024 && Date.parse(response.status.expirationTimestamp) > Date.now(),'AUTH');resolve(response.status.token);
      } catch {reject(new HarnessError('AUTH'));}
    });
  });return result;
}

/** Bearer data is kept in memory and the cluster's downloaded CA is mandatory. */
export async function identityKubeRequest(oidc:OidcConfig,token:string,path:string,body?:unknown,method='GET') {
  requireSafe(/^\/(?:api\/v1|apis\/authorization\.k8s\.io\/v1|apis\/appliance\.magicstick\.dev\/v1alpha1)\//.test(path) &&
    !path.includes('..') && !path.includes('?') && !path.includes('#'),'MUTATION');
  return new Promise<{status:number;value:Record<string,any>}>((resolve,reject)=>{
    const agent=new Agent({ca:oidc.ca}),req=request(oidc.server+path,{agent,method,headers:{Authorization:'Bearer '+token,Accept:'application/json',
      ...(body ? {'Content-Type':'application/json'} : {})}},response=>{
      let raw=Buffer.alloc(0);response.on('data',(chunk:Buffer)=>{raw=Buffer.concat([raw,chunk]);if(raw.length > 2*1024*1024)req.destroy();});
      response.on('end',()=>{agent.destroy();try {resolve({status:response.statusCode ?? 0,value:JSON.parse(raw.toString())});}catch{reject(new HarnessError('API'));}});
    });req.setTimeout(15_000,()=>req.destroy());req.on('error',()=>{agent.destroy();reject(new HarnessError('API'));});req.end(body ? JSON.stringify(body) : undefined);
  });
}
