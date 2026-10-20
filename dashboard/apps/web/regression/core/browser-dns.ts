import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {isIP} from 'node:net';
import {lookup} from 'node:dns/promises';
import {readPrivate,writePrivate} from './private-files.ts';
import {requireSafe} from './errors.ts';

export type LabDnsPlan={version:1;mappings:Array<{suffix:string;address:string;exact?:true}>};
export function labDnsPlan(value:unknown):LabDnsPlan {
  const plan=value as LabDnsPlan;
  requireSafe(plan?.version === 1 && Array.isArray(plan.mappings) && plan.mappings.length <= 64 &&
    Object.keys(plan).sort().join(',') === 'mappings,version','CONFIG');
  plan.mappings.forEach(item=>{
    requireSafe(item && /^[a-z0-9](?:[a-z0-9.-]{0,250}[a-z0-9])?\.local$/.test(item.suffix) &&
      !item.suffix.includes('..') && item.suffix.split('.').every(label=>label.length<=63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) &&
      isIP(item.address) === 4 && (Object.keys(item).sort().join(',') === 'address,suffix' ||
      (Object.keys(item).sort().join(',') === 'address,exact,suffix' && item.exact === true)),'CONFIG');
  });
  requireSafe(new Set(plan.mappings.map(item=>item.suffix)).size === plan.mappings.length,'CONFIG');
  return plan;
}

/** Shared private DNS plan. Keep HTTPS URL and Host/SNI intact; the caller's
 * test purpose chooses certificate policy. Never capture nested peer names. */
export function labDnsAddress(value:unknown,hostname:string):string|undefined {
  const mappings=labDnsPlan(value).mappings;
  const host=hostname.toLowerCase().replace(/\.$/,'');
  return mappings.find(item=>item.exact && host===item.suffix)?.address ??
    mappings.filter(item=>!item.exact && host.endsWith('.'+item.suffix))
      .sort((a,b)=>b.suffix.length-a.suffix.length)[0]?.address;
}
export function browserDnsArguments(value:unknown):string[] {
  const rules=labDnsPlan(value).mappings.map(item=>'MAP '+(item.exact?'':'*.')+item.suffix+' '+item.address);
  return rules.length ? ['--host-resolver-rules='+rules.join(',')+',EXCLUDE localhost'] : [];
}
export async function loadLabDns(directory=process.env.REGRESSION_INPUT_DIR ?? '/inputs'):Promise<LabDnsPlan|undefined> {
  const path=join(directory,'browser-dns.json');
  try {await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code === 'ENOENT')return undefined;throw error;}
  return labDnsPlan(JSON.parse(await readPrivate(path,64*1024)));
}
export async function loadBrowserDns(directory=process.env.REGRESSION_INPUT_DIR ?? '/inputs') {
  const plan=await loadRuntimeLabDns(directory);
  return plan?browserDnsArguments(plan):[];
}

/** Runtime additions belong to the current writable private run directory,
 * never the accepted /inputs mount (read-only in the external runner). */
export async function loadRuntimeLabDns(directory=process.env.REGRESSION_INPUT_DIR ?? '/inputs',runtimeDirectory=process.env.REGRESSION_RUN_DIR) {
  const base=await loadLabDns(directory);
  if(!runtimeDirectory)return base;
  const path=join(runtimeDirectory,'runtime-dns.json');
  try {await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return base;throw error;}
  const runtime=labDnsPlan(JSON.parse(await readPrivate(path,64*1024)));
  const plan:LabDnsPlan={version:1,mappings:[...(base?.mappings??[])]};
  for(const item of runtime.mappings) {
    requireSafe(item.exact===true,'CONFIG');
    const existing=labDnsAddress(plan,item.suffix);
    requireSafe(!existing||existing===item.address,'CONFIG');
    if(!existing)plan.mappings.push(item);
  }
  return labDnsPlan(plan);
}

let registration=Promise.resolve();
/** Add observed ready service origins, not public endpoints or peer suffixes. */
export async function registerRuntimeDnsOrigins(origins:string[],dashboardOrigin:string,directory=process.env.REGRESSION_INPUT_DIR ?? '/inputs') {
  const operation=registration.then(async()=>{
    const dashboard=new URL(dashboardOrigin);
    if(!dashboard.hostname.endsWith('.local'))return;
    requireSafe(dashboard.protocol==='https:' && !dashboard.username && !dashboard.password,'CONFIG');
    const hosts=[...new Set(origins.map(origin=>{
      const url=new URL(origin);
      requireSafe(url.protocol==='https:' && !url.username && !url.password,'CONFIG');
      return url.hostname;
    }).filter(host=>host!==dashboard.hostname && host.endsWith('.'+dashboard.hostname)))];
    if(!hosts.length)return;
    const addresses=await lookup(dashboard.hostname,{family:4,all:true});
    const unique=[...new Set(addresses.map(item=>item.address))];
    requireSafe(unique.length===1,'TLS');
    const address=unique[0]!;
    const runtimeDirectory=process.env.REGRESSION_RUN_DIR;
    requireSafe(runtimeDirectory,'PRIVATE_FILE');
    const plan=await loadRuntimeLabDns(directory,runtimeDirectory) ?? {version:1 as const,mappings:[]};
    for(const host of hosts) {
      const existing=labDnsAddress(plan,host);
      requireSafe(!existing||existing===address,'CONFIG');
      if(!existing)plan.mappings.push({suffix:host,address,exact:true});
    }
    await writePrivate(join(runtimeDirectory,'runtime-dns.json'),labDnsPlan({version:1,mappings:plan.mappings.filter(item=>item.exact)}));
  });
  registration=operation.catch(()=>{});
  await operation;
}
