import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';

export interface ProcessMember {pid:number;group:number;session:number;state:string;started:string}
export interface ProcessGroupState {state:'stopped'|'live'|'unknown';members:ProcessMember[];detail?:'unreadable'|'identity'|'overflow'}
const gone=(error:unknown)=>['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??'');

/** Read only stat, never command lines or environment (which can contain tokens).
 * comm may itself contain spaces and parentheses; fields follow its final ')'. */
export function processStat(body:string):ProcessMember {
  const end=body.lastIndexOf(')'),pid=Number(body.slice(0,body.indexOf(' '))),fields=body.slice(end+2).trim().split(/\s+/);
  const group=Number(fields[2]),session=Number(fields[3]),started=fields[19],state=fields[0];
  if(end<0||!Number.isSafeInteger(pid)||pid<1||!Number.isSafeInteger(group)||group<0||!Number.isSafeInteger(session)||session<0||
    !/^[RSDZTtXxKWPI]$/.test(state??'')||!/^\d+$/.test(started??''))throw new Error('Invalid process identity.');
  return {pid,group,session,state:state!,started:started!};
}
export function processBirth(pid:number,root='/proc'):string|undefined {
  try {const value=processStat(readFileSync(join(root,String(pid),'stat'),'utf8'));return value.pid===pid?value.started:undefined;}
  catch{return;}
}

/** kill(pgid,0) also succeeds for zombies. Only Z/X are incapable of future
 * writes; sleeping, stopped and uninterruptible workers remain live. An
 * incomplete inventory is never proof of termination. The birth check stops
 * a recycled leader PID from authorizing signals to an unrelated group. */
export function inspectLinuxGroup(pid:number,started:string|undefined,root='/proc'):ProcessGroupState {
  const first=scanLinuxGroup(pid,started,root);
  if(first.state!=='stopped')return first;
  // A worker can fork between listing /proc and becoming a zombie. A second
  // complete scan must find no new identity before "no future writers" is true.
  const second=scanLinuxGroup(pid,started,root);
  if(second.state!=='stopped')return second;
  if(second.members.some(member=>!first.members.some(old=>old.pid===member.pid&&old.started===member.started)))
    return {state:'unknown',members:second.members,detail:'identity'};
  return second;
}
function scanLinuxGroup(pid:number,started:string|undefined,root:string):ProcessGroupState {
  const members:ProcessMember[]=[];
  try {
    const names=readdirSync(root).filter(name=>/^\d+$/.test(name));
    if(names.length>65_536)return {state:'unknown',members,detail:'overflow'};
    for(const name of names) {
      let member:ProcessMember;
      try {member=processStat(readFileSync(join(root,name,'stat'),'utf8'));}
      catch(error){if(gone(error))continue;throw error;}
      if(member.pid!==Number(name))throw new Error('Invalid process identity.');
      if(member.group!==pid)continue;
      if(member.session!==pid||member.pid===pid&&member.started!==started)return {state:'unknown',members,detail:'identity'};
      if(members.length>=128)return {state:'unknown',members,detail:'overflow'};
      members.push(member);
    }
    // Inspect the leader again: it may have been recycled during enumeration.
    try {
      const leader=processStat(readFileSync(join(root,String(pid),'stat'),'utf8'));
      if(leader.pid!==pid||leader.started!==started||leader.group!==pid||leader.session!==pid)return {state:'unknown',members,detail:'identity'};
    }catch(error){if(!gone(error))throw error;}
    if(members.length&&!started)return {state:'unknown',members,detail:'identity'};
    return {state:members.some(member=>!['Z','X','x'].includes(member.state))?'live':'stopped',members};
  }catch{return {state:'unknown',members,detail:'unreadable'};}
}
