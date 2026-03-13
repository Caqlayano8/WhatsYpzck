# Author: Ç.Kurtoğlu
# Description: One-time setup for WhatsYpzck + local AI stack on Windows

param(
    [string]$WorkspacePath = "C:\Users\34116\Documents\GitHub\Projelerim\WhatsYpzck",
    [string]$LicenseAllowUnlicensed = ""
)

$ErrorActionPreference = "Stop"

Write-Host "[Ç.Kurtoğlu] WhatsYpzck setup baslatildi..." -ForegroundColor Cyan

function Set-OrReplaceEnvValue {
    param(
        [string]$FilePath,
        [string]$Key,
        [string]$Value
    )

    $lines = @()
    if (Test-Path $FilePath) {
        $lines = Get-Content $FilePath
    }

    $updated = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^$Key=") {
            $lines[$i] = "$Key=$Value"
            $updated = $true
            break
        }
    }

    if (-not $updated) {
        $lines += "$Key=$Value"
    }

    Set-Content -Path $FilePath -Value $lines -Encoding UTF8
}

function Ensure-WingetPackage {
    param(
        [string]$PackageId,
        [string]$Title
    )

    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "winget bulunamadi. Full kurulum icin App Installer/winget gerekli."
    }

    Write-Host "[Ç.Kurtoğlu] $Title kuruluyor..." -ForegroundColor Cyan
    winget install --id $PackageId -e --accept-source-agreements --accept-package-agreements --silent
}

function Resolve-NpmCmdPath {
    if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
        return "npm.cmd"
    }

    $candidates = @(
        "$env:ProgramFiles\nodejs\npm.cmd",
        "${env:ProgramFiles(x86)}\nodejs\npm.cmd",
        "$env:LOCALAPPDATA\Programs\nodejs\npm.cmd"
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    return ""
}

function Resolve-ChromePath {
    $candidates = @(
        "C:\Program Files\Google\Chrome\Application\chrome.exe",
        "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    return ""
}

function Get-EnvValue {
    param(
        [string]$FilePath,
        [string]$Key,
        [string]$Default = ""
    )

    if (-not (Test-Path $FilePath)) {
        return $Default
    }

    $line = Get-Content $FilePath | Where-Object { $_ -match "^$Key=" } | Select-Object -First 1
    if (-not $line) {
        return $Default
    }

    return ($line -replace "^$Key=", "").Trim()
}

if (-not (Test-Path $WorkspacePath)) {
    throw "Workspace bulunamadi: $WorkspacePath"
}

Set-Location $WorkspacePath

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Ensure-WingetPackage -PackageId "OpenJS.NodeJS.LTS" -Title "Node.js LTS"
}

if (-not (Get-Command mongod -ErrorAction SilentlyContinue)) {
    Ensure-WingetPackage -PackageId "MongoDB.Server" -Title "MongoDB Server"
}

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Ensure-WingetPackage -PackageId "Ollama.Ollama" -Title "Ollama"
}

$chromePath = Resolve-ChromePath
if ([string]::IsNullOrWhiteSpace($chromePath)) {
    Ensure-WingetPackage -PackageId "Google.Chrome" -Title "Google Chrome"
    $chromePath = Resolve-ChromePath
}

$npmCmd = Resolve-NpmCmdPath
if ([string]::IsNullOrWhiteSpace($npmCmd)) {
    throw "npm bulunamadi. Node.js kurulduysa terminali yeniden acip setup'i tekrar calistirin."
}

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "[Ç.Kurtoğlu] .env dosyasi .env.example uzerinden olusturuldu." -ForegroundColor Yellow
}

if (-not [string]::IsNullOrWhiteSpace($chromePath)) {
    Set-OrReplaceEnvValue -FilePath (Join-Path $WorkspacePath ".env") -Key "PUPPETEER_EXECUTABLE_PATH" -Value $chromePath
    Write-Host "[Ç.Kurtoğlu] Chrome yolu .env icine yazildi: $chromePath" -ForegroundColor Yellow
} else {
    Write-Host "[Ç.Kurtoğlu] Chrome yolu tespit edilemedi, PUPPETEER_EXECUTABLE_PATH'i manuel kontrol edin." -ForegroundColor Yellow
}

try {
    $mongoService = Get-Service -Name "MongoDB" -ErrorAction SilentlyContinue
    if ($mongoService) {
        Set-Service -Name "MongoDB" -StartupType Automatic
        if ($mongoService.Status -ne 'Running') {
            Start-Service -Name "MongoDB"
        }
        Write-Host "[Ç.Kurtoğlu] MongoDB servisi aktif." -ForegroundColor Green
    }
} catch {
    Write-Host "[Ç.Kurtoğlu] MongoDB servisi otomatik baslatilamadi. Elle kontrol edin." -ForegroundColor Yellow
}

if (-not [string]::IsNullOrWhiteSpace($LicenseAllowUnlicensed)) {
    $envPath = Join-Path $WorkspacePath ".env"
    $envLines = @()
    if (Test-Path $envPath) {
        $envLines = Get-Content $envPath | Where-Object { $_ -notmatch '^LICENSE_ALLOW_UNLICENSED=' }
    }

    $envLines += "LICENSE_ALLOW_UNLICENSED=$LicenseAllowUnlicensed"
    Set-Content -Path $envPath -Value $envLines -Encoding UTF8
    Write-Host "[Ç.Kurtoğlu] LICENSE_ALLOW_UNLICENSED=$LicenseAllowUnlicensed olarak ayarlandi." -ForegroundColor Yellow
}

Write-Host "[Ç.Kurtoğlu] npm bagimliliklari yukleniyor..." -ForegroundColor Cyan
& $npmCmd install

Write-Host "[Ç.Kurtoğlu] Tip kontrolu calistiriliyor..." -ForegroundColor Cyan
& $npmCmd run type-check

if (Get-Command docker -ErrorAction SilentlyContinue) {
    Write-Host "[Ç.Kurtoğlu] Open WebUI konteyneri hazirlaniyor..." -ForegroundColor Cyan

    docker rm -f open-webui 2>$null | Out-Null
    docker run -d --name open-webui -p 3001:8080 -e OLLAMA_BASE_URL=http://host.docker.internal:11434 -v open-webui:/app/backend/data ghcr.io/open-webui/open-webui:main | Out-Null
}
else {
    Write-Host "[Ç.Kurtoğlu] Docker bulunamadi, Open WebUI adimi atlandi." -ForegroundColor Yellow
}

if (Get-Command ollama -ErrorAction SilentlyContinue) {
    Write-Host "[Ç.Kurtoğlu] Ollama model kontrolu..." -ForegroundColor Cyan
    $envPath = Join-Path $WorkspacePath ".env"
    $configuredModel = Get-EnvValue -FilePath $envPath -Key "OLLAMA_MODEL" -Default "turkce-sabit-lite-v2:latest"
    $models = ollama list | Out-String
    if ($models -notmatch [Regex]::Escape($configuredModel)) {
        ollama pull $configuredModel
    }
}
else {
    Write-Host "[Ç.Kurtoğlu] Ollama bulunamadi, model adimi atlandi." -ForegroundColor Yellow
}

Write-Host "[Ç.Kurtoğlu] Masaustu kisayollari olusturuluyor..." -ForegroundColor Cyan
powershell -ExecutionPolicy Bypass -File "$WorkspacePath\scripts\windows\create-desktop-shortcuts.ps1" -WorkspacePath $WorkspacePath

Write-Host "[Ç.Kurtoğlu] Setup tamamlandi." -ForegroundColor Green
Write-Host "[Ç.Kurtoğlu] Calistirmak icin: npm run start:windows" -ForegroundColor Green
