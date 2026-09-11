param([int]$Port = 3100)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = Split-Path $PSScriptRoot -Parent
$executable = Join-Path $root 'data/cloudflared.exe'
$stateFile = Join-Path $root 'data/public-url.json'
if (-not (Test-Path $executable)) { throw 'Cloudflared is missing. See the README for the official download command.' }
try {
    & $executable tunnel --url "http://127.0.0.1:$Port" --protocol http2 --no-autoupdate 2>&1 | ForEach-Object {
        $line = $_.ToString()
        Write-Host $line
        if ($line -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
            $publicUrl = $Matches[0]
            [IO.File]::WriteAllText($stateFile, (@{ url = $publicUrl; processId = $PID } | ConvertTo-Json))
            Write-Host "Audience URL: $publicUrl"
        }
    }
} finally {
    if (Test-Path $stateFile) { Remove-Item $stateFile }
}