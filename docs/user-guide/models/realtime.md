# Realtime with vLLM-Omni

## Use from the dashboard

1. Open **Models → Create → Location: Local → Inference Engine: vLLM-Omni**.
2. Select NVIDIA CUDA, AMD ROCm, Intel XPU or CPU and a compute node.
   GPU selection uses actual Kubernetes resources or the configured AMD DRA
   claim, not a chip/driver/Strix-Halo whitelist. A free slot is not proof of
   successful execution. CPU does not reserve a GPU.
3. Choose **Hugging Face search** or **Direct reference**. Direct input accepts
   `hf://organization/model`, `organization/model` or an HTTPS Hub repository URL.
   Any syntactically valid repository can be tried, including AWQ/FP8, other
   architectures and partial checkpoints. Search results are not disabled by
   Magic Stick's model compatibility guesses.
4. **Advanced Settings** provides context, concurrency, memory and an optional
   **Runtime image** override. CPU and XPU require a user-supplied compatible
   vLLM-Omni image; they are experimental targets, not validated audio backends.
   The image must implement the existing Omni CLI and Qwen duplex deploy config.
   A CUDA image cannot run AMD/Intel/CPU merely because its name is editable.
5. Add the model; inspect **Status** and **Logs**. Installed controls include
   Edit, Stop, Start, Restart and Remove. Once Ready, test through the existing
   **LiteLLM → Playground → Realtime** interface.

Ordinary vLLM, Ollama and FreeToken policies are unchanged. In particular,
selecting Omni does not opt another engine into untested hardware.

## Experimentation boundary

Magic Stick no longer blocks Realtime models based on quantization, architecture,
model type, completeness of thinker/talker/codec configs, audio-output metadata,
GGUF/MLX metadata or an online `config.json` check. Creation, edit and restart do
not contact the Hub for model approval, and the managed bootstrap does not
download or validate a model-policy file. The actual runtime still validates
its model and parameters when loading. Its errors appear in the existing logs
and status. Removing an allowlist does not implement missing upstream support.

There are no Omni-specific minimum driver/compute-generation, host inventory,
GPU architecture or Strix Halo profile gates. NVIDIA resources exposed as
`nvidia.com/gpu` (including single-strategy MIG allocations) can be tried.
Mixed-strategy MIG resource names are not remapped to whole GPUs. AMD uses
`amd.com/gpu` or the existing ready shared DRA claim; Intel uses
`gpu.intel.com/xe` or `gpu.intel.com/i915`.

Necessary checks remain: Linux/Ready/schedulable node, valid references and
numeric input, real device resource assignment, available slots, node/claim
identity, system RAM not above node allocatable RAM, and existing
authentication/authorization/CSRF/revision protections. GPU memory fraction
must be greater than zero and at most one. Context/concurrency must be positive
32-bit integers rather than being limited to 32768 tokens/eight sessions.
Offload/shared-memory RAM estimates are advisory, not model admission gates.
RAM underbudgeting and conflicting shared GPU budgets can cause OOM.
