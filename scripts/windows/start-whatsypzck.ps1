# Author: Ç.Kurtoğlu
# Description: One-click start script for WhatsYpzck + local AI services

param(
    [string]$WorkspacePath = "C:\Users\34116\Documents\GitHub\Projelerim\WhatsYpzck"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $WorkspacePath)) {
    throw "Workspace bulunamadi: $WorkspacePath"
}

Set-Location $WorkspacePath

Write-Host "[Ç.Kurtoğlu] WhatsYpzck sistem baslatiliyor..." -ForegroundColor Cyan

$appName = Split-Path -Leaf $WorkspacePath
$packageJsonPath = Join-Path $WorkspacePath "package.json"
if (Test-Path $packageJsonPath) {
    try {
        $package = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
        if (-not [string]::IsNullOrWhiteSpace($package.name)) {
            $appName = $package.name
        }
    } catch {
        Write-Host "[Ç.Kurtoğlu] package.json okunamadi, klasor adi kullanilacak." -ForegroundColor Yellow
    }
}

$appSlug = ($appName.ToLower() -replace "[^a-z0-9_.-]", "-").Trim("-")
if ([string]::IsNullOrWhiteSpace($appSlug)) {
    $appSlug = "whatsypzck"
}

function Test-PortInUse {
    param([int]$Port)

    try {
        return $null -ne (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1)
    } catch {
        return $false
    }
}

$openWebUiPort = 3001
$envPathForDocker = Join-Path $WorkspacePath ".env"
if (Test-Path $envPathForDocker) {
    $line = Get-Content $envPathForDocker | Where-Object { $_ -match '^OPEN_WEBUI_PORT=' } | Select-Object -First 1
    if ($line) {
        $parsed = ($line -replace '^OPEN_WEBUI_PORT=', '').Trim()
        if ($parsed -match '^\d+$') {
            $openWebUiPort = [int]$parsed
        }
    }
}

$resolvedOpenWebUiPort = $openWebUiPort
while (Test-PortInUse -Port $resolvedOpenWebUiPort) {
    $resolvedOpenWebUiPort++
}

$openWebUiContainerName = "$appSlug-open-webui"

if (Get-Command docker -ErrorAction SilentlyContinue) {
    $running = docker ps --format "{{.Names}}" | Select-String -Pattern "^$([Regex]::Escape($openWebUiContainerName))$"
    if (-not $running) {
        $exists = docker ps -a --format "{{.Names}}" | Select-String -Pattern "^$([Regex]::Escape($openWebUiContainerName))$"
        if ($exists) {
            docker start $openWebUiContainerName | Out-Null
        }
        else {
            $openWebUiVolumeName = "$appSlug-open-webui-data"
            docker run -d --name $openWebUiContainerName -p "$resolvedOpenWebUiPort`:8080" -e OLLAMA_BASE_URL=http://host.docker.internal:11434 -v "$openWebUiVolumeName`:/app/backend/data" ghcr.io/open-webui/open-webui:main | Out-Null
        }
    }
    Write-Host "[Ç.Kurtoğlu] Docker container: $openWebUiContainerName, Open WebUI Port: $resolvedOpenWebUiPort" -ForegroundColor DarkGray
}

if (Get-Command ollama -ErrorAction SilentlyContinue) {
    $ollamaUp = Get-Process -Name "ollama" -ErrorAction SilentlyContinue
    if (-not $ollamaUp) {
        Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Minimized
        Start-Sleep -Seconds 2
    }

    $configuredModel = "turkce-sabit-lite-v2:latest"
    if (Test-Path (Join-Path $WorkspacePath ".env")) {
        $line = Get-Content (Join-Path $WorkspacePath ".env") | Where-Object { $_ -match '^OLLAMA_MODEL=' } | Select-Object -First 1
        if ($line) {
            $configuredModel = ($line -replace '^OLLAMA_MODEL=', '').Trim()
        }
    }
    $models = ollama list | Out-String
    if ($models -notmatch [Regex]::Escape($configuredModel)) {
        ollama pull $configuredModel | Out-Null
    }
}

# Read PORT from .env
$appPort = 3000
$envPath = Join-Path $WorkspacePath ".env"
if (Test-Path $envPath) {
    $portLine = Get-Content $envPath | Where-Object { $_ -match '^PORT=' } | Select-Object -First 1
    if ($portLine) {
        $parsed = ($portLine -replace '^PORT=', '').Trim()
        if ($parsed -match '^\d+$') { $appPort = [int]$parsed }
    }
}

Start-Process -FilePath "npm.cmd" -ArgumentList "run","start" -WorkingDirectory $WorkspacePath
Write-Host "[Ç.Kurtoğlu] Uygulama baslatiliyor, lutfen bekleyin..." -ForegroundColor Yellow
Start-Sleep -Seconds 12

# Wait for server to be ready (up to 60s)
$ready = $false
for ($i = 0; $i -lt 24; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$appPort/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 2
}

Start-Process "http://localhost:$appPort/admin"
if ($ready) {
    Write-Host "[Ç.Kurtoğlu] WhatsYpzck baslatildi. Admin Panel: http://localhost:$appPort/admin" -ForegroundColor Green
} else {
    Write-Host "[Ç.Kurtoğlu] WhatsYpzck baslatildi (sunucu hazir olmayabilir). Admin Panel: http://localhost:$appPort/admin" -ForegroundColor Yellow
}
