# Connect an external model provider

## Before you start

Obtain the provider's exact model ID, API endpoint and credentials. Confirm its
privacy, cost and model-use terms. Prompts sent to this model leave the appliance.
Local GPU and model-cache capacity do not size the remote provider.

## Connect

1. Open **Models → Create** and select an external model.
2. Enter a unique local model name, provider/model identifier and the required
   endpoint fields offered by the form.
3. Provide the API key privately. Existing Secret references and provider settings
   must belong to the deployment; never paste them into public examples.
4. Save, wait for catalog publication and send a small [API request](../api-access.md).

## Operate

Use **Edit** to change supported parameters, and **Stop/Start** to remove or restore
the local route. Stop does not shut down the provider's server or cancel its billing.
Remote provider logs are not Kubernetes Pod logs; inspect returned API errors and
the provider's own diagnostics.

See [external model fields](../../reference/external-models.md) for advanced configuration.
