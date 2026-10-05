param environmentName string
param location string
param principalId string

var resourceToken = uniqueString(subscription().id, resourceGroup().id, location, environmentName)
var tags = {
  'azd-env-name': environmentName
  application: 'tokenfall'
}

resource logs 'Microsoft.OperationalInsights/workspaces@2026-03-01' = {
  name: 'azlog${resourceToken}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: 1 }
  }
}

// Foundry reads traces from this resource. Ingestion accepts Microsoft Entra ID tokens only.
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'azappi${resourceToken}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    DisableLocalAuth: true
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// Lets the developer view traces in Foundry and export them from a local server.
resource developerTracePublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: appInsights
  name: guid(appInsights.id, principalId, 'monitoring-metrics-publisher')
  properties: {
    principalId: principalId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')
  }
}

resource developerTraceReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: appInsights
  name: guid(appInsights.id, principalId, 'log-analytics-reader')
  properties: {
    principalId: principalId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '73c42c96-874c-492b-b04d-ab87d138a893')
  }
}

output logAnalyticsWorkspaceName string = logs.name
output appInsightsName string = appInsights.name
output appInsightsConnectionString string = appInsights.properties.ConnectionString
