import {useEffect, useMemo, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {canAdminister} from '@magicstick/dashboard-core';
import type {Session} from '@magicstick/dashboard-contracts';
import {api} from './api';
import {ErrorNotice, Loading, StatusBadge} from './components';
import {OverviewPage} from './pages/OverviewPage';
import {ServicesPage} from './pages/ServicesPage';
import {ModelsPage} from './pages/ModelsPage';
import {UsersPage} from './pages/UsersPage';
import {ApiAccessPage} from './pages/ApiAccessPage';
import {KubernetesAccessPage} from './pages/KubernetesAccessPage';
import {SettingsPage} from './pages/SettingsPage';
import {SystemPage} from './pages/SystemPage';

type TabId = 'overview' | 'services' | 'models' | 'users' | 'api-access' | 'kubernetes-access' | 'settings' | 'system';

const tabs: Array<{id: TabId; label: string; admin?: boolean; identity?: boolean}> = [
  {id: 'overview', label: 'Overview'},
  {id: 'services', label: 'Services'},
  {id: 'models', label: 'Models'},
  {id: 'settings', label: 'Settings', admin: true},
  {id: 'users', label: 'Users', admin: true, identity: true},
  {id: 'api-access', label: 'API Access', admin: true},
  {id: 'kubernetes-access', label: 'Kubernetes Access', admin: true, identity: true},
  {id: 'system', label: 'System Status'},
];

const initialTab = (): TabId => {
  const value = window.location.hash.replace(/^#\/?/, '') as TabId;
  return tabs.some((tab) => tab.id === value) ? value : 'overview';
};

const legacyDashboardUrl = () => {
  const host = window.location.hostname.replace(/^(?:dashboard2|dashboard-next|next)\./, '');
  const port = window.location.port ? `:${window.location.port}` : '';
  return `${window.location.protocol}//${host}${port}/`;
};

const ActivePage = ({tab, session}: {tab: TabId; session: Session}) => {
  switch (tab) {
    case 'services': return <ServicesPage session={session} />;
    case 'models': return <ModelsPage session={session} />;
    case 'users': return <UsersPage />;
    case 'api-access': return <ApiAccessPage />;
    case 'kubernetes-access': return <KubernetesAccessPage />;
    case 'settings': return <SettingsPage />;
    case 'system': return <SystemPage />;
    default: return <OverviewPage />;
  }
};

export const App = () => {
  const [tab, setTab] = useState<TabId>(initialTab);
  const session = useQuery({queryKey: ['session'], queryFn: () => api.session(), refetchInterval: 60_000});
  const allowedTabs = useMemo(
    () => tabs.filter((item) => (!item.admin || (session.data && canAdminister(session.data))) && (!item.identity || session.data?.identityManagementAvailable !== false)),
    [session.data],
  );

  useEffect(() => {
    if (session.data && !allowedTabs.some((item) => item.id === tab)) setTab('overview');
  }, [allowedTabs, session.data, tab]);

  useEffect(() => {
    const followHash = () => setTab(initialTab());
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, []);

  useEffect(() => {
    window.history.replaceState(null, '', `#/${tab}`);
  }, [tab]);

  if (session.isPending) return <main className="boot"><Loading /></main>;
  if (session.error || !session.data) return <main className="boot"><ErrorNotice error={session.error ?? new Error('Session is unavailable.')} /></main>;

  return (
    <main className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Magic Stick · React Preview</p>
          <h1>AI Appliance Dashboard 2</h1>
          <p className="subtitle">The next dashboard uses the existing, role-protected appliance API.</p>
        </div>
        <div className="hero-side">
          <StatusBadge phase="Connected" />
          <span className="muted">Signed in: {session.data.username}</span>
          <a className="button button-ghost" href={legacyDashboardUrl()}>Open current dashboard</a>
          <a className="button button-ghost" href="/logout">Log out</a>
        </div>
      </header>

      <section className="workspace">
        <nav className="tabs" aria-label="Dashboard pages">
          {allowedTabs.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? 'tab active' : 'tab'}
              type="button"
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="content"><ActivePage tab={tab} session={session.data} /></div>
      </section>

      <footer>Dashboard 2 preview · Same control plane, separate frontend.</footer>
    </main>
  );
};
