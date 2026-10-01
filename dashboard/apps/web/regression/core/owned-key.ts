import type {APIRequestContext} from '@playwright/test';
import {MagicStickApi} from '@magicstick/dashboard-api-client';
import type {ApiAccessPayload} from '@magicstick/dashboard-contracts';
import {HarnessError, requireSafe} from './errors.ts';
import type {CleanupAdapter, JournalEntry} from './journal.ts';

/** Only the API-key collection and exact journal-owned immutable IDs are writable. */
export class OwnedKeyClient {
  private readonly api: MagicStickApi;
  private readonly ownedIds = new Set<string>();
  constructor(request: APIRequestContext, baseUrl: string, timeoutMs: number, private prefix: string, journal: ReadonlyArray<JournalEntry>) {
    for (const item of journal) if (item.kind === 'key' && item.uid && item.name.startsWith(prefix)) this.ownedIds.add(item.uid);
    const origin = new URL(baseUrl).origin;
    const transport: typeof fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      const method = String(init.method ?? 'GET').toUpperCase();
      requireSafe(url.origin === origin && !url.search && !url.hash, 'MUTATION');
      if (method === 'GET') requireSafe(url.pathname === '/api/api-access' && !init.body, 'MUTATION');
      else if (method === 'POST') {
        requireSafe(url.pathname === '/api/api-access' && typeof init.body === 'string', 'MUTATION');
        let payload: unknown;
        try { payload = JSON.parse(init.body); } catch { throw new HarnessError('MUTATION'); }
        requireSafe(payload && typeof payload === 'object' && !Array.isArray(payload) &&
          Object.keys(payload).length === 1 && typeof (payload as {name?: unknown}).name === 'string' &&
          (payload as {name: string}).name.startsWith(prefix), 'MUTATION');
      } else if (method === 'DELETE') {
        const match = url.pathname.match(/^\/api\/api-access\/([A-Za-z0-9._:-]{16,256})$/);
        requireSafe(match && this.ownedIds.has(match[1]!) && !init.body, 'MUTATION');
      } else throw new HarnessError('MUTATION');
      const headers = new Headers(init.headers);
      if (method !== 'GET') headers.set('Origin', origin);
      let response;
      try {
        response = await request.fetch(url.href, {method, headers: Object.fromEntries(headers.entries()),
          ...(init.body ? {data: String(init.body)} : {}), timeout: timeoutMs, maxRedirects: 0, failOnStatusCode: false});
      } catch { throw new HarnessError('API'); }
      requireSafe(response.status() >= 200 && response.status() < 300 &&
        (response.headers()['content-type'] ?? '').includes('application/json'), 'API');
      const body = await response.body();
      requireSafe(body.length < 2 * 1024 * 1024, 'API');
      return new Response(body.toString('utf8'), {status: response.status(), headers: {'Content-Type': 'application/json'}});
    };
    this.api = new MagicStickApi({baseUrl, fetch: transport});
  }

  async list(): Promise<ApiAccessPayload> {
    try {
      const result = await this.api.apiAccess();
      requireSafe(Array.isArray(result.items), 'API');
      return result;
    } catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError('API'); }
  }

  async createCredential(name: string): Promise<{id: string; secret: string}> {
    requireSafe(name.startsWith(this.prefix) && /^[a-z0-9][a-z0-9-]{0,62}$/.test(name), 'OWNERSHIP');
    try {
      const result = await this.api.createApiKey(name);
      const item = result.item as {id?: unknown; name?: unknown};
      requireSafe(item && typeof item.id === 'string' && /^[A-Za-z0-9._:-]{16,256}$/.test(item.id) && item.name === name &&
        typeof result.key === 'string' && result.key.startsWith('sk-'), 'API');
      this.ownedIds.add(item.id);
      return {id: item.id, secret: result.key};
    } catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError('API'); }
  }

  async create(name: string): Promise<string> { return (await this.createCredential(name)).id; }

  adapter(): CleanupAdapter {
    return {
      lookup: async entry => {
        requireSafe(entry.kind === 'key' && entry.name.startsWith(this.prefix), 'OWNERSHIP');
        const matches = (await this.list()).items.filter(item => item.name === entry.name);
        requireSafe(matches.length <= 1, 'OWNERSHIP');
        return matches.length ? {uid: matches[0]!.id} : null;
      },
      removeIfUid: async (entry, uid) => {
        requireSafe(entry.uid === uid && this.ownedIds.has(uid), 'OWNERSHIP');
        try { await this.api.revokeApiKey(uid); }
        catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError('CLEANUP'); }
      },
      verifyRemoved: async entry => !(await this.list()).items.some(item => item.id === entry.uid || item.name === entry.name),
    };
  }
}
