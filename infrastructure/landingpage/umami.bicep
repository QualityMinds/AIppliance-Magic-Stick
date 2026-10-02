// Cookie-free Umami visitor statistics for the landing page and handbook.
//
// Owns the PostgreSQL server, the Container Apps environment with its Log
// Analytics workspace and the Umami container app. The site embeds the script
// URL from the `extra.umami` block of mkdocs.yml. Subscription and resource group
// are chosen at deployment time (see README.md); secrets are passed at
// deployment time and are never stored in this repository.

@description('Azure region of the Container Apps environment and the Umami app.')
param location string = 'germanywestcentral'

@description('Azure region of the PostgreSQL server.')
param databaseLocation string = 'westeurope'

@description('Name of the Umami container app. Part of its default hostname.')
param appName string = 'magic-stick-landingpage-umami'

@description('Name of the Container Apps environment.')
param environmentName string = 'magic-stick-landingpage'

@description('Name of the Log Analytics workspace for container logs.')
param workspaceName string = 'magicstick-logs'

@description('Name of the PostgreSQL flexible server. Must be globally unique.')
param databaseServerName string = 'magic-stick-landingpage-umami-postgresql'

@description('Name of the Umami database.')
param databaseName string = 'magic-stick-umami'

@description('PostgreSQL administrator login, also used by Umami.')
param databaseAdminLogin string = 'umami'

@secure()
@description('PostgreSQL administrator password. URL-safe characters only, as it is embedded in DATABASE_URL.')
param databaseAdminPassword string

@secure()
@description('Umami APP_SECRET. Keep the previous value when migrating so existing logins stay valid.')
param appSecret string

@description('Umami container image.')
param image string = 'docker.umami.is/umami-software/umami:latest'

@description('Optional resource tags.')
param tags object = {}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: databaseServerName
  location: databaseLocation
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: databaseAdminLogin
    administratorLoginPassword: databaseAdminPassword
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }

  resource umamiDatabase 'databases' = {
    name: databaseName
    properties: {
      charset: 'UTF8'
      collation: 'en_US.utf8'
    }
  }

  // Azure only allows extensions on this list to be created. Umami's migrations
  // run CREATE EXTENSION for pgcrypto. The setting is dynamic, so no restart is
  // needed. The dependency serialises child updates, which the server rejects
  // when they run concurrently.
  resource allowExtensions 'configurations' = {
    name: 'azure.extensions'
    properties: {
      value: 'PGCRYPTO'
      source: 'user-override'
    }
    dependsOn: [
      umamiDatabase
    ]
  }

  // Consumption Container Apps have no fixed outbound address, so access is
  // limited to Azure services. TLS is enforced by the server default.
  resource allowAzureServices 'firewallRules' = {
    name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
    properties: {
      startIpAddress: '0.0.0.0'
      endIpAddress: '0.0.0.0'
    }
    dependsOn: [
      allowExtensions
    ]
  }
}

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
  }
}

resource umami 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  tags: tags
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: [
        {
          name: 'app-secret'
          value: appSecret
        }
        {
          name: 'database-url'
          value: 'postgresql://${databaseAdminLogin}:${databaseAdminPassword}@${database.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=require'
        }
      ]
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            weight: 100
            latestRevision: true
          }
        ]
      }
    }
    template: {
      containers: [
        {
          name: appName
          image: image
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'APP_SECRET'
              secretRef: 'app-secret'
            }
            {
              name: 'DISABLE_TELEMETRY'
              value: '1'
            }
            {
              name: 'TRACKER_SCRIPT_NAME'
              value: 'stats'
            }
            {
              name: 'COLLECT_API_ENDPOINT'
              value: '/api/hits'
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              tcpSocket: {
                port: 3000
              }
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              tcpSocket: {
                port: 3000
              }
              periodSeconds: 5
              timeoutSeconds: 5
              failureThreshold: 48
            }
            {
              // Umami runs its database migrations before listening.
              type: 'Startup'
              tcpSocket: {
                port: 3000
              }
              initialDelaySeconds: 1
              periodSeconds: 1
              timeoutSeconds: 3
              failureThreshold: 240
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    database::umamiDatabase
    database::allowExtensions
    database::allowAzureServices
  ]
}

output defaultHostname string = umami.properties.configuration.ingress.fqdn
output databaseHost string = database.properties.fullyQualifiedDomainName
