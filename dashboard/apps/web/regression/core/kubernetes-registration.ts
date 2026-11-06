import {lstat} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {parseRegistration} from './lab-policy.ts';
import {readPrivate,writePrivate} from './private-files.ts';
import {HarnessError} from './errors.ts';

/** The native API account carries the current installation-owned endpoints.
 * A renamed dashboard is not a new lab. Preserve every non-endpoint identity
 * field (including unknown future fields); never adopt another registration or
 * alter its journals, settings, resources, reservation or cleanup evidence. */
export async function saveKubernetesRegistration(filename:string,value:unknown) {
  const current=parseRegistration(value);
  let exists=false;
  try {await lstat(filename);exists=true;}catch(error) {
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
  if(exists) {
    const previous=parseRegistration(JSON.parse(await readPrivate(filename)));
    const expected={...previous,dashboardUrl:current.dashboardUrl,identityUrl:current.identityUrl,
      nodeUids:[...previous.nodeUids].sort()};
    if(!isDeepStrictEqual(expected,{...current,nodeUids:[...current.nodeUids].sort()}))
      throw new HarnessError('IDENTITY','Failed','preflight');
    if(previous.dashboardUrl===current.dashboardUrl&&previous.identityUrl===current.identityUrl)return;
  }
  await writePrivate(filename,current);
}
