// Mattekamp på Azure Container Apps med en gratis Azure SQL-database på en eksisterende SQL-server.
// Kjøres via infra/deploy.sh: først uten app (for å få registeret), så med app og image-tag.

@description('Navneprefiks for ressursene')
param name string = 'mattekamp'

param location string = resourceGroup().location

@description('false første gang: lager register og miljø, men ikke appen (imaget finnes ikke ennå)')
param deployApp bool = false

@description('Tag på imaget i registeret, f.eks. 20261005163000')
param imageTag string = ''

@secure()
@description('Passord for databasebrukeren mattekamp_app (genereres av deploy.sh og lagres i .env.deploy)')
param sqlAppPassword string

@description('Eksisterende SQL-server som får databasen')
param sqlServerName string = 'c14p6tdr1x'
param sqlServerResourceGroup string = 'Default-SQL-NorthEurope'
param sqlServerLocation string = 'northeurope'

var suffix = uniqueString(resourceGroup().id)
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${name}${suffix}'
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-id'
  location: location
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

module sql 'sql.bicep' = {
  name: 'sql'
  scope: resourceGroup(sqlServerResourceGroup)
  params: {
    serverName: sqlServerName
    location: sqlServerLocation
  }
}

// Brukeren opprettes i databasen av infra/create-db-user.mjs (krever Entra-admin på serveren)
var databaseUrl = 'Server=tcp:${sql.outputs.host},1433;Database=${sql.outputs.databaseName};User Id=mattekamp_app;Password=${sqlAppPassword};Encrypt=true;TrustServerCertificate=false'

resource app 'Microsoft.App/containerApps@2024-03-01' = if (deployApp) {
  name: name
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        { name: 'database-url', value: databaseUrl }
      ]
    }
    template: {
      containers: [
        {
          name: name
          image: '${registry.properties.loginServer}/${name}:${imageTag}'
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'NODE_ENV', value: 'production' }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/api/health', port: 3000 }
              periodSeconds: 2
              failureThreshold: 30
            }
            {
              type: 'Liveness'
              httpGet: { path: '/api/health', port: 3000 }
              periodSeconds: 30
              failureThreshold: 3
            }
          ]
        }
      ]
      // Står stille (gratis) når ingen bruker siden; første besøk etter pause tar noen sekunder
      scale: {
        minReplicas: 0
        maxReplicas: 2
        rules: [
          { name: 'http', http: { metadata: { concurrentRequests: '50' } } }
        ]
      }
    }
  }
  dependsOn: [acrPull]
}

output registryName string = registry.name
output sqlHost string = sql.outputs.host
output sqlDatabase string = sql.outputs.databaseName
output url string = deployApp ? 'https://${app!.properties.configuration.ingress.fqdn}' : ''
