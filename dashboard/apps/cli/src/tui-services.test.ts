import {describe, expect, it, vi} from 'vitest';
import type {MagicStickApi} from '@magicstick/dashboard-api-client';
import type {DashboardSnapshot} from './snapshot';
import type {ConfirmOptions, TuiContext} from './tui-context';
import {formDialog, type DialogItem, type DialogSpec, type InlineButton} from './tui-dialogs';
import {servicesModule, servicesPage} from './tui-services';
import {initialPageState} from './tui-state';
import {fit} from './tui-screen';

const snapshot = (roles = ['magicstick-admin']): DashboardSnapshot => ({
  session: {subject: '1', username: 'tova', roles, identityManagementAvailable: true, identityManagementMode: 'keycloak'},
  appliance: {metadata: {name: 'local'}, status: {phase: 'Ready'}},
  modules: {
    modules: {
      litellm: {enabled: true, displayName: 'LiteLLM', activationMode: 'moduleactivation', status: {phase: 'Ready'}},
      paperclip: {enabled: true, activationMode: 'moduleactivation', status: {phase: 'Ready'}},
      openclaw: {enabled: true, activationMode: 'moduleactivation', status: {phase: 'Ready'}},
      odysseus: {enabled: false, activationMode: 'moduleactivation', parameters: {model: 'gone-model', storage: {size: '7Gi'}}},
    },
    catalogJson: {
      modules: {
        litellm: {displayName: 'LiteLLM', group: 'runtime', activationMode: 'moduleactivation'},
        paperclip: {displayName: 'Paperclip', group: 'apps', activationMode: 'moduleactivation'},
        openclaw: {displayName: 'OpenClaw', group: 'apps', activationMode: 'moduleactivation'},
        odysseus: {displayName: 'Odysseus', group: 'apps', activationMode: 'moduleactivation', parameters: [
          {name: 'model', label: 'Embedding model', type: 'model', modelType: 'embedding', description: 'Used for document search.'},
          {name: 'storage', label: 'Storage'},
          {name: 'token', label: 'Token', type: 'password'},
        ]},
      },
      applications: {
        paperclip: {displayName: 'Paperclip', requiredModules: ['paperclip', 'litellm']},
        openclaw: {displayName: 'OpenClaw', requiredModules: ['openclaw', 'litellm']},
        odysseus: {displayName: 'Odysseus', requiredModules: ['odysseus', 'litellm']},
      },
    },
  },
  instances: {instances: {openclaw: [{metadata: {name: 'claw'}, spec: {enabled: true}, status: {phase: 'Ready'}}]}},
  models: {
    models: [{id: 'chat-a', type: 'chat'}, {id: 'embed-a', type: 'embedding'}], activations: [], presets: {},
    computeTargets: {targets: []},
  },
  settings: {publicDomain: 'example.com', dashboardHost: 'dashboard.example.com', mdnsDomain: 'example.local', mdnsName: 'example'},
  status: {},
  loadedAt: Date.now(),
});

const harness = (data: DashboardSnapshot, api: Record<string, unknown> = {}) => {
  const log = {dialogs: [] as DialogSpec[], confirms: [] as ConfirmOptions[], messages: [] as Array<{title: string; lines: string[]}>};
  const ctx: TuiContext = {
    api: api as unknown as MagicStickApi, view: initialPageState(), demo: false,
    snapshot: () => data, session: () => data.session, draw: () => undefined, refresh: async () => undefined,
    message: (title, lines) => { log.messages.push({title, lines: Array.isArray(lines) ? lines : [lines]}); },
    perform: async (title, operation) => { const result = await operation(); log.messages.push({title: 'Completed', lines: result?.lines ?? [title]}); },
    task: async (_title, operation, then) => { const value = await operation(); then?.(value); },
    load: async (_title, fetch, then) => { then(await fetch()); },
    confirm: (options) => { log.confirms.push(options); },
    form: (title, description, fields, submitLabel, onSubmit) => { log.dialogs.push(formDialog(title, description, fields, submitLabel, onSubmit).spec); },
    dialog: (spec) => { log.dialogs.push(spec); },
    menu: () => undefined, viewer: () => undefined, current: () => undefined, close: () => undefined,
    copy: () => undefined, saveAs: () => undefined, openFile: () => undefined, requestId: () => 'a'.repeat(32), missing: () => { log.messages.push({title: 'missing', lines: []}); },
  };
  return {ctx, log};
};

type Focusable = Exclude<DialogItem, {kind: 'buttons' | 'note' | 'heading' | 'facts' | 'blank'}>;
const field = (spec: DialogSpec, id: string) => spec.items().find((item) => 'id' in item && item.id === id) as Focusable;
const press = (spec: DialogSpec, id: string) => {
  const entry = spec.items().flatMap((item) => item.kind === 'buttons' ? item.items : []).find((candidate: InlineButton) => candidate.id === id);
  if (!entry) throw new Error(`No button ${id}`);
  if (entry.disabled) throw new Error(entry.disabled);
  entry.onPress();
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const pageText = (data: DashboardSnapshot) => servicesPage(data, {...initialPageState(), serviceFilter: 'applications'}, 91).rows.map((row) => fit(91, row).map((item) => item.text).join('')).join('\n');

describe('terminal Services page', () => {
  it('names the parameters a disabled module asks for when it is enabled', () => {
    expect(pageText(snapshot())).toContain('Configurable when enabling: Embedding model, Storage, Token.');
    expect(pageText(snapshot(['magicstick-viewer']))).not.toContain('Configurable when enabling');
  });

  it('enables a module with the saved and edited parameters, rejecting an unavailable model', async () => {
    const enableModule = vi.fn(async () => ({}));
    const {ctx, log} = harness(snapshot(), {enableModule});
    servicesModule.handle(ctx, {id: 'service:enable:odysseus', scope: 'service', verb: 'enable', target: 'odysseus'});
    const dialog = log.dialogs[0]!;
    const model = field(dialog, 'param:model') as Extract<DialogItem, {kind: 'choice'}>;
    expect(model.choices.map((choice) => choice.label)).toEqual(['Use catalog default', 'gone-model · unavailable', 'embed-a']);
    expect(model.choices[1]!.disabled).toContain('Choose an available embedding model');
    expect((field(dialog, 'param:token') as Extract<DialogItem, {kind: 'text'}>).secret).toBe(true);
    expect(field(dialog, 'param:storage').kind === 'text' && (field(dialog, 'param:storage') as Extract<DialogItem, {kind: 'text'}>).value).toBe('7Gi');
    expect(dialog.submit!.disabled!()).toContain('Embedding model');
    model.onChange('embed-a');
    expect(dialog.submit!.disabled!()).toBeUndefined();
    await dialog.submit!.run();
    expect(enableModule).toHaveBeenCalledWith('odysseus', {model: 'embed-a', storage: '7Gi'});
  });

  it('creates a Paperclip instance with a gateway, limits and selected users, as the browser sends it', async () => {
    const createInstance = vi.fn(async () => ({}));
    const instancePrincipals = vi.fn(async () => ({kind: 'users', items: [{id: 'u1', name: 'robin'}], next: 50}));
    const {ctx, log} = harness(snapshot(), {createInstance, instancePrincipals});
    servicesModule.handle(ctx, {id: 'instance:create:paperclip', scope: 'instance', verb: 'create', target: 'paperclip'});
    const dialog = log.dialogs[0]!;
    const application = field(dialog, 'application') as Extract<DialogItem, {kind: 'choice'}>;
    expect(application.value).toBe('paperclip');
    expect(application.choices.find((choice) => choice.value === 'odysseus')?.disabled).toContain('Required services are not ready');
    expect((field(dialog, 'admin-email') as Extract<DialogItem, {kind: 'text'}>).value).toBe('admin@example.com');
    expect((field(dialog, 'runtime-hermes') as Extract<DialogItem, {kind: 'check'}>).disabled).toContain('No Hermes instance');
    expect((field(dialog, 'runtime-openclaw-instance') as Extract<DialogItem, {kind: 'choice'}>).disabled).toContain('Enable the OpenClaw gateway first');
    (field(dialog, 'runtime-openclaw') as Extract<DialogItem, {kind: 'check'}>).onChange(true);
    (field(dialog, 'runtime-openclaw-instance') as Extract<DialogItem, {kind: 'choice'}>).onChange('claw');
    (field(dialog, 'configure') as Extract<DialogItem, {kind: 'toggle'}>).onChange(true);
    const agents = field(dialog, 'agents') as Extract<DialogItem, {kind: 'number'}>;
    agents.onChange('11');
    expect(dialog.submit!.disabled!()).toContain('Parallel agents');
    agents.onChange('4');
    (field(dialog, 'share-mode') as Extract<DialogItem, {kind: 'choice'}>).onChange('selected');
    await settle();
    expect(instancePrincipals).toHaveBeenCalledWith('users', '', 0);
    press(dialog, 'share-add:users:u1');
    press(dialog, 'share-next');
    await settle();
    expect(instancePrincipals).toHaveBeenLastCalledWith('users', '', 50);
    expect(dialog.submit!.disabled!()).toBeUndefined();
    await dialog.submit!.run();
    const [type, payload] = createInstance.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(type).toBe('paperclip');
    expect(payload.access).toEqual({authentication: 'sso', role: 'user', exposure: 'localAndPublic', sharing: {mode: 'selected', users: ['u1'], groups: []}});
    expect(payload.agentExecution).toMatchObject({defaultModel: 'litellm/chat-a', maxConcurrentAgents: 4, openClaw: {enabled: true, instanceRef: 'claw'}, hermes: {enabled: false}});
    expect(payload.ingress).toEqual({enabled: false, host: 'default.paperclip.example.com'});
  });

  it('drops a sharing selection when the instance becomes public', () => {
    const {ctx, log} = harness(snapshot(), {instancePrincipals: vi.fn(async () => ({kind: 'users', items: [], next: null}))});
    servicesModule.handle(ctx, {id: 'instance:create:openclaw', scope: 'instance', verb: 'create', target: 'openclaw'});
    const dialog = log.dialogs[0]!;
    (field(dialog, 'share-mode') as Extract<DialogItem, {kind: 'choice'}>).onChange('selected');
    (field(dialog, 'authentication') as Extract<DialogItem, {kind: 'choice'}>).onChange('none');
    expect(field(dialog, 'share-mode')).toBeUndefined();
    (field(dialog, 'authentication') as Extract<DialogItem, {kind: 'choice'}>).onChange('sso');
    expect((field(dialog, 'share-mode') as Extract<DialogItem, {kind: 'choice'}>).value).toBe('all');
  });

  it('keeps sharing read-only until the access guard is ready', async () => {
    const updateInstanceAccess = vi.fn(async () => ({}));
    const data = snapshot();
    const {ctx, log} = harness(data, {
      updateInstanceAccess,
      instanceAccess: async () => ({name: 'claw', revision: 'r7', sharing: {mode: 'all'}, authentication: 'sso', guardReady: false, principals: {users: [], groups: []}}),
    });
    servicesModule.handle(ctx, {id: 'instance:sharing:claw', scope: 'instance', verb: 'sharing', target: 'claw'});
    await settle();
    const dialog = log.dialogs[0]!;
    expect(dialog.items().some((item) => item.kind === 'note' && item.text.includes('still preparing the access guard'))).toBe(true);
    expect((field(dialog, 'share-confirm') as Extract<DialogItem, {kind: 'check'}>).disabled).toBeTruthy();
    expect(dialog.submit!.disabled!()).toContain('access guard');
    expect(updateInstanceAccess).not.toHaveBeenCalled();
  });

  it('refuses to remove a selectively shared instance for an operator', () => {
    const data = snapshot(['magicstick-operator']);
    data.instances = {instances: {openclaw: [{metadata: {name: 'claw'}, spec: {enabled: true, access: {sharing: {mode: 'selected', users: ['u1']}}}, status: {phase: 'Ready'}}]}};
    const {ctx, log} = harness(data);
    servicesModule.handle(ctx, {id: 'instance:remove:claw', scope: 'instance', verb: 'remove', target: 'claw'});
    expect(log.confirms).toHaveLength(0);
    expect(log.messages[0]?.title).toBe('Administrator access required');
  });
});
