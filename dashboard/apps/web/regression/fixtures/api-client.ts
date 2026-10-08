import {MagicStickApi} from '@magicstick/dashboard-api-client';

/** The actual shared client with a deliberately isolated transport. */
export function recordedApi(body: unknown, status = 200) {
  const requests: Array<{path: string; init: RequestInit}> = [];
  const api = new MagicStickApi({baseUrl: 'https://dashboard.example.local', fetch: async (input, init = {}) => {
    requests.push({path: new URL(String(input)).pathname, init});
    return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
  }});
  return {api, requests};
}
