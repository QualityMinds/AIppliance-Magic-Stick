# Landing page hosting

Bicep templates for the Azure resources behind the public landing page and
handbook. The site content is built and uploaded by
[`.github/workflows/azure-static-web-apps.yml`](../../.github/workflows/azure-static-web-apps.yml);
these templates only manage the hosting resources.

| File | Purpose |
|---|---|
| `staticwebapp.bicep` | Static Web App resource (resource-group scope) |
| `staticwebapp.bicepparam` | Public default parameter values |
| `umami.bicep` | Umami visitor statistics: PostgreSQL, Container Apps environment, app and retention job |
| `umami.bicepparam` | Public defaults; secrets are read from environment variables |

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

## Visitor statistics (Umami)

`umami.bicep` deploys the cookie-free statistics described in
[website development](../../docs/development/website.md#visitor-statistics).
The target subscription needs the `Microsoft.App`, `Microsoft.DBforPostgreSQL`
and `Microsoft.OperationalInsights` resource providers registered
(`az provider register -n <namespace> --wait`).

The template also creates the `magic-stick-umami-retention` Container Apps job.
It runs daily and deletes visitor records older than `retentionMonths` (25), the period
stated in the privacy policy. Check a run with
`az containerapp job execution list -g "<resource-group>" -n magic-stick-umami-retention`.
The Umami image is pinned by digest; update `image` only after checking the
privacy policy (`docs/privacy.html` and `docs/datenschutz.html`) against the new
version, as Umami migrations cannot be undone.

```sh
# URL-safe characters only: the password becomes part of DATABASE_URL.
export UMAMI_DB_PASSWORD="CHANGEME"
# Reuse the previous APP_SECRET when migrating an existing instance.
export UMAMI_APP_SECRET="CHANGEME"

az deployment group what-if \
  --resource-group "<resource-group>" \
  --template-file infrastructure/landingpage/umami.bicep \
  --parameters infrastructure/landingpage/umami.bicepparam

az deployment group create \
  --resource-group "<resource-group>" \
  --template-file infrastructure/landingpage/umami.bicep \
  --parameters infrastructure/landingpage/umami.bicepparam \
  --query properties.outputs
```

The website ID and all statistics live in the database. To move an existing
instance, stop the old app so no visits arrive in between, copy the database and
then point the site at the new app:

```sh
az containerapp update -g "<old-resource-group>" -n magic-stick-umami \
  --subscription "<old-subscription>" --min-replicas 0 --max-replicas 0

pg_dump --format=custom --no-owner --no-privileges \
  "postgresql://umami@<old-host>:5432/magic-stick-umami?sslmode=require" > umami.dump
pg_restore --no-owner --no-privileges --clean --if-exists \
  --dbname "postgresql://umami@<new-host>:5432/magic-stick-umami?sslmode=require" umami.dump

az containerapp revision restart -g "<resource-group>" -n magic-stick-landingpage-umami \
  --revision "$(az containerapp show -g "<resource-group>" -n magic-stick-landingpage-umami \
  --query properties.latestRevisionName -o tsv)"
```

The Container Apps environment gets a new default domain, so update
`extra.umami.script` in `mkdocs.yml` to the `defaultHostname` output. Delete the
old resources only after the published site reports visits to the new instance,
and do not commit the dump file.
