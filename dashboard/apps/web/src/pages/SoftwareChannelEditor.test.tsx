import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {ManagedHost, SoftwareReleaseCatalog} from '@magicstick/dashboard-contracts';
import {SoftwareChannelEditor} from './SoftwareChannelEditor';

let host: ManagedHost;
const writes: Array<Record<string, unknown>> = [];
let catalog: SoftwareReleaseCatalog;
const renderEditor = () => <QueryClientProvider client={new QueryClient()}><SoftwareChannelEditor host={host} stale={false} /></QueryClientProvider>;

describe('Software channels', () => {
  beforeEach(() => {
    writes.length = 0;
    catalog = {releases: [
      {version: 'v2.0.0-rc.1', releaseId: 2, url: 'https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/tag/v2.0.0-rc.1', publishedAt: '2024-03-01T12:00:00Z', prerelease: true, selectable: true},
      {version: 'v1.2.3', releaseId: 1, url: 'https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/tag/v1.2.3', publishedAt: '2024-02-29T12:00:00Z', prerelease: false, selectable: true},
      {version: 'v1.0.0', releaseId: 3, url: 'https://github.com/QualityMinds/AIppliance-Magic-Stick/releases/tag/v1.0.0', publishedAt: '2024-01-01T12:00:00Z', prerelease: false, selectable: false, reason: 'Legacy release has no verified manifest.'},
    ], fetchedAt: '2024-03-01T12:00:00Z', stale: false};
    host = {name: 'example-node', nodeUid: 'node-uid', bootId: 'boot-a', kernel: 'test', available: true, message: '',
      software: {supported: true, releaseCatalogVersion: 1, id: 'a'.repeat(64), channel: {kind: 'branch', value: 'main'}, hostCommit: 'b'.repeat(40)}};
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') writes.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(String(input).endsWith('/api/software/releases') ? catalog : {accepted: true}), {headers: {'content-type': 'application/json'}});
    }));
  });

  it('does not mutate on opening and only applies reviewed changes', async () => {
    host.software!.observed = {sourceRevision: 'sha1:' + 'b'.repeat(40), appliedRevision: 'sha1:' + 'b'.repeat(40),
      ready: true, checkedAtEpoch: Date.now() / 1000, images: []};
    render(renderEditor());
    expect(screen.getAllByText('b'.repeat(12))).toHaveLength(2);
    expect(screen.getByLabelText('Software channel')).toHaveValue('main');
    expect(screen.getByRole('button', {name: 'Apply channel'})).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Software channel'), 'release');
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

  it('lists published versions, hides prereleases by default and never auto-selects a version', async () => {
    render(renderEditor());
    await userEvent.selectOptions(screen.getByLabelText('Software channel'), 'release');
    expect(await screen.findByRole('option', {name: 'v1.2.3'})).toBeEnabled();
    expect(screen.getByRole('option', {name: 'v1.0.0 · not verified'})).toBeDisabled();
    expect(screen.queryByRole('option', {name: 'v2.0.0-rc.1 · prerelease'})).not.toBeInTheDocument();
    expect(screen.getByLabelText('Version')).toHaveValue('');
    expect(screen.getByRole('button', {name: 'Check channel'})).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Show prereleases'));
    await userEvent.selectOptions(screen.getByLabelText('Version'), 'v2.0.0-rc.1');
    await userEvent.click(screen.getByRole('button', {name: 'Check channel'}));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({action: 'check-software-channel', softwareChannel: {kind: 'tag', value: 'v2.0.0-rc.1'}});
    expect(screen.getByRole('link', {name: 'Release notes'})).toHaveAttribute('href', catalog.releases[0]!.url);
  });

  it('applies a reviewed release, displays its immutable license dates and requires no product license', async () => {
    host.software!.preview = {id: 'c'.repeat(64), configurationId: 'a'.repeat(64), channel: {kind: 'tag', value: 'v1.2.3'},
      commit: 'd'.repeat(40), ready: true, checkedAtEpoch: Date.now() / 1000, images: [],
      release: {version: 'v1.2.3', commit: 'd'.repeat(40), tagObject: 'e'.repeat(40), releaseId: 1, manifestDigest: 'sha256:' + 'f'.repeat(64), prerelease: false,
        license: {schemaVersion: 1, version: 'v1.2.3', firstPublicDistribution: '2024-02-29', changeDate: '2027-02-28', changeLicense: 'MIT'}}};
    render(renderEditor());
    await userEvent.selectOptions(screen.getByLabelText('Software channel'), 'release');
    await userEvent.selectOptions(await screen.findByLabelText('Version'), 'v1.2.3');
    expect(await screen.findByText(/first public distribution 2024-02-29/)).toHaveTextContent('MIT from 2027-02-28');
    expect(screen.getByText(/does not grant a commercial entitlement/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', {name: 'Apply channel'}));
    const dialog = screen.getByRole('dialog', {name: 'Change software channel'});
    expect(dialog).toHaveTextContent('This revision remains fixed.');
    await userEvent.type(within(dialog).getByLabelText('Type example-node to confirm'), 'example-node');
    await userEvent.click(within(dialog).getByRole('button', {name: 'Apply channel'}));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({softwareChannel: {kind: 'tag', value: 'v1.2.3'}, softwarePreviewId: 'c'.repeat(64)});
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/api/license'))).toBe(false);
  });

  it('keeps a selected release while status polls and does not apply an unchanged installed version', async () => {
    host.software!.channel = {kind: 'tag', value: 'v1.2.3'};
    host.software!.preview = {id: 'c'.repeat(64), configurationId: 'a'.repeat(64), channel: host.software!.channel,
      commit: host.software!.hostCommit!, ready: true, checkedAtEpoch: Date.now() / 1000, images: []};
    const view = render(renderEditor());
    expect(await screen.findByRole('option', {name: 'v1.2.3'})).toBeInTheDocument();
    expect(screen.getByLabelText('Software channel')).toHaveValue('release');
    expect(screen.getByLabelText('Version')).toHaveValue('v1.2.3');
    view.rerender(renderEditor());
    expect(screen.getByLabelText('Version')).toHaveValue('v1.2.3');
    expect(screen.getByRole('button', {name: 'Apply channel'})).toBeDisabled();
    expect(writes).toEqual([]);
  });

  it('shows offline and empty catalogs honestly without falling back to main', async () => {
    catalog = {releases: [], fetchedAt: '', stale: true, message: 'Public catalog unavailable.'};
    render(renderEditor());
    await userEvent.selectOptions(screen.getByLabelText('Software channel'), 'release');
    expect(await screen.findByRole('alert')).toHaveTextContent('Public catalog unavailable.');
    expect(screen.getByLabelText('Version')).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Check channel'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Apply channel'})).toBeDisabled();
    expect(screen.getByLabelText('Software channel')).toHaveValue('release');
    expect(writes).toEqual([]);
  });

  it('keeps older workers usable for explicit development refs but disables release selection', async () => {
    delete host.software!.releaseCatalogVersion;
    render(renderEditor());
    await userEvent.selectOptions(screen.getByLabelText('Software channel'), 'release');
    expect(await screen.findByText(/requires the current release-aware host worker/)).toBeInTheDocument();
    expect(screen.getByLabelText('Version')).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Check channel'})).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Software channel'), 'branch');
    await userEvent.type(screen.getByLabelText('Branch name'), 'feature/reviewed');
    expect(screen.getByRole('button', {name: 'Check channel'})).toBeEnabled();
    expect(writes).toEqual([]);
  });

  it('does not auto-select main when only prereleases exist and refreshing never writes', async () => {
    catalog.releases = catalog.releases.filter(item => item.prerelease);
    render(renderEditor());
    await userEvent.selectOptions(screen.getByLabelText('Software channel'), 'release');
    expect(await screen.findByText(/No verified stable versions/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', {name: 'Refresh versions'}));
    expect(screen.getByLabelText('Version')).toHaveValue('');
    expect(screen.getByLabelText('Software channel')).toHaveValue('release');
    expect(writes).toEqual([]);
  });
});
