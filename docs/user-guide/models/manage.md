# Manage deployed models

## Before you start

Open **Models** with Operator or Administrator access. Check whether applications
or mesh consumers are using a model before interrupting it. Catalog-only models
without a Magic Stick activation can be read-only.

| Action | What happens |
|---|---|
| Edit | Opens the saved configuration. Review and save supported changes; runtime-affecting changes can reload the model. |
| Stop | Retains the model definition but disables it. Local runtime resources are removed and routes withdrawn. |
| Start | Recreates the runtime from its saved settings and republishes the route only when ready. |
| Restart | Where offered, restarts the existing engine runtime without creating a second model definition. |
| Logs | Shows bounded logs from the selected activation's local Pods/containers, including startup failures. |
| Remove | Deletes the model activation and its managed runtime. This is not the same as clearing downloaded caches. |

The common **Start/Stop** workflow covers Ollama, vLLM, FreeToken, Realtime and
external activations. For external models it changes local routing only.
Restart controls depend on the engine; Stop followed by Start is the common
reload workflow when no separate Restart action is offered.

## Check the result

Stop passes through removal while Pods and GPU allocations terminate. Memory and
slots may not become free immediately. Start can download weights again, especially
for temporary FreeToken caches. **Ready** means routable; test an inference request
before returning the model to users.

If another administrator changed the model while you were editing, refresh the
configuration instead of overwriting a stale revision. Changing engine-specific
settings must not silently carry incompatible fields to another engine.

For failures, read [model diagnostics](../../administration/troubleshooting/models.md).
For disk cleanup, use [model cache management](../../administration/model-cache.md),
not manual deletion of running Pods or files.
