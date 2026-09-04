import {
  sessionSchema,
  settingsSchema,
  type ApiAccessPayload,
  type Appliance,
  type DiscoveryArtifactsPayload,
  type DiscoverySearchPayload,
  type InstancesPayload,
  type KubernetesAccessPayload,
  type MemoryEstimate,
  type ModelsPayload,
  type ModulesPayload,
  type Session,
  type Settings,
  type SystemStatusPayload,
  type User,
  type UsersPayload,
} from '@magicstick/dashboard-contracts';

export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, status: number, details: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  getAccessToken?: () => string | undefined | Promise<string | undefined>;
}

const mutationMethod = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());

export class MagicStickApi {
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly getAccessToken?: ApiClientOptions['getAccessToken'];

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.fetchImpl = options.fetch;
    this.getAccessToken = options.getAccessToken;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (mutationMethod(method)) headers.set('X-MagicStick-CSRF', 'dashboard');
    const token = await this.getAccessToken?.();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const fetchImpl = this.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const response = await fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      method,
      headers,
      credentials: token ? 'omit' : 'same-origin',
      cache: 'no-store',
    });
    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => '');
    if (!response.ok) {
      const record = body && typeof body === 'object' ? body as Record<string, unknown> : null;
      const message = String(record?.message ?? record?.error ?? body ?? response.statusText);
      throw new ApiError(message || `Request failed with HTTP ${response.status}`, response.status, body);
    }
    return body as T;
  }

  async session(): Promise<Session> {
    return sessionSchema.parse(await this.request<unknown>('/api/session'));
  }

  async settings(): Promise<Settings> {
    return settingsSchema.parse(await this.request<unknown>('/api/settings'));
  }

  updateSettings(payload: Pick<Settings, 'publicDomain' | 'mdnsDomain'>) {
    return this.request<Settings>('/api/settings', {method: 'PATCH', body: JSON.stringify(payload)});
  }

  appliance() { return this.request<Appliance>('/api/appliance'); }
  modules() { return this.request<ModulesPayload>('/api/modules'); }
  instances() { return this.request<InstancesPayload>('/api/instances'); }
  models() { return this.request<ModelsPayload>('/api/models'); }
  status() { return this.request<SystemStatusPayload>('/api/status'); }

  enableModule(name: string, parameters: Record<string, string> = {}) {
    return this.request(`/api/modules/${encodeURIComponent(name)}/enable`, {
      method: 'POST', body: JSON.stringify(Object.keys(parameters).length ? {parameters} : {}),
    });
  }

  disableModule(name: string) {
    return this.request(`/api/modules/${encodeURIComponent(name)}/disable`, {method: 'POST', body: '{}'});
  }

  moduleCredentials(name: string) {
    return this.request<{title?: string; credentials?: Array<{key: string; value: string}>}>(
      `/api/modules/${encodeURIComponent(name)}/credentials`,
    );
  }

  createInstance(type: string, payload: unknown) {
    return this.request(`/api/instances/${encodeURIComponent(type)}`, {method: 'POST', body: JSON.stringify(payload)});
  }

  removeInstance(name: string) {
    return this.request(`/api/instances/${encodeURIComponent(name)}`, {method: 'DELETE'});
  }

  instanceCredentials(name: string) {
    return this.request<{title?: string; credentials?: Array<{key: string; value: string}>}>(
      `/api/instances/${encodeURIComponent(name)}/credentials`,
    );
  }

  searchModels(params: URLSearchParams) {
    return this.request<DiscoverySearchPayload>(`/api/model-discovery/search?${params}`);
  }

  popularModels(params: URLSearchParams) {
    return this.request<DiscoverySearchPayload>(`/api/model-discovery/popular?${params}`);
  }

  modelArtifacts(params: URLSearchParams) {
    return this.request<DiscoveryArtifactsPayload>(`/api/model-discovery/artifacts?${params}`);
  }

  estimateMemory(payload: unknown) {
    return this.request<MemoryEstimate>('/api/models/estimate-memory', {method: 'POST', body: JSON.stringify(payload)});
  }

  createLocalModel(payload: unknown) {
    return this.request('/api/models/local', {method: 'POST', body: JSON.stringify(payload)});
  }

  createExternalModel(payload: unknown) {
    return this.request('/api/models/external', {method: 'POST', body: JSON.stringify(payload)});
  }

  removeModel(name: string) {
    return this.request(`/api/models/${encodeURIComponent(name)}`, {method: 'DELETE'});
  }

  removeLocalRuntime() {
    return this.request('/api/models/local-runtime/remove', {method: 'POST', body: '{}'});
  }

  users(search = '', first = 0, max = 25) {
    const query = new URLSearchParams({search, first: String(first), max: String(max)});
    return this.request<UsersPayload>(`/api/users?${query}`);
  }

  createUser(payload: unknown) {
    return this.request<User>('/api/users', {method: 'POST', body: JSON.stringify(payload)});
  }

  updateUser(id: string, payload: unknown) {
    return this.request<User>(`/api/users/${encodeURIComponent(id)}`, {method: 'PATCH', body: JSON.stringify(payload)});
  }

  updateUserRoles(id: string, accessLevel: string) {
    return this.request<User>(`/api/users/${encodeURIComponent(id)}/roles`, {
      method: 'PUT', body: JSON.stringify({accessLevel}),
    });
  }

  setUserEnabled(id: string, enabled: boolean) {
    return this.request<User>(`/api/users/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, {
      method: 'POST', body: '{}',
    });
  }

  resetUserPassword(id: string, password: string, temporary = true) {
    return this.request(`/api/users/${encodeURIComponent(id)}/password`, {
      method: 'PUT', body: JSON.stringify({password, temporary}),
    });
  }

  deleteUser(id: string, usernameConfirmation: string) {
    return this.request(`/api/users/${encodeURIComponent(id)}`, {
      method: 'DELETE', body: JSON.stringify({usernameConfirmation}),
    });
  }

  apiAccess() { return this.request<ApiAccessPayload>('/api/api-access'); }

  createApiKey(name: string) {
    return this.request<{item: unknown; key: string; apiBases?: Array<{scope?: string; url: string}>}>(
      '/api/api-access', {method: 'POST', body: JSON.stringify({name})},
    );
  }

  revokeApiKey(id: string) {
    return this.request(`/api/api-access/${encodeURIComponent(id)}`, {method: 'DELETE'});
  }

  kubernetesAccess(search = '', first = 0, max = 100) {
    const query = new URLSearchParams({search, first: String(first), max: String(max)});
    return this.request<KubernetesAccessPayload>(`/api/kubernetes-access?${query}`);
  }

  updateKubernetesAccess(id: string, accessLevel: string) {
    return this.request(`/api/kubernetes-access/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify({accessLevel}),
    });
  }

  kubeconfig(id: string) {
    return this.request<{filename: string; content: string; accessLevel?: string}>(
      `/api/kubernetes-access/${encodeURIComponent(id)}/kubeconfig`,
    );
  }
}
