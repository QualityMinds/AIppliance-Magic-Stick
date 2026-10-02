// Cookie-free Umami visitor statistics for the landing page and handbook.
//
// Owns the PostgreSQL server, the Container Apps environment with its Log
// Analytics workspace, the Umami container app and the scheduled job that
// deletes visitor data after the retention period of docs/privacy.html. The site embeds the script
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

// Pinned by digest: the privacy policy describes what this version collects.
// Review docs/privacy.html before upgrading; Umami cannot be downgraded after
// its migrations have run.
@description('Umami container image.')
param image string = 'docker.umami.is/umami-software/umami:3.4.0@sha256:85909afc45bdcda1917394594a087421fdbb05610fded0fa9f6fb861abb2f367'

@description('Name of the retention job. Container Apps jobs allow at most 32 characters.')
@maxLength(32)
param purgeJobName string = 'magic-stick-umami-retention'

@description('Months after which visitor data is deleted. Must match the retention in docs/privacy.html.')
@minValue(1)
param retentionMonths int = 25

@description('PostgreSQL client image of the retention job.')
param purgeImage string = 'docker.io/library/postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea'

@description('Schedule (cron, UTC) of the retention job.')
param purgeSchedule string = '17 3 * * *'

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

// Umami has no retention setting, so this job deletes visitor records older than
// retentionMonths. Tables are checked first because the set differs between
// Umami versions. Sessions go last and only once no events refer to them.
var purgeSql = replace('''
DO $$
DECLARE
  cutoff timestamptz := now() - make_interval(months => __MONTHS__);
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['event_data', 'session_data', 'revenue', 'heatmap_event',
      'session_replay', 'session_link', 'website_event'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DELETE FROM %I WHERE created_at < $1', t) USING cutoff;
      GET DIAGNOSTICS n = ROW_COUNT;
      RAISE NOTICE '%: % rows deleted', t, n;
    END IF;
  END LOOP;
  DELETE FROM session s WHERE s.created_at < cutoff
    AND NOT EXISTS (SELECT 1 FROM website_event e WHERE e.session_id = s.session_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'session: % rows deleted', n;
END $$;
''', '__MONTHS__', string(retentionMonths))

resource purge 'Microsoft.App/jobs@2025-01-01' = {
  name: purgeJobName
  location: location
  tags: tags
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: {
        cronExpression: purgeSchedule
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: 1800
      replicaRetryLimit: 1
      secrets: [
        {
          name: 'database-url'
          value: 'postgresql://${databaseAdminLogin}:${databaseAdminPassword}@${database.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=require'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'retention'
          image: purgeImage
          command: [
            '/bin/sh'
            '-c'
            'printf \'%s\' "$PURGE_SQL" | psql "$DATABASE_URL" --no-psqlrc -v ON_ERROR_STOP=1'
          ]
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'PURGE_SQL'
              value: purgeSql
            }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
  // Umami creates the tables on its first start.
  dependsOn: [
    umami
  ]
}

output defaultHostname string = umami.properties.configuration.ingress.fqdn
output databaseHost string = database.properties.fullyQualifiedDomainName
