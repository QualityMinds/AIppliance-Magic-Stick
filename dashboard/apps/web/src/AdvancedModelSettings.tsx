import {CpuSettings, type CpuSettingsState} from './CpuSettings';
import {VllmDeploymentSettings, type VllmDeploymentSettingsState} from './VllmDeploymentSettings';

export const AdvancedModelSettings = ({cpuSettings, deploymentSettings}: {
  cpuSettings: CpuSettingsState;
  deploymentSettings?: VllmDeploymentSettingsState;
}) => <details className="nested-panel stack compact">
  <summary><strong>Advanced</strong></summary>
  <CpuSettings settings={cpuSettings} />
  {deploymentSettings && <VllmDeploymentSettings settings={deploymentSettings} />}
</details>;
