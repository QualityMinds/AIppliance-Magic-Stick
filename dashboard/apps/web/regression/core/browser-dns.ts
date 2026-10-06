import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {isIP} from 'node:net';
import {readPrivate} from './private-files.ts';
import {requireSafe} from './errors.ts';

/** Chromium-only resolution for per-instance mDNS routes. TLS/SNI and HTTP
 * origin checks remain intact; no proxy, wildcard certificates or CA bypass. */
export function browserDnsArguments(value:unknown):string[] {
  const plan=value as {version:number;mappings:Array<{suffix:string;address:string}>};
  requireSafe(plan?.version === 1 && Array.isArray(plan.mappings) && plan.mappings.length <= 10,'CONFIG');
  const rules=plan.mappings.map(item=>{
    requireSafe(item && /^[a-z0-9](?:[a-z0-9.-]{0,250}[a-z0-9])?\.local$/.test(item.suffix) &&
      !item.suffix.includes('..') && isIP(item.address) === 4 && Object.keys(item).sort().join(',') === 'address,suffix','CONFIG');
    return 'MAP *.'+item.suffix+' '+item.address;
  });
  requireSafe(new Set(plan.mappings.map(item=>item.suffix)).size === rules.length,'CONFIG');
  return rules.length ? ['--host-resolver-rules='+rules.join(',')+',EXCLUDE localhost'] : [];
}
export async function loadBrowserDns(directory=process.env.REGRESSION_INPUT_DIR ?? '/inputs') {
  const path=join(directory,'browser-dns.json');
  try {await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code === 'ENOENT')return [];throw error;}
  return browserDnsArguments(JSON.parse(await readPrivate(path)));
}
