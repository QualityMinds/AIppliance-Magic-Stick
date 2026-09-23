import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {FederatedSsoStatus} from '@magicstick/dashboard-contracts';
import {api} from './api';
import {FederatedSsoPage} from './pages/FederatedSsoPage';

const feature = {id: 'federated-sso', name: 'Dashboard-managed federated SSO', licensed: true, implemented: true, available: true, reason: 'available'};
const status: FederatedSsoStatus = {
  feature,
  issuer: 'https://id.magicstick.local/realms/magicstick',
  callbackUrl: 'https://id.magicstick.local/realms/magicstick/broker/{alias}/endpoint',
  providers: [{
    alias: 'company', displayName: 'Company Login', protocol: 'oidc',
    metadataUrl: 'https://login.example.com/.well-known/openid-configuration',
    clientId: 'magicstick', scopes: 'openid profile email', enabled: true,
    trustEmail: false, secretConfigured: true,
    mappings: [{source: 'groups', value: 'magicstick-users', accessLevel: 'user'}],
    revision: 'revision-1',
  }],
};

const mount = () => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}><FederatedSsoPage /></QueryClientProvider>);

describe('federated SSO administration', () => {
  beforeEach(() => {
    vi.spyOn(api, 'federatedSso').mockResolvedValue(status);
    vi.spyOn(api, 'validateFederation').mockResolvedValue({
      protocol: 'oidc', metadataUrl: 'https://accounts.example.com/.well-known/openid-configuration',
      configuration: {issuer: 'https://accounts.example.com', authorizationUrl: 'https://accounts.example.com/auth'},
    });
    vi.spyOn(api, 'createFederation').mockResolvedValue(status);
    vi.spyOn(api, 'updateFederation').mockResolvedValue(status);
    vi.spyOn(api, 'deleteFederation').mockResolvedValue({deleted: 'company'});
  });

  it('shows the stable issuer, sanitized provider status, and exact callback', async () => {
    mount();
    expect(await screen.findByRole('heading', {name: 'Federated SSO'})).toBeInTheDocument();
    expect(screen.getByText('https://id.magicstick.local/realms/magicstick')).toBeInTheDocument();
    expect(screen.getByText('https://id.magicstick.local/realms/magicstick/broker/company/endpoint')).toBeInTheDocument();
    expect(screen.getByText('Secret: configured')).toBeInTheDocument();
    expect(screen.queryByText(/private-client-secret/)).not.toBeInTheDocument();
  });

  it('requires metadata validation and an explicit mapping before creation', async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole('button', {name: 'Add provider'}));
    await user.type(screen.getByLabelText(/Alias/), 'partner');
    await user.type(screen.getByLabelText('Display name'), 'Partner Login');
    await user.type(screen.getByLabelText('Discovery URL'), 'https://accounts.example.com/.well-known/openid-configuration');
    await user.type(screen.getByLabelText('Client ID'), 'magicstick-partner');
    await user.type(screen.getByLabelText(/Client secret/), 'do-not-return-this-secret');
    await user.type(screen.getByLabelText('Exact value'), 'magicstick-partner-users');
    expect(screen.getByRole('button', {name: 'Save provider'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Validate metadata'}));
    await screen.findByText('https://accounts.example.com/auth');
    expect(api.validateFederation).toHaveBeenCalledWith({
      protocol: 'oidc',
      metadataUrl: 'https://accounts.example.com/.well-known/openid-configuration',
    });
    expect(screen.getByRole('button', {name: 'Save provider'})).toBeEnabled();
    await user.click(screen.getByRole('button', {name: 'Save provider'}));
    await waitFor(() => expect(api.createFederation).toHaveBeenCalled());
    const payload = vi.mocked(api.createFederation).mock.calls[0]![0];
    expect(payload).toMatchObject({alias: 'partner', clientSecret: 'do-not-return-this-secret', expectedRevision: 'new'});
    expect(payload.mappings).toEqual([{source: 'groups', value: 'magicstick-partner-users', accessLevel: 'user'}]);
  });

  it('keeps deletion available but blocks creation and editing without entitlement', async () => {
    vi.mocked(api.federatedSso).mockResolvedValue({...status, feature: {...feature, licensed: false, available: false, reason: 'unlicensed'}});
    mount();
    expect(await screen.findByRole('button', {name: 'Add provider'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Edit'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Delete'})).toBeEnabled();
    expect(screen.getByText(/Deletion remains available without a license/)).toBeInTheDocument();
  });

  it('keeps recovery controls visible when license verification is unavailable', async () => {
    vi.mocked(api.federatedSso).mockResolvedValue({
      ...status,
      feature: {...feature, licensed: false, available: false, reason: 'storage_unavailable'},
    });
    mount();
    expect(await screen.findByText(/License verification is currently unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Edit'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Delete'})).toBeEnabled();
  });
});
