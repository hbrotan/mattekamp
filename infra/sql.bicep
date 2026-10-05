// Gratis Azure SQL-database (serverless «free offer») på en eksisterende SQL-server.
// Deployes i serverens ressursgruppe. Gratiskvoten er 100 000 vCore-sekunder og 32 GB per måned;
// brukes den opp, pauses databasen ut måneden i stedet for å fakturere.

param serverName string

@description('Må være samme region som serveren')
param location string
param databaseName string = 'mattekamp'

resource server 'Microsoft.Sql/servers@2023-08-01-preview' existing = {
  name: serverName
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

output host string = server.properties.fullyQualifiedDomainName
output databaseName string = database.name
