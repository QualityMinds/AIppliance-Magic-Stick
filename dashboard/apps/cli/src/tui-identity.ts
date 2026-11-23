// System → Users and System → License (apps/web/src/pages/UsersPage.tsx, LicensePage.tsx, SoftwareLicenses.tsx).
import {titleFromKey} from '@magicstick/dashboard-core';
import type {LicenseStatus, LicenseVerification, User} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {AreaModule, TuiContext} from './tui-context';
import type {DialogItem, ViewerLine} from './tui-dialogs';
import type {PageState, PageView} from './tui-state';
import {LICENSE_DOCUMENTS, previewLines, readLicenseDocument, readLicenseFile} from './license';
import {badge, button, fit, gap, joinSpans, panel, prose, span, type Row} from './tui-screen';
import {blank, dateTime, facts, isLocalUser, plural, userSource} from './tui-widgets';

const ACCESS_LEVELS = ['user', 'viewer', 'operator', 'admin'];
const accessChoices = ACCESS_LEVELS.map((value) => ({value, label: titleFromKey(value)}));
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const PAGE_SIZES = [10, 25, 50];

type StatusFilter = 'all' | 'enabled' | 'disabled';
type SourceFilter = 'all' | 'local' | 'external';
const statusFilterOf = (state: PageState): StatusFilter => (['enabled', 'disabled'].includes(state.ui['users.status'] ?? '') ? state.ui['users.status'] : 'all') as StatusFilter;
const sourceFilterOf = (state: PageState): SourceFilter => (['local', 'external'].includes(state.ui['users.source'] ?? '') ? state.ui['users.source'] : 'all') as SourceFilter;
const roles = (values?: string[]) => (values ?? []).join(', ') || 'none';

/** Why each user action is unavailable, with the browser's explanations. */
export const userActionBlocks = (user: User) => {
  const local = isLocalUser(user);
  const capabilities = user.capabilities ?? {};
  return {
    profile: !capabilities.canEditProfile ? local ? 'This protected profile cannot be edited.' : 'Profile fields are managed upstream.' : undefined,
    access: !capabilities.canManageRoles ? 'Your own or protected access cannot be changed.' : undefined,
    toggle: (user.enabled === false ? !capabilities.canEnable : !capabilities.canDisable) ? 'This account is protected.' : undefined,
    password: !capabilities.canResetPassword ? local ? 'Password reset is unavailable for this account.' : 'Reset the password at the external identity provider.' : undefined,
    delete: !capabilities.canDelete ? local ? 'Self, recovery, and last-admin accounts cannot be deleted.' : 'External accounts must be disabled or removed upstream.' : undefined,
  };
};

export const visibleUsers = (users: User[], state: PageState) => {
  const status = statusFilterOf(state);
  const source = sourceFilterOf(state);
  return users.filter((user) => (status === 'all' || (status === 'enabled' ? user.enabled !== false : user.enabled === false))
    && (source === 'all' || (source === 'local' ? isLocalUser(user) : !isLocalUser(user))));
};

export const usersSection = (snapshot: DashboardSnapshot, state: PageState, width: number): PageView => {
  const inner = width - 4;
  const payload = snapshot.users;
  const users = payload?.users ?? [];
  const visible = visibleUsers(users, state);
  const first = payload?.first ?? Number(state.ui['users.first'] ?? 0);
  const max = Number(state.ui['users.max'] ?? payload?.max ?? 25);
  const end = first + users.length;
  const total = payload?.total ?? 0;
  const search = state.ui['users.search'] ?? '';
  const status = statusFilterOf(state);
  const source = sourceFilterOf(state);
  const filtered = Boolean(search) || status !== 'all' || source !== 'all';
  const userRows = (user: User): Row[] => {
    const local = isLocalUser(user);
    const blocks = userActionBlocks(user);
    const created = dateTime(user.createdAt ?? user.createdTimestamp);
    return [
      fit(inner, [
        span((user.displayName || user.username).padEnd(24).slice(0, 24), undefined, true),
        span((user.email || 'Not set').padEnd(30).slice(0, 30), user.email ? undefined : 'dim'),
        {...(user.enabled === false ? badge('Disabled', 'dim', false) : badge('Enabled', 'good')), text: (user.enabled === false ? '○ Disabled' : '● Enabled').padEnd(12)},
        span(titleFromKey(user.effectiveAccessLevel ?? user.accessLevel ?? 'user'), undefined, true),
      ]),
      ...prose(inner - 2, `${user.displayName ? `${user.username} · ` : ''}${userSource(user)} · ${local ? 'Managed locally' : 'Profile and password managed upstream'} · Created ${created}`, 'dim').map((row) => [gap(2), ...row]),
      ...prose(inner - 2, `Direct: ${roles(user.directRoles)} · Effective: ${roles(user.effectiveRoles)}`, 'dim').map((row) => [gap(2), ...row]),
      fit(inner, [gap(2), ...joinSpans([
        button(`user:profile:${user.id}`, 'Edit', 'ghost', blocks.profile),
        button(`user:access:${user.id}`, 'Access', 'ghost', blocks.access),
        button(`user:toggle:${user.id}`, user.enabled === false ? 'Enable' : 'Disable', 'ghost', blocks.toggle),
        button(`user:password:${user.id}`, 'Reset Password', 'ghost', blocks.password),
        button(`user:delete:${user.id}`, 'Delete', 'danger', blocks.delete),
      ])]),
    ];
  };
  return {hotkeys: [{key: 'a', label: 'Add user', actionId: 'user:create'}, {key: '/', label: 'Search', actionId: 'user:search'}], rows: [
    fit(width, [span('Local and brokered Keycloak identities.', 'dim')], [button('user:create', 'Create User', 'primary')]),
    blank,
    fit(width, [span('Search: ', 'dim'), span(search ? `"${search}"` : 'all users'), span(` · Status: ${titleFromKey(status)} · Source: ${titleFromKey(source)}`, 'dim')],
      joinSpans([button('user:search', 'Search / filter'), ...(filtered ? [button('user:clear-search', 'Clear')] : [])])),
    // Paging sits above the table so it stays reachable without scrolling through every user.
    fit(width, [span(`${users.length ? first + 1 : 0}–${end} of ${total}${visible.length !== users.length ? `; ${visible.length} shown after filters` : ''}`, 'dim')], joinSpans([
      button('user:page-size', `Per page: ${max}`),
      button('user:page:previous', 'Previous', 'ghost', first === 0 ? 'This is the first page.' : undefined),
      button('user:page:next', 'Next', 'ghost', end >= total || !users.length ? 'This is the last page.' : undefined),
    ])),
    blank,
    ...panel(width, {title: 'User overview', meta: plural(total, 'user')}, [
      ...(visible.length ? [
        fit(inner, [span('User'.padEnd(24), 'dim'), span('Email'.padEnd(30), 'dim'), span('Status'.padEnd(12), 'dim'), span('Access', 'dim')]),
        ...visible.flatMap(userRows),
      ] : [fit(inner, [span('No users match the current search and filters.', 'dim')])]),
    ]),
  ]};
};

const claimRows = (inner: number, value: LicenseVerification): Row[] => [
  ...prose(inner, value.message, value.valid ? 'good' : undefined),
  ...(value.claims ? facts(inner, [
    ['Edition', value.claims.edition === 'commercial' ? 'Commercial' : 'Free Registered'],
    ['License ID', value.claims.licenseId],
    ['Customer', value.claims.customer],
    ['Valid from', dateTime(value.claims.notBefore)],
    ['Expires', dateTime(value.claims.expiresAt)],
    ['Signing key', value.keyId ?? '—'],
  ]) : []),
];

const editionLabel = (edition: LicenseStatus['edition']) => edition === 'commercial' ? 'Commercial' : edition === 'free-registered' ? 'Free Registered' : 'Free';

const softwareLicenseRows = (width: number): Row[] => panel(width, {title: 'Software licenses'}, [
  ...prose(width - 4, 'Magic Stick is source-available under BSL 1.1. Each version changes to MIT three years after its first public distribution. Third-party licenses remain separate.'),
  blank,
  ...LICENSE_DOCUMENTS.map((document, index) => fit(width - 4, [span(document.title)], [button(`license:document:${index}`, 'View')])),
]);

export const licenseSection = (snapshot: DashboardSnapshot, _state: PageState, width: number): PageView => {
  const inner = width - 4;
  const status = snapshot.license;
  const editions: Row[] = [
    ...panel(width, {title: 'Free'}, prose(inner, 'No license file required for personal use and eligible organizations under the Free Use Grant, including businesses with consolidated Group revenue up to EUR 2,000,000. All core functions, Resource Sharing and Private Mesh are available. Federated SSO requires registration.')),
    ...panel(width, {title: 'Free Registered'}, prose(inner, 'Free signed license for eligible organizations under the same grant. Includes Federated SSO.')),
    ...panel(width, {title: 'Commercial'}, prose(inner, 'A commercial license is required for production use outside the Free Use Grant, including groups above EUR 2,000,000 and excluded productive OEM, SaaS, hosting and managed-service offerings for third parties. Includes Federated SSO.')),
  ];
  if (!status) return {hotkeys: [], rows: [
    ...panel(width, {title: 'License status'}, prose(inner, snapshot.licenseError ?? 'License state unavailable.', 'bad')),
    ...softwareLicenseRows(width),
  ]};
  return {hotkeys: [{key: 'i', label: 'Import', actionId: 'license:import'}, {key: 'e', label: 'Export', actionId: 'license:export'}], rows: [
    ...editions,
    ...softwareLicenseRows(width),
    ...panel(width, {title: status.valid ? 'Valid license' : 'License status', status: status.valid ? badge('Valid', 'good') : badge(titleFromKey(status.state), 'dim', false)}, [
      ...prose(inner, `Technical edition: ${editionLabel(status.edition)}`),
      ...prose(inner, 'Revenue is not checked by the software. This status does not determine legal eligibility for Free use.', 'dim'),
      blank,
      ...claimRows(inner, status),
      blank,
      ...facts(inner, [
        ['Installation ID', status.installationId],
        ['Checked', dateTime(status.checkedAt)],
        ['Trusted signing keys', status.trustedKeyIds.join(', ') || 'None configured'],
      ]),
      ...(!status.trustedKeyIds.length ? [blank, ...prose(inner, 'License verification keys are unavailable. They are delivered with Magic Stick updates; contact the appliance administrator to check the installation. Never upload a private signing key.', 'warn')] : []),
      ...(status.features.length ? [blank, ...facts(inner, status.features.map((feature) => [feature.name,
        `${feature.licensed ? 'Licensed' : 'Not licensed'} · ${feature.implemented ? 'Implemented' : 'Not implemented'}`] as [string, string]))] : []),
      blank,
      fit(inner, [], [button('license:export', 'Export license', 'ghost', status.hasDocument ? undefined : 'No license document is installed.')]),
    ]),
    ...panel(width, {title: 'Request license'}, [
      ...prose(inner, 'Save unsigned JSON for your license provider to review and sign. It is bound to this installation and does not change the active license.', 'dim'),
      fit(inner, [], [button('license:request', 'Request license')]),
    ]),
    ...panel(width, {title: 'Import or replace license'}, [
      ...prose(inner, 'Use only the signed license file from your provider. Verification keys are supplied with the installation. Maximum 64 KiB. An invalid file cannot replace the active license.', 'dim'),
      fit(inner, [], [button('license:import', 'Import license', 'primary')]),
    ]),
  ]};
};

const reload = async (ctx: TuiContext) => { await ctx.refresh(); };

const searchUsers = (ctx: TuiContext) => {
  const ui = ctx.view.ui;
  const state = {search: ui['users.search'] ?? '', status: ui['users.status'] ?? 'all', source: ui['users.source'] ?? 'all'};
  ctx.dialog({
    title: 'Search users',
    description: 'Search by username, name, or email. Status and source filter the loaded page.',
    items: () => [
      {kind: 'text', id: 'search', label: 'Search users', value: state.search, hint: 'Username, name, or email', onChange: (value) => { state.search = value; }},
      {kind: 'choice', id: 'status', label: 'Status', value: state.status, choices: [{value: 'all', label: 'All'}, {value: 'enabled', label: 'Enabled'}, {value: 'disabled', label: 'Disabled'}], onChange: (value) => { state.status = value; }},
      {kind: 'choice', id: 'source', label: 'Source', value: state.source, choices: [{value: 'all', label: 'All'}, {value: 'local', label: 'Local'}, {value: 'external', label: 'External'}], onChange: (value) => { state.source = value; }},
    ],
    submit: {label: 'search', run: () => {
      Object.assign(ui, {'users.search': state.search.trim(), 'users.status': state.status, 'users.source': state.source, 'users.first': '0'});
      ctx.close();
      void reload(ctx);
    }},
  });
};

const createUser = (ctx: TuiContext) => {
  const state = {username: '', firstName: '', lastName: '', email: '', accessLevel: 'user', password: '', confirmation: '', enabled: true};
  ctx.dialog({
    title: 'Create User',
    description: 'Create a local Keycloak user for this appliance. Password input is masked.',
    items: () => [
      {kind: 'text', id: 'username', label: 'Username', value: state.username, required: true, maxLength: 128, onChange: (value) => { state.username = value; }},
      {kind: 'text', id: 'first-name', label: 'First name', value: state.firstName, maxLength: 128, onChange: (value) => { state.firstName = value; }},
      {kind: 'text', id: 'last-name', label: 'Last name', value: state.lastName, maxLength: 128, onChange: (value) => { state.lastName = value; }},
      {kind: 'text', id: 'email', label: 'Email', value: state.email, required: true, maxLength: 254, onChange: (value) => { state.email = value; }},
      {kind: 'choice', id: 'access', label: 'Access level', value: state.accessLevel, choices: accessChoices, onChange: (value) => { state.accessLevel = value; }},
      {kind: 'text', id: 'password', label: 'Temporary password', value: state.password, secret: true, required: true, hint: 'at least 12 characters', onChange: (value) => { state.password = value; }},
      {kind: 'text', id: 'confirmation', label: 'Confirm temporary password', value: state.confirmation, secret: true, required: true, onChange: (value) => { state.confirmation = value; }},
      {kind: 'check', id: 'enabled', label: 'Enable the account after creation', checked: state.enabled, onChange: (checked) => { state.enabled = checked; }},
    ],
    submit: {
      label: 'create user',
      disabled: () => !USERNAME.test(state.username) ? 'The username must start with a letter or digit and may contain letters, digits and . _ @ + -.'
        : !EMAIL.test(state.email) ? 'Enter a valid email address.'
          : state.password.length < 12 ? 'The temporary password must contain at least 12 characters.'
            : state.password !== state.confirmation ? 'The password confirmation does not match.' : undefined,
      run: () => ctx.perform(`Create user ${state.username}`, async () => {
        await ctx.api.createUser({
          username: state.username, firstName: state.firstName, lastName: state.lastName,
          email: state.email, password: state.password, enabled: state.enabled, accessLevel: state.accessLevel,
        });
        return {lines: [`${state.username} created.`]};
      }),
    },
  });
};

const editUserProfile = (ctx: TuiContext, user: User) => {
  const blocked = userActionBlocks(user).profile;
  if (blocked) return ctx.message('Profile is read-only', blocked);
  const local = isLocalUser(user);
  const upstream = local ? undefined : 'Profile fields are managed by the external identity provider.';
  const state = {firstName: user.firstName ?? '', lastName: user.lastName ?? '', email: user.email ?? ''};
  ctx.dialog({
    title: `Edit ${user.username}`,
    description: local ? 'Edit this locally managed profile.' : 'This profile is managed by the external identity provider.',
    items: (): DialogItem[] => [
      {kind: 'text', id: 'username', label: 'Username', value: user.username, disabled: 'The username cannot be changed.', onChange: () => undefined},
      {kind: 'text', id: 'first-name', label: 'First name', value: state.firstName, maxLength: 128, disabled: upstream, onChange: (value) => { state.firstName = value; }},
      {kind: 'text', id: 'last-name', label: 'Last name', value: state.lastName, maxLength: 128, disabled: upstream, onChange: (value) => { state.lastName = value; }},
      {kind: 'text', id: 'email', label: 'Email', value: state.email, required: local, maxLength: 254, disabled: upstream, onChange: (value) => { state.email = value; }},
    ],
    submit: {
      label: 'save user',
      disabled: () => upstream ?? (!EMAIL.test(state.email) ? 'Enter a valid email address.'
        : state.firstName === (user.firstName ?? '') && state.lastName === (user.lastName ?? '') && state.email === (user.email ?? '') ? 'Nothing has changed.' : undefined),
      run: () => ctx.perform(`Update ${user.username}`, async () => {
        await ctx.api.updateUser(user.id, {firstName: state.firstName, lastName: state.lastName, email: state.email});
        return {lines: [`${user.username} updated.`]};
      }),
    },
  });
};

const editUserRole = (ctx: TuiContext, user: User) => {
  const blocked = userActionBlocks(user).access;
  if (blocked) return ctx.message('Access is protected', blocked);
  const state = {level: user.accessLevel ?? 'user'};
  ctx.dialog({
    title: `Change access for ${user.username}`,
    description: 'Only direct Magic Stick roles are replaced. Unmanaged and inherited roles remain.',
    items: () => [
      {kind: 'choice', id: 'access', label: 'Access level', value: state.level, choices: accessChoices, onChange: (value) => { state.level = value; }},
      {kind: 'facts', rows: [['Direct roles', roles(user.directRoles)], ['Effective roles', roles(user.effectiveRoles)]]},
    ],
    submit: {
      label: 'save access',
      run: () => ctx.perform(`Change access for ${user.username}`, async () => {
        await ctx.api.updateUserRoles(user.id, state.level);
        return {lines: [`${user.username} access updated to ${titleFromKey(state.level)}.`]};
      }),
    },
  });
};

const toggleUser = (ctx: TuiContext, user: User) => {
  const blocked = userActionBlocks(user).toggle;
  const enable = user.enabled === false;
  if (blocked) return ctx.message('Account is protected', `This account cannot be ${enable ? 'enabled' : 'disabled'}.`);
  const verb = enable ? 'Enable' : 'Disable';
  ctx.confirm({title: `${verb} ${user.username}`, description: `${verb} this Keycloak account and end its current sessions?`, confirmLabel: verb.toLowerCase(), danger: !enable,
    onConfirm: () => ctx.perform(`${verb} ${user.username}`, async () => {
      await ctx.api.setUserEnabled(user.id, enable);
      return {lines: [`${user.username} ${enable ? 'enabled' : 'disabled'}.`]};
    })});
};

const resetUserPassword = (ctx: TuiContext, user: User) => {
  const blocked = userActionBlocks(user).password;
  if (blocked) return ctx.message('Password reset unavailable', blocked);
  const state = {password: '', confirmation: ''};
  ctx.dialog({
    title: `Reset password for ${user.username}`,
    description: 'The temporary password must be changed at the next sign-in.',
    items: () => [
      {kind: 'text', id: 'password', label: 'Temporary password', value: state.password, secret: true, required: true, hint: 'at least 12 characters', onChange: (value) => { state.password = value; }},
      {kind: 'text', id: 'confirmation', label: 'Confirm temporary password', value: state.confirmation, secret: true, required: true, onChange: (value) => { state.confirmation = value; }},
    ],
    submit: {
      label: 'set temporary password',
      disabled: () => state.password.length < 12 ? 'The temporary password must contain at least 12 characters.'
        : state.password !== state.confirmation ? 'The password confirmation does not match.' : undefined,
      run: () => ctx.perform(`Reset password for ${user.username}`, async () => {
        await ctx.api.resetUserPassword(user.id, state.password, true);
        return {lines: [`Temporary password set for ${user.username}.`]};
      }),
    },
  });
};

const deleteUser = (ctx: TuiContext, user: User) => {
  const blocked = userActionBlocks(user).delete;
  if (blocked) return ctx.message('Account cannot be deleted', blocked);
  ctx.confirm({
    title: `Delete ${user.username}`, description: 'This local account is permanently deleted. Enter the username to confirm.',
    confirmLabel: 'delete', danger: true, expected: user.username,
    onConfirm: () => ctx.perform(`Delete ${user.username}`, async () => {
      await ctx.api.deleteUser(user.id, user.username);
      return {lines: [`${user.username} deleted.`]};
    }),
  });
};

const changePage = (ctx: TuiContext, verb: string) => {
  const ui = ctx.view.ui;
  const payload = ctx.snapshot().users;
  const max = Number(ui['users.max'] ?? payload?.max ?? 25);
  const first = payload?.first ?? Number(ui['users.first'] ?? 0);
  if (verb === 'size') {
    ui['users.max'] = String(PAGE_SIZES[(PAGE_SIZES.indexOf(max) + 1) % PAGE_SIZES.length] ?? 25);
    ui['users.first'] = '0';
  } else if (verb === 'previous') {
    if (first === 0) return ctx.message('Not available', 'This is the first page.');
    ui['users.first'] = String(Math.max(0, first - max));
  } else {
    if (first + (payload?.users.length ?? 0) >= (payload?.total ?? 0)) return ctx.message('Not available', 'This is the last page.');
    ui['users.first'] = String(first + max);
  }
  void reload(ctx);
};

/** Shows one offline license text with an option to save a copy. */
const viewLicenseDocument = (ctx: TuiContext, index: number) => {
  const document = LICENSE_DOCUMENTS[index];
  if (!document) return ctx.missing();
  return ctx.load(document.title, () => readLicenseDocument(document), (content) => {
    const lines: ViewerLine[] = content.split('\n').map((line) => ({text: line.replace(/^ +/, (spaces) => ' '.repeat(spaces.length))}));
    ctx.viewer({
      title: document.title,
      description: document.filename,
      lines: () => lines,
      actions: [{key: 's', label: 'Save a copy', run: () => ctx.saveAs({
        title: `Save ${document.title}`, defaultName: document.filename, content: () => content, done: document.title, back: true,
      })}],
    });
  });
};

/** The browser's Request license panel: unsigned JSON for the provider to sign, saved as a local file. */
const requestLicense = (ctx: TuiContext) => {
  const status = ctx.snapshot().license;
  if (!status) return ctx.message('License status unavailable', ctx.snapshot().licenseError ?? 'Load the license status first.', 'error');
  const state = {
    edition: status.valid && status.claims?.edition === 'commercial' ? 'commercial' : 'free-registered',
    customer: status.claims?.customer ?? '', ttl: '30', unit: 'days',
  };
  const features = () => state.edition === 'commercial' ? ['commercial-production', 'federated-sso'] : ['federated-sso'];
  const ttlSeconds = () => Number(state.ttl) * (state.unit === 'hours' ? 3600 : 86400);
  ctx.dialog({
    title: 'Request license',
    description: 'Save unsigned JSON for your license provider to review and sign. It is bound to this installation and does not change the active license.',
    items: () => [
      {kind: 'choice', id: 'edition', label: 'Requested edition', value: state.edition, choices: [{value: 'free-registered', label: 'Free Registered'}, {value: 'commercial', label: 'Commercial'}],
        onChange: (value) => { state.edition = value; }},
      {kind: 'text', id: 'customer', label: 'Customer reference', value: state.customer, required: true, maxLength: 160, onChange: (value) => { state.customer = value; }},
      {kind: 'number', id: 'ttl', label: 'Validity (TTL)', value: state.ttl, min: 1, step: 1, required: true, onChange: (value) => { state.ttl = value; }},
      {kind: 'choice', id: 'unit', label: 'TTL unit', value: state.unit, choices: [{value: 'days', label: 'Days'}, {value: 'hours', label: 'Hours'}], onChange: (value) => { state.unit = value; }},
      {kind: 'heading', text: 'Edition entitlements', meta: 'included in request · current entitlement · implementation'},
      {kind: 'facts', rows: (ctx.snapshot().license?.features ?? status.features).map((feature) => [
        `${features().includes(feature.id) ? '✓' : '—'} ${feature.name}`,
        `${feature.licensed ? 'Licensed' : 'Not licensed'} · ${feature.implemented ? 'Implemented' : 'Not implemented'}`,
      ] as [string, string])},
      {kind: 'note', text: 'TTL starts when the file is generated, not when the signed license is imported. One day is 24 hours. Your provider approves the final modules and validity.'},
      {kind: 'note', text: 'A module needs both a valid entitlement and an installed implementation. Requesting an unimplemented module does not make it available.'},
    ],
    submit: {
      label: 'save JSON for signing',
      disabled: () => {
        const customer = state.customer.trim();
        if (!customer || customer.length > 160 || /[\u0000-\u001f\u007f]/u.test(state.customer)) return 'Enter a customer reference of up to 160 characters without control characters.';
        if (!Number.isSafeInteger(Number(state.ttl)) || Number(state.ttl) <= 0 || !Number.isSafeInteger(ttlSeconds())) return 'Enter a positive whole validity.';
        return undefined;
      },
      run: () => ctx.task('Prepare license request',
        () => ctx.api.createLicenseRequest({customer: state.customer.trim(), edition: state.edition as 'free-registered' | 'commercial', features: features(), ttlSeconds: ttlSeconds()}),
        (result) => ctx.saveAs({
          title: 'Save license request', defaultName: result.filename, content: () => result.content,
          done: 'Unsigned license request. Send it to your license provider for signing.',
        })),
    },
  });
};

const importLicense = (ctx: TuiContext) => ctx.openFile({
  title: 'Import license',
  description: 'Choose the signed license file from your provider (at most 64 KiB). Validation does not replace the current license.',
  extensions: ['.json', '.license'],
  maxBytes: 64 * 1024,
  read: (path) => readLicenseFile(path),
  open: (document) => void ctx.task('Validating license', () => ctx.api.inspectLicense(document), (preview) => {
    if (!preview.candidate.valid) return ctx.message('License rejected', preview.candidate.message, 'error');
    ctx.confirm({title: 'Activate license', description: [...previewLines(preview), 'Replaces the active license and its entire entitlement set. Missing features stay unavailable.'].join('\n'), confirmLabel: 'activate',
      onConfirm: () => ctx.perform('Activate license', async () => {
        await ctx.api.importLicense(document, preview.current.revision);
        return {lines: ['License saved persistently. Installed capabilities with a valid entitlement are now available.']};
      })});
  }),
});

const exportLicense = (ctx: TuiContext) => {
  if (!ctx.snapshot().license?.hasDocument) return ctx.message('Nothing to export', 'No license document is installed.');
  void ctx.task('Export license', () => ctx.api.exportLicense(), (result) => ctx.saveAs({
    title: 'Export license', defaultName: result.filename, content: () => result.content, done: 'The installed license document.',
  }));
};

export const identityModule: AreaModule = {
  scopes: {user: 'admin', license: 'admin'},
  readOnly: ({scope, verb}) => scope === 'license' ? verb === 'document' : ['search', 'clear-search', 'page', 'page-size'].includes(verb),
  handle: (ctx, {scope, verb, target}) => {
    if (scope === 'license') {
      if (verb === 'import') return importLicense(ctx);
      if (verb === 'export') return exportLicense(ctx);
      if (verb === 'request') return requestLicense(ctx);
      if (verb === 'document') return viewLicenseDocument(ctx, Number(target));
      return;
    }
    if (verb === 'create') return createUser(ctx);
    if (verb === 'search') return searchUsers(ctx);
    if (verb === 'clear-search') {
      Object.assign(ctx.view.ui, {'users.search': '', 'users.status': 'all', 'users.source': 'all', 'users.first': '0'});
      return void reload(ctx);
    }
    if (verb === 'page') return changePage(ctx, target);
    if (verb === 'page-size') return changePage(ctx, 'size');
    const user = (ctx.snapshot().users?.users ?? []).find((entry) => entry.id === target);
    if (!user) return ctx.missing();
    if (verb === 'profile') return editUserProfile(ctx, user);
    if (verb === 'access') return editUserRole(ctx, user);
    if (verb === 'toggle') return toggleUser(ctx, user);
    if (verb === 'password') return resetUserPassword(ctx, user);
    if (verb === 'delete') return deleteUser(ctx, user);
  },
};
