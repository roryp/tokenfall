param environmentName string
param location string
param principalId string
param openAIAccountName string
param openAIEndpoint string
param openAIDeployment string
param image string = ''

var resourceToken = uniqueString(subscription().id, resourceGroup().id, location, environmentName)
var appName = 'azapp${resourceToken}'
var tags = {
  'azd-env-name': environmentName
  application: 'tokenfall'
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'azid${resourceToken}'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: 'azacr${resourceToken}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
    roleAssignmentMode: 'LegacyRegistryPermissions'
  }
}

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, 'AcrPull')
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

resource registryPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, principalId, 'AcrPush')
  scope: registry
  properties: {
    principalId: principalId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8311e382-0749-4cb8-b61a-304f252e45ec')
  }
}

resource modelAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: openAIAccountName
}

resource inferenceRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(modelAccount.id, identity.id, 'cognitive-services-openai-user')
  scope: modelAccount
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
  }
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

resource environment 'Microsoft.App/managedEnvironments@2026-01-01' = {
  name: 'azenv${resourceToken}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2026-06-01' = {
  name: 'azst${resourceToken}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    defaultToOAuthAuthentication: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2026-06-01' = {
  parent: storage
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2026-06-01' = {
  parent: fileService
  name: 'tokenfall'
  properties: {
    enabledProtocols: 'SMB'
    accessTier: 'TransactionOptimized'
    shareQuota: 5
  }
}

resource environmentStorage 'Microsoft.App/managedEnvironments/storages@2026-01-01' = {
  parent: environment
  name: 'tokenfall'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: share.name
      accessMode: 'ReadWrite'
    }
  }
}

var publicUrl = 'https://${appName}.${environment.properties.defaultDomain}'

resource app 'Microsoft.App/containerApps@2026-01-01' = {
  name: appName
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 3100
        transport: 'auto'
        stickySessions: { affinity: 'sticky' }
        corsPolicy: {
          allowedOrigins: [publicUrl]
          allowedMethods: ['GET', 'POST', 'OPTIONS']
          allowedHeaders: ['Content-Type']
          allowCredentials: true
        }
      }
      registries: [
        { server: registry.properties.loginServer, identity: identity.id }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: empty(image) ? 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest' : image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'HOST', value: '0.0.0.0' }
            { name: 'PORT', value: '3100' }
            { name: 'DATA_DIRECTORY', value: '/data' }
            { name: 'SQLITE_JOURNAL_MODE', value: 'DELETE' }
            { name: 'AZURE_OPENAI_ENDPOINT', value: openAIEndpoint }
            { name: 'AZURE_OPENAI_DEPLOYMENT', value: openAIDeployment }
            { name: 'AZURE_TENANT_ID', value: tenant().tenantId }
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
            { name: 'AZURE_LOCATION', value: location }
            { name: 'PUBLIC_BASE_URL', value: publicUrl }
          ]
          volumeMounts: [
            { volumeName: 'state', mountPath: '/data' }
          ]
          probes: [
            {
              type: 'Startup'
              tcpSocket: { port: 3100 }
              periodSeconds: 5
              failureThreshold: 60
            }
            {
              type: 'Readiness'
              httpGet: { path: '/api/health', port: 3100 }
              periodSeconds: 10
              timeoutSeconds: 5
            }
            {
              type: 'Liveness'
              httpGet: { path: '/api/health', port: 3100 }
              periodSeconds: 30
              timeoutSeconds: 5
            }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
      volumes: [
        {
          name: 'state'
          storageType: 'AzureFile'
          storageName: environmentStorage.name
          mountOptions: 'uid=1000,gid=1000,file_mode=0600,dir_mode=0700,vers=3.1.1,nobrl'
        }
      ]
    }
  }
  dependsOn: [registryPull, inferenceRole]
}

output appName string = app.name
output appUrl string = publicUrl
output registryName string = registry.name
output registryEndpoint string = registry.properties.loginServer
output environmentId string = environment.id
output environmentName string = environment.name
output logAnalyticsWorkspaceName string = logs.name
output storageAccountName string = storage.name
