using 'umami.bicep'

// Public, non-secret defaults for the landing page statistics. Subscription,
// resource group and the secure parameters are passed on the command line.
param location = 'germanywestcentral'
param databaseLocation = 'westeurope'
param appName = 'magic-stick-landingpage-umami'
param environmentName = 'magic-stick-landingpage'
param databaseServerName = 'magic-stick-landingpage-umami-postgresql'
param databaseAdminPassword = readEnvironmentVariable('UMAMI_DB_PASSWORD')
param appSecret = readEnvironmentVariable('UMAMI_APP_SECRET')
