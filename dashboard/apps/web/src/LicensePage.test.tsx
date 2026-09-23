import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {LicensePage} from './pages/LicensePage';
import {api} from './api';
import type {LicenseStatus, LicenseVerification} from '@magicstick/dashboard-contracts';

const status: LicenseStatus = {
  edition: 'free', state: 'missing', message: 'Free mode.', valid: false, installationId: 'test-installation',
  revision: '1', checkedAt: 1, hasDocument: false, trustedKeyIds: ['test'],
  features: [{id: 'federated-sso', name: 'Federated SSO', licensed: false, implemented: false, available: false, reason: 'unlicensed'}],
};
const candidate: LicenseVerification = {state: 'valid', valid: true, message: 'Verified offline.', keyId: 'test', claims: {
  edition: 'free-registered', version: 1, product: 'magicstick', issuer: 'magicstick', licenseId: 'example', customer: 'Example',
  issuedAt: 1, notBefore: 1, expiresAt: 253402300799, features: ['federated-sso'],
}};
const mount = () => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}><LicensePage /></QueryClientProvider>);
const upload = async (user: ReturnType<typeof userEvent.setup>) => {
  const file = new File(['opaque-signed-license'], 'license.json', {type: 'application/json'});
  Object.defineProperty(file, 'text', {value: async () => 'opaque-signed-license'});
  await user.upload(await screen.findByLabelText('License file'), file);
  await screen.findByText('Selected: license.json');
};

describe('license management', () => {
  beforeEach(() => {
    vi.spyOn(api, 'licenseStatus').mockResolvedValue(status);
    vi.spyOn(api, 'inspectLicense').mockResolvedValue({candidate, current: status});
    vi.spyOn(api, 'importLicense').mockResolvedValue({...status, ...candidate, hasDocument: true, revision: '2'});
    vi.spyOn(api, 'createLicenseRequest').mockResolvedValue({filename: 'magicstick-license-request-example.json', content: '{"unsigned":true}\n'});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('downloads only selected modules with the requested TTL without activating a license', async () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:license-request');
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    });
    const downloads: Array<{filename: string; href: string}> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({filename: this.download, href: this.href});
    });
    const user = userEvent.setup(); mount();
    expect(await screen.findByRole('button', {name: 'Download JSON for signing'})).toBeDisabled();
    await user.type(screen.getByLabelText('Customer reference'), 'Example organization');
    await user.clear(screen.getByLabelText('Validity (TTL)'));
    await user.type(screen.getByLabelText('Validity (TTL)'), '48');
    await user.selectOptions(screen.getByLabelText('TTL unit'), 'hours');
    await user.click(screen.getByRole('button', {name: 'Download JSON for signing'}));
    await screen.findByText('Unsigned request downloaded. Send it to your license provider for signing.');
    expect(api.createLicenseRequest).toHaveBeenCalledWith({customer: 'Example organization', edition: 'free-registered', features: ['federated-sso'], ttlSeconds: 48 * 3600});
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(createObjectURL.mock.calls[0]![0].type).toBe('application/json');
    expect(downloads).toEqual([{filename: 'magicstick-license-request-example.json', href: 'blob:license-request'}]);
    expect(api.importLicense).not.toHaveBeenCalled();
    expect(api.inspectLicense).not.toHaveBeenCalled();
  });

  it('requires a customer, module and positive whole TTL before requesting JSON', async () => {
    const user = userEvent.setup(); mount();
    const download = await screen.findByRole('button', {name: 'Download JSON for signing'});
    await user.type(screen.getByLabelText('Customer reference'), 'Example');
    expect(download).toBeEnabled();
    for (const value of ['0', '-1', '1.5', '99999999999999999999']) {
      await user.clear(screen.getByLabelText('Validity (TTL)'));
      await user.type(screen.getByLabelText('Validity (TTL)'), value);
      expect(download).toBeDisabled();
    }
    await user.clear(screen.getByLabelText('Validity (TTL)'));
    expect(download).toBeDisabled();
    expect(api.createLicenseRequest).not.toHaveBeenCalled();
  });

  it('preserves the request draft during status refresh and reports download errors', async () => {
    vi.mocked(api.createLicenseRequest).mockRejectedValue(new Error('License storage is unavailable.'));
    const cache = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
    const user = userEvent.setup();
    render(<QueryClientProvider client={cache}><LicensePage /></QueryClientProvider>);
    await user.type(await screen.findByLabelText('Customer reference'), 'Example');
    act(() => cache.setQueryData(['license'], {...status, ...candidate, checkedAt: 2}));
    expect(screen.getByLabelText('Customer reference')).toHaveValue('Example');
    expect(screen.getByLabelText('Requested edition')).toHaveValue('free-registered');
    await user.click(screen.getByRole('button', {name: 'Download JSON for signing'}));
    await screen.findByRole('alert');
    expect(screen.getByText('License storage is unavailable.')).toBeInTheDocument();
    expect(api.createLicenseRequest).toHaveBeenCalledWith({customer: 'Example', edition: 'free-registered', features: ['federated-sso'], ttlSeconds: 30 * 86400});
    expect(api.importLicense).not.toHaveBeenCalled();
  });

  it('bundles scoped license texts for offline inspection and exact download', async () => {
    mount();
    await screen.findByRole('heading', {name: 'Software licenses'});
    const link = screen.getByRole('link', {name: 'Download Business Source License 1.1', hidden: true});
    expect(link).toHaveAttribute('download', 'MagicStick-BSL.txt');
    const text = decodeURIComponent(link.getAttribute('href')!.split(',', 2)[1]!);
    expect(text).toContain('Business Source License 1.1');
    expect(text).toContain('EUR 2,000,000');
    expect(await screen.findByRole('heading', {name: 'Free Registered'})).toBeInTheDocument();
  });

  it('keeps software notices readable when entitlement status is unavailable', async () => {
    vi.mocked(api.licenseStatus).mockRejectedValue(new Error('License API unavailable.'));
    mount();
    // Avoid formatting all bundled notices on every retry before the rejection renders.
    await waitFor(() => expect(screen.queryByRole('alert')).toHaveTextContent('License API unavailable.'));
    expect(screen.getByRole('heading', {name: 'Software licenses'})).toBeInTheDocument();
    expect(screen.getByRole('link', {name: 'Download Business Source License 1.1', hidden: true})).toHaveAttribute('download', 'MagicStick-BSL.txt');
  });

  it('requires preview and explicit activation, preserving the reviewed revision', async () => {
    const user = userEvent.setup(); mount();
    await upload(user);
    expect(api.importLicense).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', {name: 'Validate license'}));
    await user.click(await screen.findByRole('button', {name: 'Activate license'}));
    expect(api.importLicense).toHaveBeenCalledWith('opaque-signed-license', '1');
    await screen.findByText('License saved. Installed capabilities with a valid entitlement are now available.');
    expect(screen.getByLabelText('License file')).toHaveValue('');
    expect(screen.getByText('Not implemented')).toBeInTheDocument();
  });

  it('does not activate an invalid candidate', async () => {
    vi.mocked(api.inspectLicense).mockResolvedValue({current: status, candidate: {state: 'invalid_signature', valid: false, message: 'Invalid signature.'}});
    const user = userEvent.setup(); mount(); await upload(user);
    await user.click(screen.getByRole('button', {name: 'Validate license'}));
    expect(await screen.findByRole('button', {name: 'Activate license'})).toBeDisabled();
    expect(api.importLicense).not.toHaveBeenCalled();
  });

  it('discards a preview after a conflict and requires a fresh validation', async () => {
    vi.mocked(api.importLicense).mockRejectedValue(new Error('License changed concurrently.'));
    const user = userEvent.setup(); mount(); await upload(user);
    await user.click(screen.getByRole('button', {name: 'Validate license'}));
    await user.click(await screen.findByRole('button', {name: 'Activate license'}));
    await screen.findByText('License changed concurrently.');
    await waitFor(() => expect(screen.queryByRole('button', {name: 'Activate license'})).not.toBeInTheDocument());
  });

  it('rejects oversized files without a request', async () => {
    const user = userEvent.setup(); mount();
    await user.upload(await screen.findByLabelText('License file'), new File(['x'.repeat(65537)], 'large.json', {type: 'application/json'}));
    await screen.findByText('License file exceeds 64 KiB.');
    expect(api.inspectLicense).not.toHaveBeenCalled();
  });

  it('explains missing installation keys without asking customers to upload them', async () => {
    vi.mocked(api.licenseStatus).mockResolvedValue({...status, trustedKeyIds: []});
    mount();
    await screen.findByText(/License verification keys are unavailable/);
    expect(screen.getByText(/Verification keys are supplied with the installation/)).toBeInTheDocument();
    expect(screen.queryByText(/Install the issuer’s public trust store/)).not.toBeInTheDocument();
  });
});
