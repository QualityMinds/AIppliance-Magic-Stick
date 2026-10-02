# Landing page hosting

Bicep template for the Azure Static Web App that serves the public landing page
and handbook. The site content is built and uploaded by
[`.github/workflows/azure-static-web-apps.yml`](../../.github/workflows/azure-static-web-apps.yml);
this template only manages the hosting resource.

| File | Purpose |
|---|---|
| `staticwebapp.bicep` | Static Web App resource (resource-group scope) |
| `staticwebapp.bicepparam` | Public default parameter values |

The subscription and resource group are deployment targets, not template
content. Pass them at deployment time and do not commit subscription IDs,
tenant IDs or deployment tokens.

## Deploy

```sh
az login
az account set --subscription "<subscription-name-or-id>"

# Preview the changes first, especially when adopting the existing resource.
az deployment group what-if \
  --resource-group "<resource-group>" \
  --template-file infrastructure/landingpage/staticwebapp.bicep \
  --parameters infrastructure/landingpage/staticwebapp.bicepparam

az deployment group create \
  --resource-group "<resource-group>" \
  --template-file infrastructure/landingpage/staticwebapp.bicep \
  --parameters infrastructure/landingpage/staticwebapp.bicepparam
```

Deploying into the resource group that already holds `magic-stick-landingpage`
adopts that resource in place. Deployments run in incremental mode, so resources
not listed in the template are left untouched.

## Deployment token

The GitHub workflow authenticates with the Static Web App deployment token,
stored as a repository secret. The template does not create or rotate it. After
creating a new Static Web App, read the token with
`az staticwebapp secrets list --name <name> --query properties.apiKey -o tsv`
and store it as the `AZURE_STATIC_WEB_APPS_API_TOKEN` repository secret.
