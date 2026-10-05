// Azure SQL med gratistilbudet (serverless, 100 000 vCore-sekunder og 32 GB per måned).
// Brukes kvoten opp, pauses databasen ut måneden i stedet for å fakturere.

param name string
param location string

@secure()
param adminPassword string

var adminLogin = 'mattekampadmin'
var databaseName = 'mattekamp'

resource server 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: '${name}-sql-${uniqueString(resourceGroup().id)}'
  location: location
  properties: {
    administratorLogin: adminLogin
    administratorLoginPassword: adminPassword
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    version: '12.0'
  }
}

resource database 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: server
  name: databaseName
  location: location
  sku: {
    name: 'GP_S_Gen5_2'
    tier: 'GeneralPurpose'
    family: 'Gen5'
    capacity: 2
  }
  properties: {
    useFreeLimit: true
    freeLimitExhaustionBehavior: 'AutoPause'
    autoPauseDelay: 60
    minCapacity: json('0.5')
    maxSizeBytes: 34359738368
    zoneRedundant: false
    requestedBackupStorageRedundancy: 'Local'
  }
}

// 0.0.0.0–0.0.0.0 betyr «tillat tjenester i Azure» (Container Apps har ikke faste utgående IP-er)
resource allowAzure 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = {
  parent: server
  name: 'AllowAllWindowsAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

output host string = server.properties.fullyQualifiedDomainName
output adminLogin string = adminLogin
output databaseName string = databaseName
