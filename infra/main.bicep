targetScope = 'subscription'

@minLength(3)
@maxLength(24)
param environmentName string
param location string = 'eastus2'
@minLength(1)
param principalId string
@minValue(1)
param modelCapacity int = 500
param webImage string = ''

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

module hosting './hosting.bicep' = {
  scope: resourceGroup
  params: {
    environmentName: environmentName
    location: location
    principalId: principalId
    openAIAccountName: model.outputs.accountName
    openAIEndpoint: model.outputs.endpoint
    openAIDeployment: model.outputs.deploymentName
    image: webImage
  }
}

output AZURE_RESOURCE_GROUP string = resourceGroup.name
output AZURE_OPENAI_ENDPOINT string = model.outputs.endpoint
output AZURE_OPENAI_DEPLOYMENT string = model.outputs.deploymentName
output AZURE_OPENAI_ACCOUNT_NAME string = model.outputs.accountName
output AZURE_TENANT_ID string = tenant().tenantId
output AZURE_CONTAINER_REGISTRY_NAME string = hosting.outputs.registryName
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = hosting.outputs.registryEndpoint
output AZURE_CONTAINER_APPS_ENVIRONMENT_ID string = hosting.outputs.environmentId
output AZURE_CONTAINER_APPS_ENVIRONMENT_NAME string = hosting.outputs.environmentName
output AZURE_LOG_ANALYTICS_WORKSPACE_NAME string = hosting.outputs.logAnalyticsWorkspaceName
output AZURE_STORAGE_ACCOUNT_NAME string = hosting.outputs.storageAccountName
output SERVICE_WEB_RESOURCE_NAME string = hosting.outputs.appName
output SERVICE_WEB_ENDPOINT_URL string = hosting.outputs.appUrl
