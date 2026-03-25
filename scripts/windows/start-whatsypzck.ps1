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

if (Get-Command docker -ErrorAction SilentlyContinue) {
    $running = docker ps --format "{{.Names}}" | Select-String -Pattern "^open-webui$"
    if (-not $running) {
        $exists = docker ps -a --format "{{.Names}}" | Select-String -Pattern "^open-webui$"
        if ($exists) {
            docker start open-webui | Out-Null
        }
        else {
            docker run -d --name open-webui -p 3001:8080 -e OLLAMA_BASE_URL=http://host.docker.internal:11434 -v open-webui:/app/backend/data ghcr.io/open-webui/open-webui:main | Out-Null
        }
    }
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
