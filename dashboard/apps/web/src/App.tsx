import {useEffect, useMemo, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {canAdminister} from '@magicstick/dashboard-core';
import type {Session} from '@magicstick/dashboard-contracts';
import {api} from './api';
import {ErrorNotice, Loading, StatusBadge} from './components';
import {OverviewPage} from './pages/OverviewPage';
import {ServicesPage} from './pages/ServicesPage';
import {ModelsPage} from './pages/ModelsPage';
import {ApiAccessPage} from './pages/ApiAccessPage';
import {KubernetesAccessPage} from './pages/KubernetesAccessPage';
import {MyInstancesPage} from './pages/MyInstancesPage';
import {allowedSystemSections, SystemAreaPage, type SystemSectionId} from './pages/SystemAreaPage';

type TabId = 'overview' | 'services' | 'models' | 'api-access' | 'kubernetes-access' | 'system';
type DashboardRoute = {tab: TabId; systemSection: SystemSectionId};

const tabs: Array<{id: TabId; label: string; admin?: boolean; identity?: boolean}> = [
  {id: 'overview', label: 'Overview'},
  {id: 'services', label: 'Services'},
  {id: 'models', label: 'Models'},
  {id: 'api-access', label: 'API Access', admin: true},
  {id: 'kubernetes-access', label: 'Kubernetes Access', admin: true, identity: true},
  {id: 'system', label: 'System'},
];

const initialRoute = (): DashboardRoute => {
  const value = window.location.hash.replace(/^#\/?/, '').replace(/\/$/, '');
  const [tab, section] = value.split('/');
  if (tab === 'settings' || tab === 'license' || tab === 'users') return {tab: 'system', systemSection: tab};
  if (tab === 'federated-sso') return {tab: 'system', systemSection: 'federated-sso'};
  if (tab === 'system') {
    const systemSection = section && (['settings', 'license', 'users', 'federated-sso', 'hardware', 'network', 'status', 'power'] as string[]).includes(section) ? section as SystemSectionId : 'status';
    return {tab: 'system', systemSection};
  }
  return {tab: tabs.some((item) => item.id === tab) ? tab as TabId : 'overview', systemSection: 'status'};
};

const ActivePage = ({route, session, onSystemSectionChange}: {
  route: DashboardRoute;
  session: Session;
  onSystemSectionChange: (section: SystemSectionId) => void;
}) => {
  const {tab} = route;
  switch (tab) {
    case 'services': return <ServicesPage session={session} />;
    case 'models': return <ModelsPage session={session} />;
    case 'api-access': return <ApiAccessPage />;
    case 'kubernetes-access': return <KubernetesAccessPage />;
    case 'system': return <SystemAreaPage session={session} section={route.systemSection} onSectionChange={onSystemSectionChange} />;
    default: return <OverviewPage />;
  }
};

export const App = () => {
  const [route, setRoute] = useState<DashboardRoute>(initialRoute);
  const session = useQuery({queryKey: ['session'], queryFn: () => api.session(), refetchInterval: 60_000});
  const allowedTabs = useMemo(
    () => tabs.filter((item) => (!item.admin || (session.data && canAdminister(session.data))) && (!item.identity || session.data?.identityManagementAvailable !== false)),
    [session.data],
  );
  const allowedSections = useMemo(() => session.data ? allowedSystemSections(session.data) : [], [session.data]);
  const activeRoute: DashboardRoute = {
    tab: !session.data || allowedTabs.some((item) => item.id === route.tab) ? route.tab : 'overview',
    systemSection: !session.data || allowedSections.some((item) => item.id === route.systemSection) ? route.systemSection : 'status',
  };

  useEffect(() => {
    if (session.data && (activeRoute.tab !== route.tab || activeRoute.systemSection !== route.systemSection)) setRoute(activeRoute);
  }, [activeRoute.tab, activeRoute.systemSection, route.systemSection, route.tab, session.data]);

  useEffect(() => {
    const followHash = () => setRoute(initialRoute());
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, []);

  useEffect(() => {
    const path = activeRoute.tab === 'system' ? `system/${activeRoute.systemSection}` : activeRoute.tab;
    window.history.replaceState(null, '', `#/${path}`);
  }, [activeRoute.systemSection, activeRoute.tab]);

  if (session.isPending) return <main className="boot"><Loading /></main>;
  if (session.error || !session.data) return <main className="boot"><ErrorNotice error={session.error ?? new Error('Session is unavailable.')} /></main>;
  if (!session.data.roles.some((role) => ['magicstick-viewer', 'magicstick-operator', 'magicstick-admin'].includes(role))) {
    return <main className="page"><header className="hero"><div><p className="eyebrow">Magic Stick</p><h1>My applications</h1><p>Signed in: {session.data.username}</p></div><a className="button button-ghost" href="/logout">Log out</a></header><section className="workspace"><MyInstancesPage /></section></main>;
  }

  return (
    <main className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Magic Stick</p>
          <h1>AI Appliance Dashboard</h1>
        </div>
        <div className="hero-side">
          <StatusBadge phase="Connected" />
          <span className="muted">Signed in: {session.data.username}</span>
          <a className="button button-ghost" href="/logout">Log out</a>
        </div>
      </header>

      <section className="workspace">
        <nav className="tabs" aria-label="Dashboard pages">
          {allowedTabs.map((item) => (
            <button
              key={item.id}
              className={activeRoute.tab === item.id ? 'tab active' : 'tab'}
              type="button"
              aria-current={activeRoute.tab === item.id ? 'page' : undefined}
              onClick={() => setRoute((current) => ({...current, tab: item.id}))}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="content"><ActivePage route={activeRoute} session={session.data} onSystemSectionChange={(systemSection) => setRoute({tab: 'system', systemSection})} /></div>
      </section>

      <footer>Magic Stick · Your AI infrastructure.</footer>
    </main>
  );
};
