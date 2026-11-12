import {describe, expect, it} from 'vitest';
import {initialInstanceDraft, instanceCreatePayload, instanceHasCredentials, instanceHasStorage, instanceHost, instanceModelRequired, instanceStorageDefault} from '@magicstick/dashboard-core';

describe('shared create-instance payload', () => {
  it('derives <instance-name>.<instance-type>.<domain> hostnames', () => {
    expect(instanceHost('hermes', 'default', 'example.com')).toBe('default.hermes.example.com');
    expect(instanceHost('hermes', 'hermes-team', '.example.com.')).toBe('team.hermes.example.com');
    expect(instanceHost('pi-coding', 'My Space', 'example.com')).toBe('my-space.pi-coding.example.com');
  });

  it('starts every application from the same defaults in the browser and the terminal', () => {
    expect(initialInstanceDraft('openclaw', 'qwen')).toMatchObject({type: 'openclaw', name: 'default', model: 'qwen', storage: '20Gi', authentication: 'sso', role: 'user', exposure: 'localAndPublic', sharing: {mode: 'all'}});
    expect(instanceStorageDefault('hermes')).toBe('10Gi');
    expect(instanceStorageDefault('unknown')).toBe('5Gi');
    expect(instanceHasStorage('kubeopencode')).toBe(false);
    expect(instanceModelRequired('hermes')).toBe(true);
    expect(instanceHasCredentials('paperclip')).toBe(true);
    expect(instanceHasCredentials('hermes')).toBe(false);
  });

  it('builds the simple workspace applications', () => {
    expect(instanceCreatePayload(initialInstanceDraft('hermes', 'qwen'), 'example.com')).toEqual({
      name: 'default', enabled: true, namespace: 'ai', model: 'qwen',
      access: {authentication: 'sso', role: 'user', exposure: 'localAndPublic'},
      storage: {size: '10Gi'}, ingress: {enabled: false, host: 'default.hermes.example.com'},
    });
    const shared = instanceCreatePayload({...initialInstanceDraft('openclaw', 'qwen'), sharing: {mode: 'selected', users: ['u1'], groups: []}}, '');
    expect(shared.access).toEqual({authentication: 'sso', role: 'user', exposure: 'localAndPublic', sharing: {mode: 'selected', users: ['u1'], groups: []}});
    expect(shared.ingress).toEqual({enabled: false, host: 'default.openclaw.magicstick.example.com'});
  });

  it('builds Paperclip, KubeOpenCode and Odysseus with their own values only', () => {
    const paperclip = instanceCreatePayload({...initialInstanceDraft('paperclip', 'openai/qwen'), maxConcurrentAgents: 40, hermesEnabled: true, hermesInstanceRef: 'hermes-default'}, 'example.com');
    expect(paperclip).toMatchObject({
      storage: {size: '5Gi'}, database: {managed: {storageSize: '10Gi'}}, admin: {email: 'admin@example.com', name: 'Admin'},
      agentExecution: {defaultModel: 'litellm/qwen', maxConcurrentAgents: 10, openCode: {enabled: true}, openClaw: {enabled: false, instanceRef: ''}, hermes: {enabled: true, instanceRef: 'hermes-default'}},
    });
    const kubeopencode = instanceCreatePayload(initialInstanceDraft('kubeopencode', 'qwen'), 'example.com');
    expect(kubeopencode).toMatchObject({server: {enabled: true, ingress: {enabled: false, host: 'default.kubeopencode.example.com'}}, agentTemplates: [{name: 'default-coder'}]});
    expect(kubeopencode).not.toHaveProperty('storage');
    expect(kubeopencode).not.toHaveProperty('agentExecution');
    expect(instanceCreatePayload(initialInstanceDraft('odysseus', 'qwen'), 'example.com')).toMatchObject({
      storage: {size: '20Gi'}, chroma: {storage: {size: '5Gi'}}, searxng: {storage: {size: '1Gi'}}, ntfy: {storage: {size: '1Gi'}},
    });
  });

  it('rejects incomplete drafts before anything is sent', () => {
    expect(() => instanceCreatePayload({...initialInstanceDraft('hermes', 'qwen'), name: 'Bad Name'}, 'example.com')).toThrow('lowercase');
    expect(() => instanceCreatePayload({...initialInstanceDraft('hermes', 'qwen'), name: `a${'-'.repeat(100_000)}!`}, 'example.com')).toThrow('lowercase');
    expect(instanceCreatePayload({...initialInstanceDraft('hermes', 'qwen'), name: 'a-b'}, 'example.com')).toMatchObject({name: 'a-b'});
    expect(() => instanceCreatePayload(initialInstanceDraft('hermes', ''), 'example.com')).toThrow('chat model');
    expect(() => instanceCreatePayload({...initialInstanceDraft('paperclip', 'qwen'), openClawEnabled: true}, 'example.com')).toThrow('OpenClaw');
    expect(() => instanceCreatePayload({...initialInstanceDraft('paperclip', 'qwen'), hermesEnabled: true}, 'example.com')).toThrow('Hermes');
  });
});
