# Status and error reference

Read the object's current reason and message together with its phase. A phase
alone does not identify the cause, and a stale screenshot is not live evidence.

| Signal | Meaning | Next check |
|---|---|---|
| Starting / not ready | Runtime reconciliation, download or initialization is incomplete | Model Logs and current Pod/events |
| WaitingForPod | No model Pod exists yet | Operator/KubeAI reconciliation and admission |
| ModelPodCreationStalled | The no-Pod grace period expired; reconciliation continues | Model ownership, scheduling and controller errors |
| WaitingForRuntime | A required approved runtime descriptor/image is not available | Runtime module and image promotion |
| GpuSharingBlocked | Sharing cannot admit/reconcile the requested allocation | GPU sharing state and claim/device-plugin status |
| Degraded | An actionable dependency/runtime error is reported | First error in the status and matching logs |
| Removing | Runtime cleanup is still progressing | Terminating Pods and GPU allocation release |
| Disabled | The saved activation is stopped | Start it when intended; do not delete it to resume |
| RealtimePermissionDenied | The operator cannot manage a required runtime object | Matching namespaced RBAC and controller release |
| ModelPodRecoveryExhausted | Bounded terminal-Pod recovery attempts were used | Original error and recovery history |

Host operations have a separate lifecycle. `Succeeded` for memory configuration
does not mean model validation passed; network `RolledBack` confirms restored
configuration, not every external connection. See [host management](../administration/host-management.md)
and [network recovery](../administration/network.md).

The [operator's status contract](../concepts/controllers.md#failure-and-status-behavior)
and [runtime CRDs](kubernetes-resources.md) contain further details.
