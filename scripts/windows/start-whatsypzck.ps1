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

Start-Process -FilePath "npm.cmd" -ArgumentList "run","start" -WorkingDirectory $WorkspacePath
Start-Sleep -Seconds 2
Start-Process "http://localhost:3000/admin/login"
Start-Process "http://localhost:3000/status"
Write-Host "[Ç.Kurtoğlu] WhatsYpzck baslatildi. WebUI: http://localhost:3001" -ForegroundColor Green
