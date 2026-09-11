$ErrorActionPreference = 'Stop'
$settings = azd env get-values --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Could not read the azd environment.' }
$accessToken = az account get-access-token --resource https://cognitiveservices.azure.com --subscription $settings.AZURE_SUBSCRIPTION_ID --query accessToken --output tsv
if ($LASTEXITCODE -ne 0) { throw 'Azure CLI authentication is unavailable.' }
$policy = Get-Content -Raw (Join-Path $PSScriptRoot '../server/policy.md')
$endpoint = $settings.AZURE_OPENAI_ENDPOINT.TrimEnd('/') + '/openai/v1/chat/completions'
$results = @()
$modes = @('warm') + @(1..5 | ForEach-Object { 'reuse' }) + @('disabled')
foreach ($mode in $modes) {
    if ($mode -eq 'reuse' -and @($results | Where-Object { $_.cacheRead -gt 0 }).Count -gt 0) { continue }
    $content = @{ type = 'text'; text = $policy }
    if ($mode -ne 'disabled') { $content.prompt_cache_breakpoint = @{ mode = 'explicit' } }
    $payload = @{
        model = $settings.AZURE_OPENAI_DEPLOYMENT
        reasoning_effort = 'none'
        max_completion_tokens = 128
        store = $false
        prompt_cache_key = 'tokenfall-smoke-v1'
        prompt_cache_options = @{ mode = 'explicit'; ttl = '30m' }
        messages = @(
            @{ role = 'system'; content = @($content) }
            @{ role = 'user'; content = '{"active":"I","board":"empty 10 by 20 board","placements":[{"id":"M0","clearedLines":0,"holes":0,"aggregateHeight":4,"maxHeight":1,"bumpiness":1},{"id":"M1","clearedLines":0,"holes":0,"aggregateHeight":4,"maxHeight":4,"bumpiness":4}]}' }
        )
        response_format = @{
            type = 'json_schema'
            json_schema = @{
                name = 'tetris_move'
                strict = $true
                schema = @{
                    type = 'object'
                    properties = @{ placementId = @{ type = 'string' }; tip = @{ type = 'string' } }
                    required = @('placementId', 'tip')
                    additionalProperties = $false
                }
            }
        }
    }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $response = Invoke-RestMethod -Uri $endpoint -Method Post -Headers @{ Authorization = "Bearer $accessToken" } -ContentType 'application/json' -Body ($payload | ConvertTo-Json -Depth 15) -TimeoutSec 45
    $timer.Stop()
    if ($response.usage.completion_tokens_details.reasoning_tokens -ne 0) { throw 'The service did not confirm zero reasoning tokens.' }
    $choice = $response.choices[0].message.content | ConvertFrom-Json
    if ($choice.placementId -notin @('M0', 'M1')) { throw 'The model returned an invalid placement.' }
    $results += [pscustomobject]@{
        mode = $mode
        model = $response.model
        input = $response.usage.prompt_tokens
        output = $response.usage.completion_tokens
        cacheRead = $response.usage.prompt_tokens_details.cached_tokens
        cacheWrite = $response.usage.prompt_tokens_details.cache_write_tokens
        reasoning = $response.usage.completion_tokens_details.reasoning_tokens
        milliseconds = $timer.ElapsedMilliseconds
        placement = $choice.placementId
    }
}
$results | ConvertTo-Json
if (@($results | Where-Object { $_.cacheRead -gt 0 }).Count -eq 0) { throw 'Inference worked, but no real cache read was observed.' }
if ($results[-1].cacheRead -ne 0 -or $results[-1].cacheWrite -gt 0) { throw 'The cache-disabled request unexpectedly used the cache.' }