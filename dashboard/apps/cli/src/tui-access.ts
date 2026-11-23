// API Access and Kubernetes Access pages (apps/web/src/pages/ApiAccessPage.tsx, KubernetesAccessPage.tsx).
import type {KubernetesAccessUser} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {AreaModule, TuiContext} from './tui-context';
import type {ViewerLine} from './tui-dialogs';
import type {PageState, PageView} from './tui-state';
import {badge, button, fit, gap, joinSpans, link, panel, prose, span, table, textWidth, type Row} from './tui-screen';
import {blank, dateTime, heading, plural, statusBadge, text} from './tui-widgets';

const KUBERNETES_LEVELS = ['none', 'viewer', 'operator', 'admin'] as const;
const KUBERNETES_LABELS: Record<string, string> = {none: 'No access', viewer: 'Viewer', operator: 'Operator', admin: 'Cluster Administrator'};
const KUBERNETES_NOTES: Record<string, string> = {
  none: 'Existing direct Kubernetes group membership is removed.',
  viewer: 'Viewer can inspect cluster resources but cannot read Kubernetes Secrets or make changes.',
  operator: 'Operator can read the cluster and manage Magic Stick modules, models, and instances. It cannot create arbitrary workloads or read Secrets.',
  admin: 'Warning: Cluster Administrator grants unrestricted control over workloads, RBAC, Secrets, and the appliance itself.',
};

const levelOf = (user: KubernetesAccessUser) => user.accessLevel ?? 'none';

export const apiAccessPage = (snapshot: DashboardSnapshot, width: number): PageView => {
  const inner = width - 4;
  const items = snapshot.apiAccess?.items ?? [];
  const total = snapshot.apiAccess?.total ?? 0;
  const bases = snapshot.apiAccess?.apiBases ?? [];
  const scopeWidth = Math.min(24, Math.max(0, ...bases.map((base) => textWidth(`${base.scope ?? 'endpoint'} API base`))) + 2);
  return {hotkeys: [{key: 'a', label: 'Create key', actionId: 'apikey:create'}], rows: [
    ...heading(width, 'API Access', 'Create named LiteLLM virtual keys. Secret values are shown once.', [button('apikey:create', 'Create API Key', 'primary')]),
    ...panel(width, {title: 'API bases'}, bases.length
      ? bases.map((item) => [span(`${item.scope ?? 'endpoint'} API base`.padEnd(scopeWidth), 'dim'), link(item.url)])
      : [text(inner, 'No API endpoints available.', 'dim')]),
    ...panel(width, {title: 'Named keys', meta: plural(total, 'key')}, items.length
      ? table(inner, [{header: 'Name', max: 26}, {header: 'Key ID', max: 18}, {header: 'Created', max: 22}, {header: 'Status', max: 12}], items.map((item) => {
        const active = String(item.status ?? 'active').toLowerCase() === 'active';
        return {
          cells: [span(item.name, undefined, true), span(item.keyHint ?? 'Unavailable'), span(item.createdAt ? dateTime(item.createdAt) : 'Unknown', 'dim'), statusBadge(active ? 'Active' : item.status)],
          actions: [button(`apikey:revoke:${item.id}`, 'Revoke', 'danger', active ? undefined : 'This key is no longer active.')],
        };
      }))
      : [text(inner, 'No API keys created by this dashboard.', 'dim')]),
  ]};
};

/** JSON with its indentation kept: leading spaces become no-break spaces, which wrapping preserves. */
const jsonLines = (value: unknown): ViewerLine[] => JSON.stringify(value, null, 2).split('\n')
  .map((line) => ({text: line.replace(/^ +/, (spaces) => '\u00a0'.repeat(spaces.length))}));

export const kubernetesPage = (snapshot: DashboardSnapshot, state: PageState, width: number): PageView => {
  const inner = width - 4;
  const configuration = snapshot.kubernetesAccess?.configuration ?? {};
  const configured = configuration.configured === true;
  const users = snapshot.kubernetesAccess?.users ?? [];
  const total = snapshot.kubernetesAccess?.total ?? 0;
  const search = state.ui['k8s.search'] ?? '';
  const notice = configured
    ? `SSO is active for ${String(configuration.apiServer || 'this cluster')}. Kubeconfigs use ${String(configuration.credentialPlugin || 'kubectl oidc-login')} and contain no token.`
    : 'Kubernetes SSO is not confirmed by this cluster. Access can be assigned, but kubeconfig export remains disabled until the API server publishes its OIDC configuration.';
  const userRows = (user: KubernetesAccessUser): Row[] => {
    const level = levelOf(user);
    const granted = level !== 'none';
    const exportBlocked = !configured ? 'The Kubernetes API server has not confirmed OIDC.' : !user.enabled ? 'The user is disabled.' : !granted ? 'Grant access first.' : undefined;
    const editBlocked = user.protected ? 'Protected recovery access cannot be changed.' : !user.enabled && !granted ? 'Enable the user before granting Kubernetes access.' : undefined;
    return [
      fit(inner, [span((user.displayName || user.username).padEnd(26).slice(0, 26), undefined, true), span(String(user.provider ?? user.source ?? 'Local').padEnd(12).slice(0, 12), 'dim'),
        {...(user.enabled ? badge('Enabled', 'good') : badge('Disabled', 'dim', false)), text: (user.enabled ? '● Enabled' : '○ Disabled').padEnd(12)}],
      [level === 'admin' ? badge(KUBERNETES_LABELS[level]!, 'warn') : granted ? badge(KUBERNETES_LABELS[level] ?? level, 'good') : badge(KUBERNETES_LABELS.none!, 'dim', false)]),
      ...prose(inner - 2, `${user.username}${user.email ? ` · ${user.email}` : ''}`, 'dim').map((row) => [gap(2), ...row]),
      fit(inner, [gap(2), ...joinSpans([
        button(`k8s:access:${user.id}`, 'Edit Access', 'ghost', editBlocked),
        button(`k8s:download:${user.id}`, 'Download Kubeconfig', 'primary', exportBlocked),
        button(`k8s:copy:${user.id}`, 'Copy to Clipboard', 'ghost', exportBlocked),
      ])]),
    ];
  };
  return {hotkeys: [{key: '/', label: 'Search', actionId: 'k8s:search'}], rows: [
    ...heading(width, 'Kubernetes Access', 'Assign SSO-backed cluster roles and issue token-free OIDC kubeconfigs.'),
    ...panel(width, {title: 'Access levels'}, [
      ...prose(inner, 'Viewer: read cluster resources. Kubernetes Secrets remain hidden.'),
      ...prose(inner, 'Operator: viewer access plus lifecycle control for Magic Stick modules, models, and instances.'),
      ...prose(inner, 'Cluster Administrator: unrestricted cluster-admin access. Grant only when operationally necessary.', 'bad'),
    ]),
    ...prose(width, notice, configured ? 'good' : 'warn'),
    blank,
    fit(width, [span('OIDC configuration  ', undefined, true), configured ? badge('Configured', 'good') : badge('Not confirmed', 'warn')], [button('k8s:oidc', 'Show')]),
    blank,
    fit(width, [span('Search: ', 'dim'), span(search ? `"${search}"` : 'all users')], joinSpans([
      button('k8s:search', 'Search'),
      ...(search ? [button('k8s:clear-search', 'Clear search')] : []),
    ])),
    blank,
    ...panel(width, {title: 'Users', meta: plural(total, 'eligible identity', 'eligible identities')}, users.length ? [
      fit(inner, [span('User'.padEnd(26), 'dim'), span('Source'.padEnd(12), 'dim'), span('Status', 'dim')], [span('Kubernetes Access', 'dim')]),
      ...users.flatMap(userRows),
    ] : [text(inner, 'No users match the current search.', 'dim')]),
  ]};
};

/** The created key is shown once, with its API base, and can be copied before the dialog closes. */
const createdKeyViewer = (ctx: TuiContext, name: string, key: string, apiBase?: string) => {
  let copied = '';
  ctx.viewer({
    title: 'API key created',
    description: `The key for ${name} is ready. Copy it now; it cannot be recovered later.`,
    lines: (): ViewerLine[] => [
      {text: 'API key', bold: true}, {text: key}, {text: ''},
      ...(apiBase ? [{text: 'API base', bold: true}, {text: apiBase}, {text: ''}] : []),
      ...(copied ? [{text: copied, tone: 'good' as const}] : []),
    ],
    actions: [
      {key: 'c', label: 'Copy API key', run: () => { ctx.copy(key); copied = 'API key copied to the clipboard.'; }},
      ...(apiBase ? [{key: 'b', label: 'Copy API base', run: () => { ctx.copy(apiBase); copied = 'API base copied to the clipboard.'; }}] : []),
    ],
  });
};

const createApiKey = (ctx: TuiContext) => {
  const state = {name: ''};
  ctx.dialog({
    title: 'Create API Key',
    description: 'Use a recognizable application or integration name.',
    items: () => [{kind: 'text', id: 'name', label: 'Name', value: state.name, required: true, maxLength: 64, hint: 'CI pipeline', onChange: (value) => { state.name = value; }}],
    submit: {
      label: 'create key',
      run: () => ctx.task(`Create API key ${state.name}`, () => ctx.api.createApiKey(state.name), (result) => {
        const preferred = result.apiBases?.find((base) => base.scope === 'local') ?? result.apiBases?.[0];
        createdKeyViewer(ctx, state.name, result.key, preferred?.url);
        void ctx.refresh();
      }),
    },
  });
};

const revokeApiKey = (ctx: TuiContext, id: string) => {
  const item = (ctx.snapshot().apiAccess?.items ?? []).find((entry) => entry.id === id);
  if (!item) return ctx.missing();
  if (String(item.status ?? 'active').toLowerCase() !== 'active') return ctx.message('Key is not active', 'This key is no longer active.');
  ctx.confirm({title: 'Revoke API key', description: `Revoke ${item.name}? Applications using it lose access immediately.`, confirmLabel: 'revoke', danger: true,
    onConfirm: () => ctx.perform(`Revoke API key ${item.name}`, async () => {
      await ctx.api.revokeApiKey(id);
      return {lines: [`${item.name} revoked.`]};
    })});
};

const kubernetesUser = (ctx: TuiContext, id: string) => (ctx.snapshot().kubernetesAccess?.users ?? []).find((entry) => entry.id === id);

const editKubernetesAccess = (ctx: TuiContext, user: KubernetesAccessUser) => {
  if (user.protected) return ctx.message('Kubernetes access is protected', 'Protected recovery access cannot be changed.');
  if (!user.enabled && levelOf(user) === 'none') return ctx.message('User is disabled', 'Enable the user before granting Kubernetes access.');
  const state = {level: levelOf(user)};
  ctx.dialog({
    title: `Kubernetes access for ${user.username}`,
    description: 'Access is bound to this Keycloak identity and revoked by removing its direct group membership.',
    items: () => [
      {kind: 'choice', id: 'level', label: 'Access level', value: state.level, choices: KUBERNETES_LEVELS.map((value) => ({value, label: KUBERNETES_LABELS[value]!})),
        onChange: (value) => { state.level = value; }},
      {kind: 'note', text: KUBERNETES_NOTES[state.level] ?? '', tone: state.level === 'admin' ? 'warn' : 'normal'},
    ],
    submit: {
      label: 'save access',
      run: () => ctx.perform(`Change Kubernetes access for ${user.username}`, async () => {
        await ctx.api.updateKubernetesAccess(user.id, state.level);
        return {lines: [`Kubernetes access for ${user.username} updated to ${KUBERNETES_LABELS[state.level] ?? state.level}.`]};
      }),
    },
  });
};

/** Why a kubeconfig cannot be exported for this user right now, as the browser disables its buttons. */
const exportBlocked = (ctx: TuiContext, user: KubernetesAccessUser) => {
  const configured = ctx.snapshot().kubernetesAccess?.configuration?.configured === true;
  return !configured ? 'The Kubernetes API server has not confirmed OIDC.' : !user.enabled ? 'The user is disabled.' : levelOf(user) === 'none' ? 'Grant access first.' : undefined;
};

const downloadKubeconfig = (ctx: TuiContext, user: KubernetesAccessUser) => {
  const blocked = exportBlocked(ctx, user);
  if (blocked) return ctx.message('Kubeconfig unavailable', blocked);
  return ctx.task(`Prepare kubeconfig for ${user.username}`, () => ctx.api.kubeconfig(user.id), (result) => ctx.saveAs({
    title: `Download kubeconfig · ${user.username}`,
    defaultName: result.filename,
    content: () => result.content,
    done: `Kubeconfig for ${user.username}. It contains no token or password.`,
  }));
};

const copyKubeconfig = (ctx: TuiContext, user: KubernetesAccessUser) => {
  const blocked = exportBlocked(ctx, user);
  if (blocked) return ctx.message('Kubeconfig unavailable', blocked);
  return ctx.perform(`Copy kubeconfig for ${user.username}`, async () => {
    const result = await ctx.api.kubeconfig(user.id);
    ctx.copy(result.content);
    return {lines: [`Kubeconfig copied for ${user.username} through the terminal clipboard protocol. It contains no token or password.`]};
  });
};

const searchKubernetes = (ctx: TuiContext) => {
  const state = {search: ctx.view.ui['k8s.search'] ?? ''};
  ctx.dialog({
    title: 'Search Kubernetes identities',
    description: 'Search by username, name, or email. Leave empty to list all eligible identities.',
    items: () => [{kind: 'text', id: 'search', label: 'Search', value: state.search, hint: 'Username, name, or email', onChange: (value) => { state.search = value; }}],
    submit: {label: 'search', run: () => {
      ctx.view.ui['k8s.search'] = state.search.trim();
      ctx.close();
      void ctx.refresh();
    }},
  });
};

export const accessModule: AreaModule = {
  scopes: {apikey: 'admin', k8s: 'admin'},
  readOnly: ({scope, verb}) => scope === 'k8s' && ['oidc', 'search', 'clear-search'].includes(verb),
  handle: (ctx, {scope, verb, target}) => {
    if (scope === 'apikey') {
      if (verb === 'create') return createApiKey(ctx);
      if (verb === 'revoke') return revokeApiKey(ctx, target);
      return;
    }
    if (verb === 'search') return searchKubernetes(ctx);
    if (verb === 'oidc') {
      const configuration = ctx.snapshot().kubernetesAccess?.configuration ?? {};
      return ctx.viewer({
        title: 'OIDC configuration',
        description: configuration.configured === true ? 'Configured' : 'Not confirmed by the Kubernetes API server.',
        lines: () => jsonLines(ctx.snapshot().kubernetesAccess?.configuration ?? {}),
      });
    }
    if (verb === 'clear-search') {
      ctx.view.ui['k8s.search'] = '';
      return void ctx.refresh();
    }
    const user = kubernetesUser(ctx, target);
    if (!user) return ctx.missing();
    if (verb === 'access') return editKubernetesAccess(ctx, user);
    if (verb === 'download') return void downloadKubeconfig(ctx, user);
    if (verb === 'copy') return void copyKubeconfig(ctx, user);
  },
};
