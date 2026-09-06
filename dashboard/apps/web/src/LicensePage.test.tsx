import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {LicensePage} from './pages/LicensePage';
import {api} from './api';
import type {LicenseStatus, LicenseVerification} from '@magicstick/dashboard-contracts';

const status: LicenseStatus = {
  state: 'missing', message: 'Community mode.', valid: false, installationId: 'test-installation',
  revision: '1', checkedAt: 1, hasDocument: false, trustedKeyIds: ['test'],
  features: [{id: 'multi-gpu', name: 'Multi-GPU', licensed: false, implemented: false, available: false, reason: 'unlicensed'}],
};
const candidate: LicenseVerification = {state: 'valid', valid: true, message: 'Verified offline.', keyId: 'test', claims: {
  version: 1, product: 'magicstick', issuer: 'magicstick', licenseId: 'example', customer: 'Example',
  issuedAt: 1, notBefore: 1, expiresAt: 253402300799, features: ['multi-gpu'],
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
  });

  it('bundles scoped license texts for offline inspection and exact download', async () => {
    mount();
    await screen.findByRole('heading', {name: 'Software licenses'});
    const link = screen.getByRole('link', {name: 'Download Enterprise · Provisional notice', hidden: true});
    expect(link).toHaveAttribute('download', 'MagicStick-Enterprise.txt');
    const text = decodeURIComponent(link.getAttribute('href')!.split(',', 2)[1]!);
    expect(text).toContain('LicenseRef-MagicStick-Enterprise');
    expect(text).toContain('not a complete customer license');
    expect(screen.getByText(/not a commercial agreement/)).toBeInTheDocument();
  });

  it('keeps software notices readable when entitlement status is unavailable', async () => {
    vi.mocked(api.licenseStatus).mockRejectedValue(new Error('License API unavailable.'));
    mount();
    await screen.findByText('License API unavailable.');
    expect(screen.getByRole('heading', {name: 'Software licenses'})).toBeInTheDocument();
    expect(screen.getByRole('link', {name: 'Download Community · MIT License', hidden: true})).toHaveAttribute('download', 'MagicStick-MIT.txt');
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
});
