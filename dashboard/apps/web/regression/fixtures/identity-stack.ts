// SPDX-License-Identifier: BUSL-1.1
// A Docker-host-only protocol fixture, never an installed-appliance adapter.
import {execFile} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

const execute = promisify(execFile);
// Match the appliance's pinned versions, including cookie/refresh behaviour.
const keycloakImage = 'quay.io/keycloak/keycloak:26.6.3@sha256:9b0330756022422149aa6502eb2def8cd47c6e1b000c7c65cdb13e7c0133e992';
const envoyImage = 'docker.io/envoyproxy/envoy:distroless-v1.38.7@sha256:3d79fb37be70734406e0d3b36189f662a2fd0d202813af492880aa3646426fda';
const clientId = 'magicstick-human-gateway-local';
const marker = 'magicstickRememberMePolicyVersion';
export const accessSeconds = 8;
export const idleSeconds = 10;
// Keycloak can allow an idle grace window of 120 seconds. The test must expire
// through idle, not accidentally through its (much later) maximum lifetime.
export const idleProbeSeconds = idleSeconds + 125;
export const maximumSeconds = 45;

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((done, fail) => {server.once('error', fail); server.listen(0, '127.0.0.1', done);});
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Identity fixture could not allocate a loopback port');
  const port = address.port;
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  return port;
}

export type SessionPolicy = {rememberMe:boolean; accessTokenLifespan:number; ssoSessionIdleTimeout:number;
  ssoSessionMaxLifespan:number; ssoSessionIdleTimeoutRememberMe:number; ssoSessionMaxLifespanRememberMe:number;
  attributes:Record<string,string>};

export class IdentityStack {
  readonly username = 'session-fixture';
  readonly password = randomBytes(24).toString('hex');
  private readonly clientSecret = randomBytes(32).toString('hex');
  private readonly suffix = randomUUID().slice(0, 12);
  private readonly network = `magicstick-auth-${this.suffix}`;
  private readonly keycloak = `${this.network}-keycloak`;
  private readonly envoy = `${this.network}-envoy`;
  private directory = '';
  origin = '';
  private issuer = '';

  private async docker(args:string[], timeout = 60_000) {
    try {
      return (await execute('docker', args, {timeout, maxBuffer: 4 * 1024 * 1024})).stdout.trim();
    } catch (error) {
      // Never forward command stdout/stderr: import files, OAuth responses and
      // admin CLI errors may contain synthetic credentials or browser tokens.
      const stderr = String((error as {stderr?:string}).stderr ?? '');
      const policy = /Remember-me migration: (READ|VERSION|AUTH|PRIVATE_FILE|CHANGED|WRITE|PERMISSION|VERIFY);/.exec(stderr)?.[1];
      const category = policy ?? (/mount|mkdir|file sharing/i.test(stderr) ? 'mount' :
        /port is already allocated|address already in use/i.test(stderr) ? 'port' :
        /permission denied|connect to.*daemon/i.test(stderr) ? 'daemon access' :
        /manifest|pull access|image.*not found/i.test(stderr) ? 'image' : 'runtime');
      throw new Error(`Isolated identity fixture Docker ${args[0]} failed (${category})`);
    }
  }
  private async file(name:string, value:unknown, readableInContainer = false) {
    const path = join(this.directory, name);
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), {mode:0o600});
    // The parent remains 0700; mounted config files need the container UID's
    // read permission, without exposing credentials elsewhere on the host.
    if (readableInContainer) await chmod(path, 0o644);
    return path;
  }
  private async admin(args:string[]) {
    return await this.docker(['exec', this.keycloak, '/opt/keycloak/bin/kcadm.sh', ...args,
      '--config', '/tmp/session-fixture-admin.config']);
  }
  async policy():Promise<SessionPolicy> {
    const value = await this.admin(['get', 'realms/magicstick', '--fields',
      `rememberMe,accessTokenLifespan,ssoSessionIdleTimeout,ssoSessionMaxLifespan,ssoSessionIdleTimeoutRememberMe,ssoSessionMaxLifespanRememberMe,attributes(${marker},unrelated)`]);
    try {return JSON.parse(value) as SessionPolicy;}
    catch {throw new Error('Isolated identity policy readback was malformed');}
  }
  async migrate() {
    try {
      return await this.docker(['exec', this.keycloak, '/bin/sh', '/opt/magicstick/keycloak-session-policy.sh',
        '/tmp/session-fixture-reader.config'], 180_000);
    } catch (error) {
      // Only the policy marker's shape, never a complete realm/CLI error.
      const value = JSON.parse(await this.admin(['get', 'realms/magicstick', '--fields', `attributes(${marker})`]));
      const type = typeof value?.attributes?.[marker];
      throw new Error(`${(error as Error).message}; reviewed-marker type=${type}, present=${Object.hasOwn(value?.attributes ?? {}, marker)}`);
    }
  }
  async oldDefaults() {
    await this.admin(['update', 'realms/magicstick', '-s', 'attributes={"unrelated":"preserve"}',
      '-s', 'ssoSessionIdleTimeoutRememberMe=0', '-s', 'ssoSessionMaxLifespanRememberMe=0']);
  }
  async accelerate(mode:'idle'|'remember-maximum'|'normal-maximum' = 'idle') {
    const remembered = mode === 'remember-maximum', normal = mode === 'normal-maximum';
    // Keycloak 26.6 takes max(normal, remember-me), not an arbitrary shorter
    // remember-me limit. Preserve the production ordering when accelerating.
    const normalMaximum = normal ? maximumSeconds : remembered ? 20 : 600;
    await this.admin(['update', 'realms/magicstick', '-s', `accessTokenLifespan=${accessSeconds}`,
      '-s', `ssoSessionIdleTimeout=${normal ? 30 : idleSeconds}`, '-s', `ssoSessionMaxLifespan=${normalMaximum}`,
      '-s', `ssoSessionIdleTimeoutRememberMe=${remembered ? 30 : 300}`,
      '-s', `ssoSessionMaxLifespanRememberMe=${remembered ? maximumSeconds : 600}`]);
  }
  async start() {
    this.directory = await mkdtemp(join(tmpdir(), 'magicstick-auth-'));
    await chmod(this.directory, 0o700);
    try {
      const [gatewayPort, identityPort] = await Promise.all([unusedPort(), unusedPort()]);
      this.origin = `http://localhost:${gatewayPort}`;
      this.issuer = `http://localhost:${identityPort}`;
      const source = resolve('../../../magic-cluster/platform/identity');
      const result = await execute('python3', ['-c',
        'import json,sys,yaml;print(yaml.safe_load(open(sys.argv[1]))["data"]["magicstick-realm.json"])',
        join(source, 'keycloak-realm.yaml')], {timeout:10_000});
      const realm = JSON.parse(result.stdout);
      // Retain the actual realm policy and gateway client contract. Replace
      // every deployment secret and user; this stack never reads a lab profile.
      const client = realm.clients.find((value:{clientId:string}) => value.clientId === clientId);
      Object.assign(client, {secret:this.clientSecret, redirectUris:[`${this.origin}/oauth2/callback`],
        webOrigins:[this.origin], attributes:{'post.logout.redirect.uris':`${this.origin}/*`}});
      Object.assign(realm, {sslRequired:'none', clients:[client, {
        clientId:'session-fixture-reader', enabled:true, secret:this.clientSecret, protocol:'openid-connect',
        publicClient:false, standardFlowEnabled:false, serviceAccountsEnabled:true,
      }], users:[{username:this.username, enabled:true, email:'fixture@example.com', emailVerified:true,
        firstName:'Session', lastName:'Fixture', credentials:[{type:'password', value:this.password, temporary:false}]},
      {username:'service-account-session-fixture-reader', enabled:true, serviceAccountClientId:'session-fixture-reader',
        clientRoles:{'realm-management':['view-realm']}}]});
      const realmFile = await this.file('realm.json', realm, true);
      const migration = await this.file('policy.sh', await readFile(join(source, 'keycloak-session-policy.sh'), 'utf8'), true);
      const environment = await this.file('keycloak.env', [
        'KC_BOOTSTRAP_ADMIN_USERNAME=fixture-admin', `KC_BOOTSTRAP_ADMIN_PASSWORD=${randomBytes(24).toString('hex')}`,
        `SESSION_FIXTURE_CLIENT_SECRET=${this.clientSecret}`, `KC_HOSTNAME=${this.issuer}`, 'KC_HTTP_ENABLED=true',
      ].join('\n') + '\n');
      // Use an explicit, dedicated fixture subnet: developer daemons may have
      // exhausted Docker's automatic pools. Never prune another project's nets.
      const subnet = `10.254.${randomBytes(1)[0]}.0/24`;
      await this.docker(['network', 'create', '--subnet', subnet,
        '--label', 'magicstick.session-fixture=true', this.network]);
      await this.docker(['run', '-d', '--name', this.keycloak, '--label', 'magicstick.session-fixture=true',
        '--network', this.network, '--network-alias', 'keycloak', '-p', `127.0.0.1:${identityPort}:8080`,
        '--env-file', environment, '--mount', `type=bind,source=${realmFile},target=/opt/keycloak/data/import/realm.json,readonly`,
        '--mount', `type=bind,source=${migration},target=/opt/magicstick/keycloak-session-policy.sh,readonly`,
        keycloakImage, 'start-dev', '--import-realm'], 180_000);
      const deadline = Date.now() + 120_000;
      let ready = false;
      while (Date.now() < deadline) {
        try {ready = (await fetch(`${this.issuer}/realms/magicstick/.well-known/openid-configuration`,
          {signal:AbortSignal.timeout(2000)})).ok;} catch { /* bounded readiness */ }
        if (ready) break;
        await new Promise(done => setTimeout(done, 1000));
      }
      if (!ready) throw new Error('Isolated Keycloak did not become ready within 120 seconds');
      await this.docker(['exec', this.keycloak, '/bin/sh', '-ec',
        'umask 077; /opt/keycloak/bin/kcadm.sh config credentials --config /tmp/session-fixture-admin.config --server http://localhost:8080 --realm master --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null 2>&1; ' +
        '/opt/keycloak/bin/kcadm.sh config credentials --config /tmp/session-fixture-reader.config --server http://localhost:8080 --realm magicstick --client session-fixture-reader --secret "$SESSION_FIXTURE_CLIENT_SECRET" >/dev/null 2>&1']);
      const config = this.envoyConfig();
      const envoyFile = await this.file('envoy.json', config, true);
      await this.docker(['run', '-d', '--name', this.envoy, '--label', 'magicstick.session-fixture=true',
        '--network', this.network, '-p', `127.0.0.1:${gatewayPort}:10000`,
        '--mount', `type=bind,source=${envoyFile},target=/etc/envoy/session.json,readonly`,
        envoyImage, '-c', '/etc/envoy/session.json', '--disable-hot-restart', '--log-level', 'error']);
      let gatewayReady = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {gatewayReady = (await fetch(`${this.origin}/health`, {signal:AbortSignal.timeout(2000)})).ok;}
        catch { /* bounded readiness, never a successful test assertion */ }
        if (gatewayReady) break;
        await new Promise(done => setTimeout(done, 500));
      }
      if (!gatewayReady) throw new Error('Isolated Envoy did not become ready within 15 seconds');
    } catch (error) {await this.stop(); throw error;}
  }
  private envoyConfig() {
    const path = '/realms/magicstick/protocol/openid-connect';
    const address = (host:string, port:number) => ({socket_address:{address:host, port_value:port}});
    return {static_resources:{
      secrets:[{name:'client', generic_secret:{secret:{inline_string:this.clientSecret}}},
        {name:'hmac', generic_secret:{secret:{inline_string:randomBytes(32).toString('hex')}}}],
      clusters:[{name:'keycloak', connect_timeout:'2s', type:'STRICT_DNS',
        load_assignment:{cluster_name:'keycloak', endpoints:[{lb_endpoints:[{endpoint:{address:address('keycloak',8080)}}]}]}}],
      listeners:[{name:'gateway', address:address('0.0.0.0',10000), filter_chains:[{filters:[{
        name:'envoy.filters.network.http_connection_manager', typed_config:{
          '@type':'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
          stat_prefix:'identity', route_config:{name:'fixture', virtual_hosts:[{name:'fixture', domains:['*'], routes:[
            {match:{path:'/health'}, direct_response:{status:200, body:{inline_string:'ready'}}},
            {match:{prefix:'/protected'}, route:{cluster:'keycloak', prefix_rewrite:`${path}/userinfo`}},
            {match:{prefix:'/'}, direct_response:{status:404}},
          ]}]}, http_filters:[{name:'envoy.filters.http.oauth2', typed_config:{
            '@type':'type.googleapis.com/envoy.extensions.filters.http.oauth2.v3.OAuth2', config:{
              token_endpoint:{cluster:'keycloak', uri:`http://keycloak:8080${path}/token`, timeout:'5s'},
              authorization_endpoint:`${this.issuer}${path}/auth`, end_session_endpoint:`${this.issuer}${path}/logout`,
              credentials:{client_id:clientId, token_secret:{name:'client'}, hmac_secret:{name:'hmac'},
                cookie_names:{bearer_token:'MagicStickAccessToken', id_token:'MagicStickIDToken'}},
              redirect_uri:`${this.origin}/oauth2/callback`, redirect_path_matcher:{path:{exact:'/oauth2/callback'}},
              signout_path:{path:{exact:'/logout'}}, forward_bearer_token:true, use_refresh_token:true,
              auth_scopes:['openid','profile','email'],
              pass_through_matcher:[{name:':path', string_match:{exact:'/health'}}],
              deny_redirect_matcher:[{name:'x-session-fixture', string_match:{exact:'probe'}}],
            }}}, {name:'envoy.filters.http.router', typed_config:{'@type':'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router'}}],
        }}]}]}],
    }};
  }
  async stop() {
    // Exact random names only. No prune, host-network, privileged container or
    // Docker socket mount. Cleanup is retried even after partial startup.
    const errors:string[] = [];
    for (const name of [this.envoy, this.keycloak]) {
      try {await this.docker(['rm', '-f', name]);} catch { /* not created is fine */ }
      try {if (await this.docker(['ps', '-aq', '--filter', `name=^/${name}$`])) errors.push('container');}
      catch {errors.push('unverified container');}
    }
    try {await this.docker(['network', 'rm', this.network]);} catch { /* not created is fine */ }
    try {if (await this.docker(['network', 'ls', '-q', '--filter', `name=^${this.network}$`])) errors.push('network');}
    catch {errors.push('unverified network');}
    if (errors.length) throw new Error('Isolated identity fixture cleanup could not be verified');
    if (this.directory) await rm(this.directory, {recursive:true, force:true});
  }
}
