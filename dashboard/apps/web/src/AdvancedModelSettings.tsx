import type {ReactNode} from 'react';
import {CpuSettings, type CpuSettingsState} from './CpuSettings';
import {VllmDeploymentSettings, type VllmDeploymentSettingsState} from './VllmDeploymentSettings';

export const AdvancedModelSettings = ({cpuSettings, deploymentSettings, children}: {
  cpuSettings: CpuSettingsState;
  deploymentSettings?: VllmDeploymentSettingsState;
  children?: ReactNode;
}) => <details className="nested-panel stack compact">
  <summary><strong>Advanced</strong></summary>
  <CpuSettings settings={cpuSettings} />
  {deploymentSettings && <VllmDeploymentSettings settings={deploymentSettings} />}
  {children}
</details>;
