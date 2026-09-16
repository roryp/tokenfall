[CmdletBinding()]
param(
    [Parameter(Mandatory)][switch]$Azure,
    [ValidatePattern('^[\w-]+$')][string]$Environment = 'tokenfall-dev',
    [ValidateSet('all', 'scores')][string]$Mode = 'all',
    [switch]$Apply,
    [ValidatePattern('^[A-Z0-9]{6}$')][string]$ConfirmRoom
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (-not $Azure) { throw 'Use -Azure, or use reset-room.ts for a stopped local server.' }
if ($Apply -and -not $ConfirmRoom) { throw '-Apply requires -ConfirmRoom with the room code shown by the preview.' }
$root = Split-Path $PSScriptRoot -Parent
$azureExecutable = (Get-Command az -ErrorAction Stop).Source
$azurePrefix = @()
if ($IsWindows -and $azureExecutable.EndsWith('.cmd')) {
    $azureExecutable = Join-Path (Split-Path $azureExecutable -Parent) '../python.exe'
    if (-not (Test-Path $azureExecutable)) { throw 'The Azure CLI bundled Python executable was not found.' }
    $azurePrefix = @('-IBm', 'azure.cli')
}

Push-Location $root
try {
    $previousAgent = $env:AZURE_DEV_USER_AGENT
    try {
        $env:AZURE_DEV_USER_AGENT = 'microsoft_foundry_skill'
        $environmentJson = & azd env get-values --environment $Environment --output json
        if ($LASTEXITCODE -ne 0) { throw 'Could not read the existing azd environment.' }
        $environmentValues = ($environmentJson -join "`n") | ConvertFrom-Json
    } finally { $env:AZURE_DEV_USER_AGENT = $previousAgent }
} finally { Pop-Location }
$subscription = $environmentValues.AZURE_SUBSCRIPTION_ID
$resourceGroup = $environmentValues.AZURE_RESOURCE_GROUP
if (-not $subscription -or -not $resourceGroup) { throw 'The environment must specify a subscription and resource group.' }
$rateLimited = $false

function Invoke-Azure([string[]]$CliArguments) {
    $output = & $azureExecutable @azurePrefix @CliArguments --subscription $subscription --only-show-errors 2>&1
    $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    if ($LASTEXITCODE -ne 0) {
        if ($text -match '429|Too Many Requests') {
            $script:rateLimited = $true
            throw 'Azure maintenance is rate-limited (HTTP 429). Respect its Retry-After cooldown before rerunning; no automatic retry was attempted.'
        }
        throw "Azure CLI failed: $($CliArguments[0..1] -join ' '). $text"
    }
    return $text
}

$apps = @(Invoke-Azure @('containerapp', 'list', '--resource-group', $resourceGroup, '--query', '[].{name:name,tags:tags}', '--output', 'json') | ConvertFrom-Json | Where-Object { $_.tags.'azd-service-name' -eq 'web' })
if ($apps.Count -ne 1) { throw 'Expected exactly one Container App tagged azd-service-name=web in this environment.' }
$appName = $apps[0].name
$appArguments = @('--name', $appName, '--resource-group', $resourceGroup)
$target = Invoke-Azure (@('containerapp', 'show') + $appArguments + @('--query', '{fqdn:properties.configuration.ingress.fqdn,port:properties.configuration.ingress.targetPort,revision:properties.latestReadyRevisionName,mode:properties.configuration.activeRevisionsMode}', '--output', 'json')) | ConvertFrom-Json
$revisions = @(Invoke-Azure (@('containerapp', 'revision', 'list') + $appArguments + @('--query', '[?properties.active].{name:name,replicas:properties.replicas}', '--output', 'json')) | ConvertFrom-Json)
if ($target.mode -ne 'Single' -or $revisions.Count -ne 1 -or $revisions[0].replicas -ne 1 -or $revisions[0].name -ne $target.revision) {
    throw 'Reset requires one active revision and one replica; no scaling or traffic settings will be changed.'
}
if ($target.port -ne 3100 -or -not $target.fqdn) { throw 'The selected app does not match the expected Tetris server.' }
$baseUrl = "https://$($target.fqdn)"
function Get-Room {
    return Invoke-RestMethod "$baseUrl/api/room" -TimeoutSec 20 -MaximumRetryCount 6 -RetryIntervalSec 2
}
$before = Get-Room
if ($ConfirmRoom -and $before.code -ne $ConfirmRoom) { throw 'The room code does not match -ConfirmRoom.' }
if ($Apply -and ($before.online -ne 0 -or $before.allowance.reserved -ne 0)) { throw 'Players or AI requests are active. Finish those games before resetting.' }
Write-Host "Target: $appName / room $($before.code) / mode $Mode"
if ($Mode -eq 'all') { Write-Host 'Full reset removes saved players, both leaderboards, sessions and in-app AI usage history. Everyone must join again. Azure billing is not erased.' }
else { Write-Host 'Scores-only reset retains player entries and AI usage. Use mode all for an empty leaderboard.' }

$source = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'reset-room.ts'))
$hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($source)).ToLowerInvariant()
$buffer = [IO.MemoryStream]::new()
try {
    $gzip = [IO.Compression.GZipStream]::new($buffer, [IO.Compression.CompressionLevel]::SmallestSize, $true)
    try { $gzip.Write($source, 0, $source.Length) } finally { $gzip.Dispose() }
    $encoded = [Convert]::ToBase64String($buffer.ToArray())
} finally { $buffer.Dispose() }
$arguments = @('--database', '/data/tokenfall.sqlite', '--mode', $Mode)
if ($Apply) { $arguments += @('--apply', '--confirm-room', $ConfirmRoom, '--url', 'http://127.0.0.1:3100') }
$job = @{ source = $encoded; hash = $hash; args = $arguments } | ConvertTo-Json -Compress
$bootstrap = @'
const fs=require('node:fs'),crypto=require('node:crypto');if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',chunk=>{input+=chunk;if(!input.includes('\n'))return;process.stdin.pause();let script;try{const job=JSON.parse(input.slice(0,input.indexOf('\n'))),source=require('node:zlib').gunzipSync(Buffer.from(job.source,'base64'));if(crypto.createHash('sha256').update(source).digest('hex')!==job.hash)throw Error('Checksum mismatch');script=require('node:path').join(require('node:os').tmpdir(),'tetris-reset-'+crypto.randomUUID()+'.ts');fs.writeFileSync(script,source,{flag:'wx',mode:384});const result=require('node:child_process').spawnSync(process.execPath,[script,...job.args],{encoding:'utf8',timeout:90000});process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');console.log('RESET_PROCESS_EXIT '+(result.status??1));}catch(error){console.error(error.message);console.log('RESET_PROCESS_EXIT 1');}finally{if(script)fs.rmSync(script,{force:true});process.exit();}});console.log('RESET_TRANSPORT_READY');
'@
$command = 'node -e "' + $bootstrap.Trim() + '"'
$encodedCommand = [Uri]::EscapeDataString($command)
if ($encodedCommand.Length -gt 2000) { throw 'Remote bootstrap exceeds the exec query limit.' }
$replicas = @(Invoke-Azure (@('containerapp', 'replica', 'list') + $appArguments + @('--revision', $target.revision, '--query', '[].{name:name,containers:properties.containers}', '--output', 'json')) | ConvertFrom-Json)
if ($replicas.Count -ne 1) { throw 'Expected one running replica.' }
$container = @($replicas[0].containers | Where-Object { $_.name -eq 'web' })
if ($container.Count -ne 1 -or -not $container[0].logStreamEndpoint) { throw 'The web container has no maintenance endpoint.' }
$endpoint = [Uri]$container[0].logStreamEndpoint
if ($endpoint.Scheme -ne 'https' -or $endpoint.UserInfo) { throw 'Invalid Azure maintenance endpoint.' }
$uri = [UriBuilder]::new($endpoint)
$uri.Scheme = 'wss'
$uri.Path = "/subscriptions/$subscription/resourceGroups/$resourceGroup/containerApps/$appName/revisions/$($target.revision)/replicas/$($replicas[0].name)/containers/web/exec"
$uri.Query = "command=$encodedCommand"
$resourceId = "/subscriptions/$subscription/resourceGroups/$resourceGroup/providers/Microsoft.App/containerApps/$appName"
$authorization = Invoke-Azure @('rest', '--method', 'post', '--url', "https://management.azure.com$resourceId/getAuthToken?api-version=2025-07-01", '--output', 'json') | ConvertFrom-Json
if (-not $authorization.properties.token) { throw 'Azure did not provide an exec credential.' }
$socket = [Net.WebSockets.ClientWebSocket]::new()
$socket.Options.SetRequestHeader('Authorization', "Bearer $($authorization.properties.token)")
$authorization = $null
$timeout = [Threading.CancellationTokenSource]::new(120000)
$output = [Text.StringBuilder]::new()
$restartRequired = $false
$sent = $false
$result = $null
try {
    $null = $socket.ConnectAsync($uri.Uri, $timeout.Token).GetAwaiter().GetResult()
    $resize = [byte[]](@(0, 4) + [Text.Encoding]::UTF8.GetBytes('{"Width":160,"Height":40}'))
    $null = $socket.SendAsync([ArraySegment[byte]]::new($resize), [Net.WebSockets.WebSocketMessageType]::Text, $true, $timeout.Token).GetAwaiter().GetResult()
    $receiveBuffer = [byte[]]::new(16384)
    while ($socket.State -eq [Net.WebSockets.WebSocketState]::Open) {
        $message = [IO.MemoryStream]::new()
        try {
            do {
                $received = $socket.ReceiveAsync([ArraySegment[byte]]::new($receiveBuffer), $timeout.Token).GetAwaiter().GetResult()
                if ($received.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { break }
                $message.Write($receiveBuffer, 0, $received.Count)
                if ($message.Length -gt 131072) { throw 'Unexpectedly large exec response.' }
            } while (-not $received.EndOfMessage)
            if ($received.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { break }
            $frame = $message.ToArray()
        } finally { $message.Dispose() }
        if ($frame.Length -gt 2 -and $frame[0] -eq 0 -and $frame[1] -in @(1, 2)) {
            $null = $output.Append([Text.Encoding]::UTF8.GetString($frame, 2, $frame.Length - 2))
        } elseif ($frame.Length -gt 1 -and $frame[0] -eq 2) {
            throw 'Azure rejected the exec operation.'
        }
        if ($output.Length -gt 131072) { throw 'Exec output exceeded the limit.' }
        if (-not $sent -and $output.ToString().Contains('RESET_TRANSPORT_READY')) {
            if ($Apply) {
                $current = Get-Room
                if ($current.code -ne $ConfirmRoom -or $current.online -ne 0 -or $current.allowance.reserved -ne 0) { throw 'The room is no longer idle.' }
                $restartRequired = $true
            }
            $payload = [byte[]](@(0, 0) + [Text.Encoding]::UTF8.GetBytes($job + "`n"))
            $null = $socket.SendAsync([ArraySegment[byte]]::new($payload), [Net.WebSockets.WebSocketMessageType]::Text, $true, $timeout.Token).GetAwaiter().GetResult()
            $sent = $true
        }
        if ($output.ToString() -match 'RESET_PROCESS_EXIT \d+') { break }
    }
    $text = $output.ToString()
    if ($text -notmatch 'RESET_PROCESS_EXIT 0') { throw "Remote reset failed: $text" }
    $match = [regex]::Match($text, 'RESET_RESULT (\{[^\r\n]+\})')
    if (-not $match.Success) { throw 'Reset did not return a verified result.' }
    $result = $match.Groups[1].Value | ConvertFrom-Json
    if ($result.room -ne $before.code -or $result.mode -ne $Mode -or $result.applied -ne [bool]$Apply) { throw 'The remote reset result does not match the requested operation.' }
    if ($Apply) { Write-Host "Verified recovery backup: $($result.backupPath)" }
} catch {
    if ($_.Exception.Message -match '429') { throw 'Azure maintenance is rate-limited (HTTP 429). Retry after the service cooldown; no automatic retry was attempted.' }
    if ($timeout.IsCancellationRequested) { throw "Azure exec timed out. Payload sent: $sent. Output: $($output.ToString())" }
    throw
} finally {
    $socket.Dispose()
    $timeout.Dispose()
    if ($restartRequired) {
        Write-Host 'Restarting the same revision to clear in-memory games and sessions.'
        $null = Invoke-Azure (@('containerapp', 'revision', 'restart') + $appArguments + @('--revision', $target.revision))
    }
}

if ($Apply) {
    $after = Get-Room
    if ($after.code -ne $ConfirmRoom) { throw 'Room identity changed after restart.' }
    if ($Mode -eq 'all') {
        $nonzeroMetrics = @($after.metrics.PSObject.Properties | Where-Object { $_.Value -ne 0 })
        if ($after.leaderboard.Count -ne 0 -or $after.pointsLeaderboard.Count -ne 0 -or $nonzeroMetrics.Count -ne 0 -or $after.unmeteredRequests -ne 0 -or $after.allowance.remaining -ne $after.allowance.limit) {
            throw 'Verification failed: leaderboard or history is not empty after restart.'
        }
    } else {
        if (@($after.pointsLeaderboard | Where-Object { $_.score -ne 0 -or $_.lines -ne 0 -or $_.level -ne 1 }).Count -ne 0) { throw 'Scores were not cleared.' }
        if (($after.metrics | ConvertTo-Json -Compress) -ne ($before.metrics | ConvertTo-Json -Compress)) { throw 'Usage changed during a scores-only reset.' }
    }
    Write-Host "Verified: reset complete at $baseUrl/?room=$ConfirmRoom"
} else {
    Write-Host "Preview only; no data changed. Apply with: npm run reset:azure -- -Environment $Environment -Mode $Mode -Apply -ConfirmRoom $($result.room)"
}
$result | ConvertTo-Json -Depth 6