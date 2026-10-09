# Retired inference engines

## FreeToken removal

Removed on 9 October 2026.

The experimental FreeToken engine has been removed. It is no longer offered in
**Models** or **Services**. Its runtime image build/promotion workflows and active
regression cases have also been removed. Use [Ollama](../user-guide/models/ollama.md)
or [vLLM](../user-guide/models/vllm.md) for new local models.

Previously saved FreeToken definitions remain visible. They cannot be edited,
started, or restarted; the API rejects these operations and the controller does
not create replacement workloads. **Stop** and **Remove** still clean up their
old managed runtime. Until stopped, their saved reservations and existing Pods
continue to protect GPU capacity and shared model caches. Stopping the old Pod
also releases its temporary download cache.

Choose a supported engine and create a new definition to continue using a model.
Changing an engine does not guarantee the same artifact or quantization is
supported. Check the chosen runtime's model requirements.

Dated FreeToken reports and screenshots describe earlier versions only.
