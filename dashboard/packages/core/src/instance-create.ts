// Create-instance draft and payload shared by the browser form and the terminal dashboard,
// so both send the same AppInstance values for the same choices.
import type {InstanceSharing} from '@magicstick/dashboard-contracts';

export interface InstanceDraft {
  type: string;
  name: string;
  model: string;
  storage: string;
  authentication: string;
  role: string;
  exposure: string;
  sharing: InstanceSharing;
  adminEmail: string;
  postgresStorage: string;
  maxConcurrentAgents: number;
  openCodeEnabled: boolean;
  openClawEnabled: boolean;
  openClawInstanceRef: string;
  hermesEnabled: boolean;
  hermesInstanceRef: string;
  template: string;
  chromaStorage: string;
  searxngStorage: string;
  ntfyStorage: string;
}

const storageDefaults: Record<string, string> = {
  openclaw: '20Gi', hermes: '10Gi', paperclip: '5Gi', odysseus: '20Gi', kubeopencode: '5Gi', 'pi-coding': '5Gi',
};

export const instanceStorageDefault = (type: string) => storageDefaults[type] ?? '5Gi';
export const instanceModelRequired = (type: string) => ['openclaw', 'hermes', 'paperclip', 'kubeopencode', 'odysseus', 'pi-coding'].includes(type);
/** Applications whose form has a storage size; KubeOpenCode has none. */
export const instanceHasStorage = (type: string) => type !== 'kubeopencode';
/** Applications whose stored credentials can be shown on request. */
export const instanceHasCredentials = (type: string) => ['openclaw', 'odysseus', 'paperclip'].includes(type);

export const initialInstanceDraft = (type: string, model = ''): InstanceDraft => ({
  type, name: 'default', model, storage: instanceStorageDefault(type),
  authentication: 'sso', role: 'user', exposure: 'localAndPublic', sharing: {mode: 'all', users: [], groups: []},
  adminEmail: 'admin@example.com', postgresStorage: '10Gi', maxConcurrentAgents: 2,
  openCodeEnabled: true, openClawEnabled: false, openClawInstanceRef: '', hermesEnabled: false, hermesInstanceRef: '',
  template: 'default-coder', chromaStorage: '5Gi', searxngStorage: '1Gi', ntfyStorage: '1Gi',
});

const dnsPart = (value: string, fallback: string) => value.trim().toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/--+/g, '-') || fallback;

/** `<instance-name>.<instance-type>.<domain>`, the hostname contract of application instances. */
export const instanceHost = (type: string, name: string, publicDomain: string) => {
  const cleanType = dnsPart(type, 'instance');
  let cleanName = dnsPart(name, 'default');
  if (cleanName.startsWith(`${cleanType}-`)) cleanName = cleanName.slice(cleanType.length + 1) || 'default';
  return `${cleanName}.${cleanType}.${publicDomain.replace(/^\.|\.$/g, '')}`;
};

/** The request body for `POST /api/instances/<type>`. Throws a user-readable error for an incomplete draft. */
export const instanceCreatePayload = (draft: InstanceDraft, publicDomain: string): Record<string, unknown> => {
  const {type, model} = draft;
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(draft.name)) throw new Error('The name may contain lowercase letters, digits and hyphens, and must start and end with a letter or digit.');
  if (instanceModelRequired(type) && !model) throw new Error('Select a deployed chat model.');
  if (type === 'paperclip' && draft.openClawEnabled && !draft.openClawInstanceRef) throw new Error('Select an OpenClaw instance or disable its gateway.');
  if (type === 'paperclip' && draft.hermesEnabled && !draft.hermesInstanceRef) throw new Error('Select a Hermes instance or disable its gateway.');
  const host = instanceHost(type, draft.name, publicDomain || 'magicstick.example.com');
  const base: Record<string, unknown> = {
    name: draft.name, enabled: true, namespace: 'ai', model: model || 'CHANGEME_MODEL',
    access: {authentication: draft.authentication, role: draft.role, exposure: draft.exposure, ...(draft.sharing.mode === 'selected' ? {sharing: draft.sharing} : {})},
  };
  if (type === 'openclaw' || type === 'hermes' || type === 'pi-coding') {
    base.storage = {size: draft.storage};
    base.ingress = {enabled: false, host};
  }
  if (type === 'paperclip') {
    base.storage = {size: draft.storage};
    base.database = {managed: {storageSize: draft.postgresStorage}};
    base.ingress = {enabled: false, host};
    base.admin = {email: draft.adminEmail, name: 'Admin'};
    base.agentExecution = {
      defaultModel: `litellm/${model.replace(/^(litellm|openai)\//, '')}`,
      maxConcurrentAgents: Math.max(1, Math.min(10, Math.trunc(draft.maxConcurrentAgents))),
      openCode: {enabled: draft.openCodeEnabled},
      openClaw: {enabled: draft.openClawEnabled, instanceRef: draft.openClawInstanceRef},
      hermes: {enabled: draft.hermesEnabled, instanceRef: draft.hermesInstanceRef},
    };
  }
  if (type === 'kubeopencode') {
    base.server = {enabled: true, ingress: {enabled: false, host}};
    base.agentTemplates = [{name: draft.template, description: 'Default coding agent template'}];
  }
  if (type === 'odysseus') {
    base.storage = {size: draft.storage};
    base.chroma = {storage: {size: draft.chromaStorage}};
    base.searxng = {storage: {size: draft.searxngStorage}};
    base.ntfy = {storage: {size: draft.ntfyStorage}};
    base.ingress = {enabled: false, host};
  }
  return base;
};
