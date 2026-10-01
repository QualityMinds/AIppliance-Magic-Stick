// Azure Static Web App that serves the landing page and handbook.
//
// The site content is not built here: .github/workflows/azure-static-web-apps.yml
// builds dist/docs-site and uploads it with the deployment token. This template
// only owns the hosting resource. Subscription and resource group are chosen at
// deployment time (see README.md) and are intentionally not part of the template.

@description('Name of the Static Web App. Must match the existing resource to adopt it.')
param name string = 'magic-stick-landingpage'

@description('Azure region of the Static Web App.')
param location string = 'westeurope'

@description('Static Web Apps plan. Standard is required for staging environments with custom auth and SLA.')
@allowed([
  'Free'
  'Standard'
])
param skuName string = 'Standard'

@description('Source repository linked to the Static Web App.')
param repositoryUrl string = 'https://github.com/QualityMinds/AIppliance-Magic-Stick'

@description('Production branch of the linked repository.')
param branch string = 'main'

@description('Optional resource tags.')
param tags object = {}

resource landingpage 'Microsoft.Web/staticSites@2024-11-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuName
  }
  properties: {
    repositoryUrl: repositoryUrl
    branch: branch
    provider: 'GitHub'
    // Pull requests get preview environments from the GitHub workflow.
    stagingEnvironmentPolicy: 'Enabled'
    allowConfigFileUpdates: true
    enterpriseGradeCdnStatus: 'Disabled'
  }
}

output id string = landingpage.id
output defaultHostname string = landingpage.properties.defaultHostname
