import type {
  ApiAccessPayload,
  Appliance,
  InstancesPayload,
  KubernetesAccessPayload,
  ModelsPayload,
  ModulesPayload,
  Session,
  Settings,
  SystemStatusPayload,
  UsersPayload,
} from '@magicstick/dashboard-contracts';
import {canAdminister} from '@magicstick/dashboard-core';
import type {MagicStickApi} from '@magicstick/dashboard-api-client';

export interface DashboardSnapshot {
  session: Session;
  appliance: Appliance;
  modules: ModulesPayload;
  instances: InstancesPayload;
  models: ModelsPayload;
  settings?: Settings;
  status: SystemStatusPayload;
  users?: UsersPayload;
  apiAccess?: ApiAccessPayload;
  kubernetesAccess?: KubernetesAccessPayload;
  loadedAt: number;
}

export const loadSnapshot = async (api: MagicStickApi): Promise<DashboardSnapshot> => {
  const session = await api.session();
  const admin = canAdminister(session);
  const [appliance, modules, instances, models, status, settings, users, apiAccess, kubernetesAccess] = await Promise.all([
    api.appliance(), api.modules(), api.instances(), api.models(), api.status(),
    admin ? api.settings() : Promise.resolve(undefined),
    admin && session.identityManagementAvailable !== false ? api.users() : Promise.resolve(undefined),
    admin ? api.apiAccess() : Promise.resolve(undefined),
    admin && session.identityManagementAvailable !== false ? api.kubernetesAccess() : Promise.resolve(undefined),
  ]);
  return {session, appliance, modules, instances, models, status, settings, users, apiAccess, kubernetesAccess, loadedAt: Date.now()};
};
