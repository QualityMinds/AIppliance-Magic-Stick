// System → Settings: Domains, Federated SSO, Network, Updates and Local console
// (apps/web/src/pages/SettingsPage.tsx, FederatedSsoPage.tsx, ConsoleAccessSettings.tsx).
import {consoleAccessLabel} from '@magicstick/dashboard-core';
import {
  CONSOLE_ACCESS_LEVELS, type ConsoleAccessLevel, type FederationInput, type FederationMapping, type FederationProvider, type FederationValidation,
} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {AreaModule, TuiContext} from './tui-context';
import type {DialogItem} from './tui-dialogs';
import {activeSettingsSection, availableSettingsSections, type PageState, type PageView} from './tui-state';
import {badge, button, fit, gap, joinSpans, panel, prose, span, type Row} from './tui-screen';
import {blank, facts, heading, loadingRows, note, plural, tabBar, tags, text} from './tui-widgets';
import {networkSection, updatesSection} from './tui-host-settings';

// --- Domains -------------------------------------------------------------------------------------

export const normalizeDomain = (value: string) => value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
/** The browser's domain check: at least two DNS labels of letters, digits and inner hyphens. */
export const validDomain = (value: string) => {
  const labels = normalizeDomain(value).split('.');
  return labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
};
const DOMAIN_HELP = 'Enter a domain with at least two labels of letters, digits or inner hyphens.';

const domainsRows = (snapshot: DashboardSnapshot, width: number): PageView => {
  const inner = width - 4;
  const settings = snapshot.settings;
  return {hotkeys: settings ? [{key: 'e', label: 'Edit domains', actionId: 'settings:domains'}] : [], rows: panel(width, {title: 'Domains'}, settings ? [
    fit(inner, [], [button('settings:domains', 'Edit domains', 'primary')]),
    ...facts(inner, [
      ['Public Domain', settings.publicDomain || 'Not set'],
      ['mDNS Domain', settings.mdnsDomain || 'Not set'],
      ['Dashboard host', settings.dashboardHost || 'Not reported'],
    ]),
  ] : [text(inner, 'Domain settings are unavailable.', 'dim')])};
};

const editDomains = (ctx: TuiContext) => {
  const saved = ctx.snapshot().settings;
  if (!saved) return ctx.message('Domain settings unavailable', 'The current domain settings could not be loaded. Press r to reload.', 'error');
  const draft = {publicDomain: saved.publicDomain, mdnsDomain: saved.mdnsDomain};
  ctx.dialog({
    title: 'Domains',
    items: () => [
      {kind: 'text', id: 'public', label: 'Public Domain', value: draft.publicDomain, hint: 'magicstick.example.com', onChange: (value) => { draft.publicDomain = value; }},
      ...(draft.publicDomain && !validDomain(draft.publicDomain) ? [{kind: 'note' as const, text: DOMAIN_HELP, tone: 'warn' as const}] : []),
      {kind: 'text', id: 'mdns', label: 'mDNS Domain', value: draft.mdnsDomain, required: true, hint: 'magicstick.local', onChange: (value) => { draft.mdnsDomain = value; }},
      ...(draft.mdnsDomain && !validDomain(draft.mdnsDomain) ? [{kind: 'note' as const, text: DOMAIN_HELP, tone: 'warn' as const}] : []),
    ],
    submit: {
      label: 'Save Domains',
      disabled: () => {
        const current = ctx.snapshot().settings ?? saved;
        const changed = normalizeDomain(draft.publicDomain) !== normalizeDomain(current.publicDomain) || normalizeDomain(draft.mdnsDomain) !== normalizeDomain(current.mdnsDomain);
        if (!changed) return 'No changes to save.';
        if (!validDomain(draft.publicDomain) || !validDomain(draft.mdnsDomain)) return `Both domains must be valid. ${DOMAIN_HELP}`;
        return undefined;
      },
      run: () => ctx.perform('Save domains', async () => {
        await ctx.api.updateSettings({publicDomain: draft.publicDomain, mdnsDomain: draft.mdnsDomain});
        return {lines: ['Domain settings saved.']};
      }),
    },
  });
};

// --- Federated SSO -------------------------------------------------------------------------------

const ACCESS_LEVELS: Array<{value: FederationMapping['accessLevel']; label: string}> = [
  {value: 'user', label: 'User'}, {value: 'viewer', label: 'Viewer'}, {value: 'operator', label: 'Operator'}, {value: 'admin', label: 'Administrator'},
];
const ALIAS = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const newMapping = (): FederationMapping => ({source: 'groups', value: '', accessLevel: 'user'});

type FederationDraft = Omit<FederationInput, 'mappings'> & {mappings: FederationMapping[]};

export const initialFederationDraft = (provider?: FederationProvider): FederationDraft => ({
  alias: provider?.alias ?? '',
  displayName: provider?.displayName ?? '',
  protocol: provider?.protocol ?? 'oidc',
  metadataUrl: provider?.metadataUrl ?? '',
  clientId: provider?.clientId ?? '',
  clientSecret: '',
  scopes: provider?.scopes || 'openid profile email',
  enabled: provider?.enabled ?? true,
  trustEmail: provider?.trustEmail ?? false,
  mappings: provider?.mappings.length ? provider.mappings.map((item) => ({...item})) : [newMapping()],
  expectedRevision: provider?.revision ?? 'new',
});

/** The same payload the browser sends: OIDC-only fields are omitted for SAML. */
export const federationPayload = (draft: FederationDraft): FederationInput => ({
  alias: draft.alias.trim(),
  displayName: draft.displayName.trim(),
  protocol: draft.protocol,
  metadataUrl: draft.metadataUrl.trim(),
  ...(draft.protocol === 'oidc' ? {
    clientId: draft.clientId?.trim(),
    clientSecret: draft.clientSecret,
    scopes: draft.scopes?.trim(),
  } : {}),
  enabled: draft.enabled,
  trustEmail: draft.protocol === 'oidc' && draft.trustEmail,
  mappings: draft.mappings.map((item) => ({...item, source: item.source.trim(), value: item.value.trim()})),
  expectedRevision: draft.expectedRevision,
});

const callbackFor = (snapshot: DashboardSnapshot, alias: string) => snapshot.federatedSso?.callbackUrl.replace('{alias}', alias) ?? '';

const featureNotice = (snapshot: DashboardSnapshot): {text: string; tone: 'good' | 'warn'} => {
  const feature = snapshot.federatedSso!.feature;
  const verificationUnavailable = ['storage_unavailable', 'trust_unavailable', 'verification_unavailable'].includes(feature.reason);
  return feature.available ? {text: 'Federated SSO entitlement active. Dashboard-managed federation is available.', tone: 'good'}
    : {tone: 'warn', text: verificationUnavailable ? 'License verification is currently unavailable. External login is blocked fail closed; viewing and recovery deletion remain available.'
      : feature.licensed ? 'The entitlement is present, but the Federated SSO implementation is unavailable.'
        : 'A valid Free Registered or Commercial Federated SSO entitlement is required to add or change providers.'};
};

const federationRows = (snapshot: DashboardSnapshot, width: number): PageView => {
  const inner = width - 4;
  const status = snapshot.federatedSso;
  const title = heading(width, 'Federated SSO', 'Connect corporate OIDC and SAML identity providers and map their groups or claims to Magic Stick roles.', joinSpans([
    button('federation:refresh', 'Refresh'),
    ...(status ? [button('federation:add', 'Add provider', 'primary', status.feature.available ? undefined : 'A valid Free Registered or Commercial Federated SSO entitlement is required to add or change providers.')] : []),
  ]));
  if (!status) return {hotkeys: [], rows: [...title, ...loadingRows(width, snapshot.errors?.federatedSso, 'Federated SSO')]};
  const notice = featureNotice(snapshot);
  const unavailable = status.feature.available ? undefined : 'A valid Federated SSO entitlement is required to change providers.';
  const providerRows = (provider: FederationProvider): Row[] => [
    fit(inner, [span(provider.displayName, undefined, true), gap(2),
      provider.enabled ? badge('Enabled', 'good') : badge('Disabled', 'dim', false), span(`  ${provider.protocol.toUpperCase()}`, 'dim')], joinSpans([
      button(`federation:copy:${provider.alias}`, 'Copy callback'),
      button(`federation:edit:${provider.alias}`, 'Edit', 'ghost', unavailable),
      button(`federation:delete:${provider.alias}`, 'Delete', 'danger'),
    ])),
    ...prose(inner - 2, provider.metadataUrl, 'dim').map((row) => [gap(2), ...row]),
    ...prose(inner - 2, callbackFor(snapshot, provider.alias)).map((row) => [gap(2), ...row]),
    ...tags(inner - 2, [`Alias: ${provider.alias}`, plural(provider.mappings.length, 'mapping'),
      ...(provider.protocol === 'oidc' ? [`Secret: ${provider.secretConfigured ? 'configured' : 'missing'}`] : [])]).map((row) => [gap(2), ...row]),
  ];
  return {hotkeys: status.feature.available ? [{key: 'a', label: 'Add provider', actionId: 'federation:add'}] : [], rows: [
    ...title,
    ...prose(width, notice.text, notice.tone),
    blank,
    ...panel(width, {title: 'Sign-in boundary', meta: 'Keycloak remains the stable Magic Stick issuer'}, [
      ...facts(inner, [['Magic Stick issuer', status.issuer], ['Provider callback template', status.callbackUrl]]),
      blank,
      ...prose(inner, 'Register the provider-specific callback URL upstream. Client secrets are stored in Keycloak, never returned to the browser, and must be entered again for an update.', 'dim'),
    ]),
    ...panel(width, {title: 'Identity providers', meta: plural(status.providers.length, 'dashboard-managed provider')}, status.providers.length
      ? status.providers.flatMap((provider, index) => [...(index ? [blank] : []), ...providerRows(provider)])
      : [text(inner, 'No dashboard-managed identity providers are configured.', 'dim')]),
    ...panel(width, {title: 'Recovery and enforcement'}, prose(inner, 'Local login and recovery stay available. Invalid or expired entitlements block external broker login and disable external providers without deleting their configuration or local users. Restoring a license does not automatically re-enable providers. Deletion remains available without a license for recovery.', 'dim')),
  ]};
};

const providerDialog = (ctx: TuiContext, provider?: FederationProvider) => {
  const draft = initialFederationDraft(provider);
  let validation: FederationValidation | undefined;
  let validatedSource = '';
  const sourceKey = () => `${draft.protocol}:${draft.metadataUrl.trim()}`;
  const validated = () => Boolean(validation) && validatedSource === sourceKey();
  const resetValidation = () => { validation = undefined; validatedSource = ''; };
  const mapping = (index: number, patch: Partial<FederationMapping>) => {
    draft.mappings = draft.mappings.map((item, itemIndex) => itemIndex === index ? {...item, ...patch} : item);
  };
  // Mirrors the browser's required fields and its `ready` condition.
  const problem = () => {
    if (!draft.alias.trim() || !ALIAS.test(draft.alias.trim())) return 'Enter an alias: a lowercase DNS label (letters, digits, inner hyphens).';
    if (!draft.displayName.trim()) return 'Enter a display name.';
    if (!draft.metadataUrl.trim()) return `Enter the ${draft.protocol === 'oidc' ? 'discovery' : 'metadata'} URL.`;
    if (draft.protocol === 'oidc' && !draft.clientId?.trim()) return 'Enter the client ID.';
    if (draft.protocol === 'oidc' && !draft.clientSecret) return provider ? 'Enter the client secret again; existing secrets are never returned.' : 'Enter the client secret.';
    if (draft.protocol === 'oidc' && !draft.scopes?.trim()) return 'Enter the scopes.';
    if (!draft.mappings.length || !draft.mappings.every((item) => item.source.trim() && item.value.trim())) return 'Every mapping needs a claim or attribute and an exact value.';
    if (!validated()) return 'Validate metadata before saving.';
    return undefined;
  };
  ctx.dialog({
    title: provider ? `Edit ${provider.displayName}` : 'Add federated identity provider',
    description: 'Configure an upstream OIDC or SAML provider. Local recovery login remains available.',
    items: () => {
      const oidc = draft.protocol === 'oidc';
      const items: DialogItem[] = [
        {kind: 'choice', id: 'protocol', label: 'Protocol', value: draft.protocol, choices: [{value: 'oidc', label: 'OpenID Connect'}, {value: 'saml', label: 'SAML 2.0'}],
          disabled: provider ? 'The protocol of an existing provider cannot be changed.' : undefined,
          onChange: (value) => { draft.protocol = value as FederationDraft['protocol']; resetValidation(); }},
        {kind: 'text', id: 'alias', label: 'Alias', value: draft.alias, required: true, hint: 'company-login',
          disabled: provider ? 'The alias of an existing provider cannot be changed.' : undefined, onChange: (value) => { draft.alias = value; }},
        {kind: 'note', text: 'Lowercase DNS label; it becomes part of the callback URL.', tone: draft.alias && !ALIAS.test(draft.alias) ? 'warn' : 'dim'},
        {kind: 'text', id: 'display', label: 'Display name', value: draft.displayName, required: true, hint: 'Company SSO', onChange: (value) => { draft.displayName = value; }},
        {kind: 'text', id: 'metadata', label: oidc ? 'Discovery URL' : 'Metadata URL', value: draft.metadataUrl, required: true,
          hint: oidc ? 'https://id.example.com/.well-known/openid-configuration' : 'https://id.example.com/saml/metadata',
          onChange: (value) => { draft.metadataUrl = value; resetValidation(); }},
      ];
      if (oidc) items.push(
        {kind: 'text', id: 'client-id', label: 'Client ID', value: draft.clientId ?? '', required: true, onChange: (value) => { draft.clientId = value; }},
        {kind: 'text', id: 'client-secret', label: 'Client secret', value: draft.clientSecret ?? '', secret: true, required: true, onChange: (value) => { draft.clientSecret = value; }},
        {kind: 'note', text: provider ? 'Enter the secret again for every update. Existing secrets are never returned.' : 'Stored only in Keycloak and never returned by the dashboard API.'},
        {kind: 'text', id: 'scopes', label: 'Scopes', value: draft.scopes ?? '', required: true, onChange: (value) => { draft.scopes = value; }},
        {kind: 'check', id: 'trust-email', label: 'Trust email verification from this provider', checked: draft.trustEmail, onChange: (checked) => { draft.trustEmail = checked; }},
      );
      items.push(
        {kind: 'buttons', items: [{id: 'validate', label: 'Validate metadata', disabled: draft.metadataUrl.trim() ? undefined : 'Enter the metadata URL first.',
          onPress: () => {
            const source = sourceKey();
            void ctx.task('Validating metadata', () => ctx.api.validateFederation({protocol: draft.protocol, metadataUrl: draft.metadataUrl.trim()}), (value) => {
              validation = value;
              validatedSource = source;
            });
          }}]},
        validated() ? {kind: 'note', text: 'Metadata verified. Review the discovered endpoints, then save.', tone: 'good'}
          : {kind: 'note', text: 'Validate metadata before saving.'},
        ...(validated() ? [{kind: 'facts' as const, rows: Object.entries(validation!.configuration)}] : []),
        {kind: 'heading', text: 'Group and claim mappings'},
        {kind: 'note', text: 'Only an exact matching upstream claim or SAML attribute grants one fixed Magic Stick access level. Users with no match receive no Magic Stick role.'},
      );
      draft.mappings.forEach((item, index) => items.push(
        {kind: 'heading', text: `Mapping ${index + 1}`},
        {kind: 'text', id: `map-source-${index}`, label: oidc ? 'Claim' : 'Attribute', value: item.source, required: true, onChange: (value) => mapping(index, {source: value})},
        {kind: 'text', id: `map-value-${index}`, label: 'Exact value', value: item.value, required: true, hint: 'magicstick-users', onChange: (value) => mapping(index, {value})},
        {kind: 'choice', id: `map-level-${index}`, label: 'Magic Stick access', value: item.accessLevel, choices: ACCESS_LEVELS,
          onChange: (value) => mapping(index, {accessLevel: value as FederationMapping['accessLevel']})},
        {kind: 'buttons', items: [{id: `map-remove-${index}`, label: 'Remove mapping', disabled: draft.mappings.length === 1 ? 'At least one mapping is required.' : undefined,
          onPress: () => { draft.mappings = draft.mappings.filter((_, itemIndex) => itemIndex !== index); }}]},
      ));
      items.push(
        {kind: 'buttons', items: [{id: 'map-add', label: 'Add mapping', disabled: draft.mappings.length >= 50 ? 'At most 50 mappings are supported.' : undefined,
          onPress: () => { draft.mappings = [...draft.mappings, newMapping()]; }}]},
        {kind: 'check', id: 'enabled', label: 'Enable this provider after a successful save', checked: draft.enabled, onChange: (checked) => { draft.enabled = checked; }},
        {kind: 'note', text: 'Administrator mappings grant powerful access. Keep at least one enabled local recovery administrator and test a non-administrator mapping first.', tone: 'warn'},
      );
      return items;
    },
    submit: {
      label: 'Save provider',
      disabled: problem,
      run: () => ctx.perform(provider ? `Update ${provider.displayName}` : 'Add identity provider', async () => {
        if (provider) await ctx.api.updateFederation(provider.alias, federationPayload(draft));
        else await ctx.api.createFederation(federationPayload(draft));
        return {lines: [`${draft.displayName || draft.alias} was ${provider ? 'updated' : 'created'}.`]};
      }),
    },
  });
};

const federationAction = (ctx: TuiContext, verb: string, alias: string) => {
  if (verb === 'refresh') return void ctx.refresh();
  const status = ctx.snapshot().federatedSso;
  if (!status) return ctx.message('Federated SSO unavailable', 'The Federated SSO status has not been loaded yet. Press r to reload.');
  const unlicensed = 'A valid Free Registered or Commercial Federated SSO entitlement is required to add or change providers.';
  if (verb === 'add') return status.feature.available ? providerDialog(ctx) : ctx.message('Not available', unlicensed);
  const provider = status.providers.find((item) => item.alias === alias);
  if (!provider) return ctx.missing();
  if (verb === 'copy') {
    const url = callbackFor(ctx.snapshot(), alias);
    ctx.copy(url);
    return ctx.message('Callback URL', [url, 'Copied through the terminal clipboard protocol. Register this URL with the upstream provider.'], 'normal', url);
  }
  if (verb === 'edit') return status.feature.available ? providerDialog(ctx, provider) : ctx.message('Not available', unlicensed);
  if (verb === 'delete') return ctx.confirm({
    title: `Delete ${provider.displayName}?`, description: 'This removes the provider and its dashboard-managed mappings from Keycloak. Existing local accounts remain.',
    confirmLabel: 'delete provider', expected: provider.alias, danger: true,
    onConfirm: () => ctx.perform(`Delete ${provider.displayName}`, async () => {
      await ctx.api.deleteFederation(provider.alias, provider.revision);
      return {lines: [`${provider.displayName} was deleted.`]};
    }),
  });
};

// --- Local console -------------------------------------------------------------------------------

const CONSOLE_INFO = [
  'The monitor and keyboard attached to the appliance show the terminal dashboard. It signs in automatically, so the appliance can be operated without a network connection or a second device.',
  'With Off, the console asks for a user sign-in that is confirmed in a browser on another device. A user can always switch to their own account there.',
];
const consoleWarning = (level: ConsoleAccessLevel) => `Anyone with physical access to the attached keyboard gets ${consoleAccessLabel(level)} access without a password.`;
const CONSOLE_UNAVAILABLE = 'This appliance has not set up automatic console sign-in yet. It becomes available after the next platform update.';

const consoleRows = (snapshot: DashboardSnapshot, width: number): PageView => {
  const inner = width - 4;
  const access = snapshot.consoleAccess;
  if (!access) return {hotkeys: [], rows: note(width, 'Local console', 'The console sign-in setting could not be loaded.')};
  return {hotkeys: access.available ? [{key: 'e', label: 'Monitor sign-in', actionId: 'console:edit'}] : [], rows: panel(width, {title: 'Local console'}, [
    ...(!access.available ? [...prose(inner, CONSOLE_UNAVAILABLE, 'warn'), blank] : []),
    fit(inner, [span(`Automatic sign-in  ${access.available ? consoleAccessLabel(access.accessLevel) : 'Not provisioned on this appliance yet'}`)],
      access.available ? [button('console:edit', 'Change')] : []),
    ...(access.available && access.accessLevel !== 'off' ? prose(inner, consoleWarning(access.accessLevel), 'warn') : []),
    blank,
    ...CONSOLE_INFO.flatMap((line) => prose(inner, line, 'dim')),
  ])};
};

const editConsoleAccess = (ctx: TuiContext) => {
  const access = ctx.snapshot().consoleAccess;
  if (!access?.available) return ctx.message('Automatic sign-in unavailable', CONSOLE_UNAVAILABLE);
  let level: ConsoleAccessLevel = access.accessLevel;
  ctx.dialog({
    title: 'Monitor sign-in',
    description: 'Access of the attached monitor and keyboard without a login. Off requires a user sign-in from a second device. Changes apply immediately; a lower level can only be raised again by a signed-in administrator.',
    items: () => [
      {kind: 'choice', id: 'accessLevel', label: 'Automatic sign-in', value: level, choices: CONSOLE_ACCESS_LEVELS.map((value) => ({value, label: consoleAccessLabel(value)})),
        onChange: (value) => { level = value as ConsoleAccessLevel; }},
      ...(level !== 'off' ? [{kind: 'note' as const, text: consoleWarning(level), tone: 'warn' as const}] : []),
    ],
    submit: {
      label: 'save',
      // Like the browser: only a different level can be saved; polling never replaces the selection.
      disabled: () => level === (ctx.snapshot().consoleAccess?.accessLevel ?? access.accessLevel) ? 'This level is already active.' : undefined,
      run: () => ctx.perform('Change monitor sign-in', async () => {
        const result = await ctx.api.updateConsoleAccess(level);
        return {lines: [`Local console sign-in saved: ${consoleAccessLabel(result?.accessLevel ?? level)}.`]};
      }),
    },
  });
};

// --- Section -------------------------------------------------------------------------------------

export const settingsSection = (snapshot: DashboardSnapshot, state: PageState, width: number): PageView => {
  const active = activeSettingsSection(snapshot, state.settingsSection);
  const body: PageView = active === 'console' ? consoleRows(snapshot, width)
    : active === 'network' ? networkSection(snapshot, state, width)
      : active === 'updates' ? updatesSection(snapshot, state, width)
        : active === 'federated-sso' ? federationRows(snapshot, width)
          : domainsRows(snapshot, width);
  return {hotkeys: [{key: 't', label: 'Settings tab', actionId: 'settings-tab:next'}, ...body.hotkeys], tick: body.tick, rows: [
    tabBar('settings-tab', availableSettingsSections(snapshot), active),
    blank,
    ...body.rows,
  ]};
};

export const settingsModule: AreaModule = {
  scopes: {console: 'admin', settings: 'admin', federation: 'admin'},
  readOnly: ({scope, verb}) => scope === 'federation' && verb === 'refresh',
  handle: (ctx, {scope, verb, target}) => {
    if (scope === 'console') return editConsoleAccess(ctx);
    if (scope === 'settings' && verb === 'domains') return editDomains(ctx);
    if (scope === 'federation') return federationAction(ctx, verb, target);
  },
};
