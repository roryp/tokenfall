param location string
param principalId string
param modelCapacity int
param appInsightsName string

var accountName = 'aoai-tokenfall-${uniqueString(resourceGroup().id)}'
var projectName = 'tokenfall'

// Upgraded in place from Azure OpenAI to Foundry; the name, endpoint, deployment and role assignments are preserved.
resource account 'Microsoft.CognitiveServices/accounts@2026-07-01' = {
  name: accountName
  location: location
  kind: 'AIServices'
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: accountName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    allowProjectManagement: true
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2026-07-01' = {
  parent: account
  name: projectName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    displayName: 'Tokenfall'
    description: 'Luna traces and token usage.'
  }
  // The account accepts one child operation at a time; parallel writes fail with RequestConflict.
  dependsOn: [deployment]
}

resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: account
  name: 'gpt-5.6-luna'
  sku: {
    name: 'GlobalStandard'
    capacity: modelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-5.6-luna'
      version: '2026-07-09'
    }
    versionUpgradeOption: 'NoAutoUpgrade'
    raiPolicyName: 'Microsoft.Default'
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

// Foundry's Traces view reads this connection. The project identity ingests Foundry-hosted traces.
resource tracingConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2026-07-01' = {
  parent: project
  name: appInsightsName
  properties: {
    category: 'AppInsights'
    target: appInsights.id
    #disable-next-line BCP036
    authType: 'ProjectManagedIdentity'
    isSharedToAll: true
    metadata: {
      ApiType: 'Azure'
      ResourceId: appInsights.id
      ApplicationInsightsConnectionString: appInsights.properties.ConnectionString
    }
  }
}

resource projectTracePublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: appInsights
  name: guid(appInsights.id, project.id, 'monitoring-metrics-publisher')
  properties: {
    principalId: project.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')
  }
}

resource inferenceRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: account
  name: guid(account.id, principalId, 'cognitive-services-openai-user')
  properties: {
    principalId: principalId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
  }
}

// Owner and Contributor manage the account; Foundry User grants the data-plane access the portal needs.
resource foundryUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: account
  name: guid(account.id, principalId, 'azure-ai-user')
  properties: {
    principalId: principalId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '53ca6127-db72-4b80-b1b0-d745d6d5456d')
  }
}

output endpoint string = account.properties.endpoints[?'OpenAI Language Model Instance API'] ?? account.properties.endpoint
output deploymentName string = deployment.name
output accountName string = account.name
output projectName string = project.name
output projectEndpoint string = project.properties.endpoints['AI Foundry API']
