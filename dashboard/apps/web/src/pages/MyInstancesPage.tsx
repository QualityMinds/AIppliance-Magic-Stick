import {useQuery} from '@tanstack/react-query';
import {api} from '../api';
import {Empty, ErrorNotice, Loading, Panel, ResourceLinks, StatusBadge} from '../components';

export const MyInstancesPage = () => {
  const query = useQuery({queryKey: ['my-instances'], queryFn: () => api.myInstances(), refetchInterval: 15_000});
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} />;
  return <div className="stack"><h2>My instances</h2><p>Applications available to your account.</p>
    {query.data?.items.map((item) => <Panel key={item.name} title={item.name} meta={item.application} actions={<StatusBadge phase={item.phase} />}>
      <ResourceLinks links={item.urls.flatMap((url) => {try {
        const parsed = new URL(url);
        return ['https:', 'http:'].includes(parsed.protocol) ? [{url, label: parsed.host, scope: 'direct' as const}] : [];
      } catch {return [];}})} />
    </Panel>)}
    {!query.data?.items.length && <Empty>No instances are currently available to your account.</Empty>}
  </div>;
};
