import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {render,screen,act,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {SettingsPage} from './SettingsPage';
import {api} from '../api';

vi.mock('../api',()=>({api:{settings:vi.fn(),licenseStatus:vi.fn(),updateSettings:vi.fn()}}));
const saved={publicDomain:'fixture.example.com',mdnsDomain:'fixture.local',mdnsName:'fixture',dashboardHost:'fixture.example.com'};
function mount() {
  const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  render(<QueryClientProvider client={client}><SettingsPage session={{subject:'fixture-admin',username:'fixture-admin',roles:['magicstick-admin'],identityManagementAvailable:false,identityManagementMode:'keycloak'}}
    section="domains" onSectionChange={vi.fn()} /></QueryClientProvider>);
  return client;
}
beforeEach(()=>{vi.resetAllMocks();vi.mocked(api.settings).mockResolvedValue(saved);});
describe('Domain settings regression',()=>{
  it('disables unchanged reverted and invalid domain drafts without sending a write',async()=>{
    mount();const input=await screen.findByLabelText('Public Domain'),save=screen.getByRole('button',{name:'Save Domains'});
    await waitFor(()=>expect(input).toHaveValue(saved.publicDomain));expect(save).toBeDisabled();
    await userEvent.clear(input);await userEvent.type(input,'changed.example.com');expect(save).toBeEnabled();
    await userEvent.clear(input);await userEvent.type(input,saved.publicDomain);expect(save).toBeDisabled();
    await userEvent.clear(input);await userEvent.type(input,'https://wrong.example.com/path');expect(save).toBeDisabled();
    expect(api.updateSettings).not.toHaveBeenCalled();
  });
  it('a refetch keeps an edited draft but updates a pristine form',async()=>{
    const client=mount(),input=await screen.findByLabelText('Public Domain');
    await waitFor(()=>expect(input).toHaveValue(saved.publicDomain));
    await userEvent.clear(input);await userEvent.type(input,'draft.example.com');
    vi.mocked(api.settings).mockResolvedValue({...saved,publicDomain:'external.example.com'});
    await act(async()=>{await client.refetchQueries({queryKey:['settings']});});
    expect(input).toHaveValue('draft.example.com');expect(screen.getByRole('button',{name:'Save Domains'})).toBeEnabled();
    await userEvent.clear(input);await userEvent.type(input,'external.example.com');
    expect(screen.getByRole('button',{name:'Save Domains'})).toBeDisabled();
    vi.mocked(api.settings).mockResolvedValue({...saved,publicDomain:'fresh.example.com'});
    await act(async()=>{await client.refetchQueries({queryKey:['settings']});});
    await waitFor(()=>expect(input).toHaveValue('fresh.example.com'));
    expect(screen.getByRole('button',{name:'Save Domains'})).toBeDisabled();
  });
});
