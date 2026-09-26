import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ManagedHost} from '@magicstick/dashboard-contracts';
import {SoftwareChannelEditor} from './SoftwareChannelEditor';

let host: ManagedHost;
const writes: Array<Record<string, unknown>> = [];
const renderEditor = () => <QueryClientProvider client={new QueryClient()}><SoftwareChannelEditor host={host} stale={false} /></QueryClientProvider>;

describe('Software channels', () => {
  beforeEach(() => {
    writes.length = 0;
    host = {name: 'example-node', nodeUid: 'node-uid', bootId: 'boot-a', kernel: 'test', available: true, message: '',
      software: {supported: true, id: 'a'.repeat(64), channel: {kind: 'branch', value: 'main'}, hostCommit: 'b'.repeat(40)}};
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') writes.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({accepted: true}), {headers: {'content-type': 'application/json'}});
    }));
  });

  it('does not mutate on opening and only applies reviewed changes', async () => {
    host.software!.observed = {sourceRevision: 'sha1:' + 'b'.repeat(40), appliedRevision: 'sha1:' + 'b'.repeat(40),
      ready: true, checkedAtEpoch: Date.now() / 1000, images: []};
    render(renderEditor());
    expect(screen.getAllByText('b'.repeat(12))).toHaveLength(2);
    expect(screen.getByLabelText('Software channel')).toHaveValue('main');
    expect(screen.getByRole('button', {name: 'Apply channel'})).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Software channel'), 'develop');
    expect(screen.getByRole('button', {name: 'Apply channel'})).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Software channel'), 'main');
    expect(screen.getByRole('button', {name: 'Apply channel'})).toBeDisabled();
    expect(writes).toEqual([]);
  });

  it('checks slash-separated feature branches and preserves the draft during polling', async () => {
    const view = render(renderEditor());
    await userEvent.selectOptions(screen.getByLabelText('Software channel'), 'branch');
    await userEvent.type(screen.getByLabelText('Branch name'), 'feature/my-change');
    view.rerender(renderEditor());
    expect(screen.getByLabelText('Branch name')).toHaveValue('feature/my-change');
    await userEvent.click(screen.getByRole('button', {name: 'Check channel'}));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({action: 'check-software-channel', softwareChannel: {kind: 'branch', value: 'feature/my-change'}});
    expect(writes[0]).not.toHaveProperty('softwarePreviewId');
  });

  it('applies exactly the reviewed feature branch after confirmation', async () => {
    host.software!.preview = {id: 'c'.repeat(64), configurationId: 'a'.repeat(64), channel: {kind: 'branch', value: 'feature/test'},
      commit: 'd'.repeat(40), ready: true, checkedAtEpoch: Date.now() / 1000, images: []};
    render(renderEditor());
    await userEvent.selectOptions(screen.getByLabelText('Software channel'), 'branch');
    await userEvent.type(screen.getByLabelText('Branch name'), 'feature/test');
    expect(screen.getByRole('button', {name: 'Apply channel'})).toBeEnabled();
    await userEvent.click(screen.getByRole('button', {name: 'Apply channel'}));
    const dialog = screen.getByRole('dialog', {name: 'Change software channel'});
    expect(within(dialog).getByRole('button', {name: 'Apply channel'})).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Type example-node to confirm'), 'example-node');
    await userEvent.click(within(dialog).getByRole('button', {name: 'Apply channel'}));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({action: 'apply-software-channel', softwarePreviewId: 'c'.repeat(64),
      softwareChannel: {kind: 'branch', value: 'feature/test'}});
  });

  it('rejects abbreviated commits and disables busy or unavailable hosts', async () => {
    const view = render(renderEditor());
    await userEvent.selectOptions(screen.getByLabelText('Software channel'), 'commit');
    await userEvent.type(screen.getByLabelText('Full commit'), 'abc123');
    expect(screen.getByRole('button', {name: 'Check channel'})).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Full commit'));
    await userEvent.type(screen.getByLabelText('Full commit'), 'a'.repeat(40));
    expect(screen.getByRole('button', {name: 'Check channel'})).toBeEnabled();
    host = {...host, available: false}; view.rerender(renderEditor());
    expect(screen.getByRole('button', {name: 'Check channel'})).toBeDisabled();
  });
});
