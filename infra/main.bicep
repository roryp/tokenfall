targetScope = 'subscription'

@minLength(3)
@maxLength(24)
param environmentName string
param location string = 'eastus2'
@minLength(1)
param principalId string
@minValue(1)
param modelCapacity int = 500

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: {
    'azd-env-name': environmentName
    application: 'tokenfall'
  }
}

module model './model.bicep' = {
  scope: resourceGroup
  params: {
    location: location
    principalId: principalId
    modelCapacity: modelCapacity
  }
}

output AZURE_RESOURCE_GROUP string = resourceGroup.name
output AZURE_OPENAI_ENDPOINT string = model.outputs.endpoint
output AZURE_OPENAI_DEPLOYMENT string = model.outputs.deploymentName
output AZURE_OPENAI_ACCOUNT_NAME string = model.outputs.accountName
output AZURE_TENANT_ID string = tenant().tenantId
