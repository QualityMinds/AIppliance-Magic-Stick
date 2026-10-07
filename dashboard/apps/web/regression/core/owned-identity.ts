import {randomBytes} from 'node:crypto';
import type {User} from '@magicstick/dashboard-contracts';
import type {LiveFoundation} from './live-foundation.ts';
import {AdministrationApi,AdministrationRejected} from './administration-api.ts';
import {requireSafe} from './errors.ts';
import type {CleanupAdapter} from './journal.ts';

/** The shared API identifies local users with source, not a mandatory local flag.
 * Cleanup requires an explicit local origin; missing or conflicting data is not
 * a reason to adopt an account. */
export const ownedLocalIdentity = (user:User) => user.source === 'local' && user.local !== false;

export class OwnedIdentityClient {
  readonly client:AdministrationApi;
  private readonly ids=new Map<string,string>();
  constructor(readonly live:LiveFoundation) {
    this.client=new AdministrationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard);
    live.registerDomainCleanup('identity',this.adapter());
  }
  async create(suffix:string,accessLevel:'user'|'viewer'|'operator'|'admin') {
    const username=this.live.journal.prefix+suffix;
    requireSafe(username.startsWith(this.live.journal.prefix) && /^[a-z0-9-]{1,63}$/.test(username),'OWNERSHIP');
    const before=await this.client.api.users(username,0,25);
    requireSafe(!before.users.some(item=>item.username === username),'OWNERSHIP');
    await this.live.journal.requested('identity',username);
    const initialPassword='Reg1!'+randomBytes(24).toString('base64url');
    const password='Reg2!'+randomBytes(24).toString('base64url');
    const body={username,firstName:'Regression',lastName:'Disposable',email:username+'@example.invalid',enabled:true,accessLevel,password:initialPassword,temporary:true};
    let user:User;
    try {user=await this.client.write({method:'POST',path:'/api/users',body},()=>this.client.api.createUser(body));}
    catch(error) {
      if(error instanceof AdministrationRejected && [400,403,409,422].includes(error.status) &&
        !(await this.client.api.users(username,0,25)).users.some(item=>item.username === username)) await this.live.journal.rejected('identity',username);
      throw error;
    }
    requireSafe(typeof user.id === 'string' && user.id.length > 0 && user.username === username,'OWNERSHIP');
    // Record an acknowledged creation before checking product postconditions.
    // A bad enabled/role/source response must not lose the UID needed for cleanup.
    this.ids.set(username,user.id); await this.live.journal.owned('identity',username,user.id);
    requireSafe(ownedLocalIdentity(user) && user.enabled === true && user.accessLevel === accessLevel,'API');
    return {user,initialPassword,password};
  }
  async current(user:User) {
    requireSafe(this.ids.get(user.username) === user.id,'OWNERSHIP');
    const matches=(await this.client.api.users(user.username,0,25)).users.filter(item=>item.username === user.username);
    requireSafe(matches.length === 1 && matches[0]!.id === user.id,'OWNERSHIP'); return matches[0]!;
  }
  async profile(user:User) {
    await this.current(user);
    const body={firstName:'Updated',lastName:'Regression',email:user.username+'@example.invalid'};
    return this.client.write({method:'PATCH',path:`/api/users/${user.id}`,body},()=>this.client.api.updateUser(user.id,body));
  }
  async enabled(user:User,enabled:boolean) {
    await this.current(user); const path=`/api/users/${user.id}/${enabled ? 'enable' : 'disable'}`;
    return this.client.write({method:'POST',path,body:{}},()=>this.client.api.setUserEnabled(user.id,enabled));
  }
  async roles(user:User,accessLevel:string) {
    await this.current(user); const body={accessLevel};
    return this.client.write({method:'PUT',path:`/api/users/${user.id}/roles`,body},()=>this.client.api.updateUserRoles(user.id,accessLevel));
  }
  async reset(user:User) {
    await this.current(user); const password='Reg3!'+randomBytes(24).toString('base64url'),body={password,temporary:true};
    await this.client.write({method:'PUT',path:`/api/users/${user.id}/password`,body},()=>this.client.api.resetUserPassword(user.id,password,true));
    return password;
  }
  adapter():CleanupAdapter {
    return {lookup:async entry=>{
      requireSafe(entry.kind === 'identity' && entry.name.startsWith(this.live.journal.prefix),'OWNERSHIP');
      const users=(await this.client.api.users(entry.name,0,25)).users.filter(item=>item.username === entry.name);
      requireSafe(users.length <= 1,'OWNERSHIP');
      if(users.length) requireSafe(users[0]!.id === entry.uid && ownedLocalIdentity(users[0]!) && users[0]!.capabilities?.isProtected !== true,'OWNERSHIP');
      return users.length ? {uid:users[0]!.id} : null;
    },removeIfUid:async(entry,uid)=>{
      requireSafe(uid === entry.uid && this.ids.get(entry.name) === uid,'OWNERSHIP');
      const body={usernameConfirmation:entry.name};
      await this.client.write({method:'DELETE',path:`/api/users/${uid}`,body},()=>this.client.api.deleteUser(uid,entry.name));
    },verifyRemoved:async entry=>!(await this.client.api.users(entry.name,0,25)).users.some(item=>item.id === entry.uid || item.username === entry.name)};
  }
}
