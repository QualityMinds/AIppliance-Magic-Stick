# Modules, applications and models

## On-Demand Local Model Runtime

`kubeai` uses `activationPolicy: local-model` and is not part of a fresh
installation. Ordinary vLLM and Ollama models require KubeAI. FreeToken and
Realtime vLLM-Omni use operator-managed Deployments and Services instead. Accelerator targets resolve a
vendor capability: `nvidia-gpu` to `compute.gpu.nvidia`, `amd-gpu` to
`compute.gpu.amd`, and `intel-gpu` to `compute.gpu.intel`. A CPU activation
using ordinary vLLM/Ollama therefore installs KubeAI without installing a GPU driver. External
`ModelActivation` resources require only `litellm` and `model-catalog`. A model
dependency never creates a hardware-detected vendor operator on a node where
the corresponding GPU signal is absent.

These runtime and provider modules also expose normal **Enable** and **Disable** actions in the
dashboard. A manual action removes any automatic-activation marker and makes
the module user-managed. For backward compatibility, the operator can still
reconcile automatic markers on model activations created outside the dashboard.
After every local model has been removed, **Remove Local Inference Runtime**
deletes only model-created runtime activations. Manually managed activations
and vendor activations owned by hardware detection are preserved; deletion of
an unmarked legacy NVIDIA activation exists only for upgrade compatibility.
