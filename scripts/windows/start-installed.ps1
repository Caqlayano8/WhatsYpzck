# Author: Ç.Kurtoğlu
# Description: VS Code olmadan, portable Node.js + embedded MongoDB ile çalışan launcher.
#              Offline kurulu (EXE ile kurulmuş) ortam için tasarlanmıştır.
#              Port otomatik bulunur, browser açılır.

param(
    [string]$WorkspacePath = ""
)

# WorkspacePath verilmediyse scriptin bulunduğu dizinin iki üstü (scripts\windows\..\..= app root)
if ([string]::IsNullOrWhiteSpace($WorkspacePath)) {
    $WorkspacePath = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

$ErrorActionPreference = "Stop"

# ── Renkli log fonksiyonu ─────────────────────────────────────────────────────
function Log { param([string]$Msg, [string]$Color = "Cyan") Write-Host "[WhatsYpzck] $Msg" -ForegroundColor $Color }
function LogOK  { param([string]$Msg) Write-Host "[WhatsYpzck] ✔ $Msg" -ForegroundColor Green }
function LogWarn { param([string]$Msg) Write-Host "[WhatsYpzck] ⚠ $Msg" -ForegroundColor Yellow }
function LogErr  { param([string]$Msg) Write-Host "[WhatsYpzck] ✘ $Msg" -ForegroundColor Red }

Log "WhatsYpzck başlatılıyor... Uygulama dizini: $WorkspacePath"

if (-not (Test-Path $WorkspacePath)) {
    LogErr "Uygulama dizini bulunamadı: $WorkspacePath"
    exit 1
}

Set-Location $WorkspacePath

# ── Yol sabitleri ─────────────────────────────────────────────────────────────
$runtimeDir   = Join-Path $WorkspacePath "runtime"
$nodeDir      = Join-Path $runtimeDir   "node"
$mongoDir     = Join-Path $runtimeDir   "mongodb"
$mongoDataDir = Join-Path $WorkspacePath "data\mongodb"
$buildFile    = Join-Path $WorkspacePath "build\index.js"
$envFile      = Join-Path $WorkspacePath ".env"
$envExample   = Join-Path $WorkspacePath ".env.default"
$logsDir      = Join-Path $WorkspacePath "logs"

# ── node.exe yolunu belirle ───────────────────────────────────────────────────
$nodeBin = Join-Path $nodeDir "node.exe"
if (-not (Test-Path $nodeBin)) {
    # Portable yoksa sistemdeki node.exe'yi dene
    $sysNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($sysNode) {
        $nodeBin = $sysNode.Source
        LogWarn "Portable Node.js bulunamadı, sistem node.exe kullanılıyor: $nodeBin"
    } else {
        LogErr "Node.js bulunamadı! runtime\node\node.exe klasörüne portable Node.js koyun."
        Read-Host "Devam etmek için ENTER"
        exit 1
    }
} else {
    LogOK "Portable Node.js: $nodeBin"
}

# node.exe klasörünü PATH'e ekle (npm, npx da aynı klasörde)
$env:PATH = "$nodeDir;$env:PATH"

# ── mongod.exe yolunu belirle ─────────────────────────────────────────────────
$mongoBin = Join-Path $mongoDir "bin\mongod.exe"
$mongoUri = "mongodb://localhost:27017/whatsypzck"

if (-not (Test-Path $mongoBin)) {
    # Portable yoksa sistem mongod'u ya da servis
    $sysMongo = Get-Command mongod.exe -ErrorAction SilentlyContinue
    if ($sysMongo) {
        $mongoBin = $sysMongo.Source
        LogWarn "Portable MongoDB bulunamadı, sistem mongod.exe kullanılıyor."
    } else {
        $mongoSvc = Get-Service -Name "MongoDB" -ErrorAction SilentlyContinue
        if ($mongoSvc) {
            if ($mongoSvc.Status -ne 'Running') {
                Start-Service "MongoDB" -ErrorAction SilentlyContinue
                Start-Sleep 3
            }
            LogWarn "Sistem MongoDB servisi kullanılıyor."
            $mongoBin = $null  # servis zaten çalışıyor, process başlatmaya gerek yok
        } else {
            LogErr "MongoDB bulunamadı! runtime\mongodb\bin\mongod.exe klasörüne portable MongoDB koyun."
            Read-Host "Devam etmek için ENTER"
            exit 1
        }
    }
}

# ── MongoDB'yi başlat (portable ise process olarak) ───────────────────────────
if ($mongoBin -and (Test-Path $mongoBin)) {
    # Zaten çalışıyor mu?
    $mongoRunning = $null
    try {
        $mongoRunning = Get-NetTCPConnection -LocalPort 27017 -ErrorAction SilentlyContinue | Select-Object -First 1
    } catch {}

    if (-not $mongoRunning) {
        if (-not (Test-Path $mongoDataDir)) {
            New-Item -ItemType Directory -Path $mongoDataDir -Force | Out-Null
        }
        if (-not (Test-Path $logsDir)) {
            New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
        }
        $mongoLog = Join-Path $logsDir "mongodb.log"
        Log "MongoDB başlatılıyor (embedded)..."
        Start-Process -FilePath $mongoBin `
            -ArgumentList "--dbpath `"$mongoDataDir`" --port 27017 --logpath `"$mongoLog`" --logappend" `
            -WindowStyle Hidden -PassThru | Out-Null
        # MongoDB'nin ayağa kalkmasını bekle
        $mongoReady = $false
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep 1
            try {
                $chk = Get-NetTCPConnection -LocalPort 27017 -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($chk) { $mongoReady = $true; break }
            } catch {}
        }
        if ($mongoReady) { LogOK "MongoDB hazır (port 27017)." }
        else             { LogWarn "MongoDB yanıt vermiyor olabilir, devam ediliyor..." }
    } else {
        LogOK "MongoDB zaten çalışıyor (port 27017)."
    }
}

# ── .env dosyasını hazırla ────────────────────────────────────────────────────
if (-not (Test-Path $envFile)) {
    if (Test-Path $envExample) {
        Copy-Item $envExample $envFile
        LogOK ".env dosyası şablondan oluşturuldu."
    } else {
        # Minimum .env dosyası oluştur
        @"
PORT=3500
NODE_ENV=production
MONGODB_URI=mongodb://localhost:27017/whatsypzck
JWT_SECRET=$(([System.Guid]::NewGuid().ToString() + [System.Guid]::NewGuid().ToString()) -replace '-','')
ENCRYPTION_MASTER_KEY=$(([System.Guid]::NewGuid().ToString("N") + [System.Guid]::NewGuid().ToString("N")).Substring(0,64))
DEFAULT_ADMIN_USER=admin
DEFAULT_ADMIN_PASS=Admin123!
LICENSE_ALLOW_UNLICENSED=true
BOT_AUTO_START=true
"@ | Set-Content $envFile -Encoding UTF8
        LogOK "Minimum .env dosyası oluşturuldu."
    }
}

# MONGODB_URI'yi güncelle
$lines = Get-Content $envFile
$lines = $lines | Where-Object { $_ -notmatch '^MONGODB_URI=' }
$lines += "MONGODB_URI=$mongoUri"
Set-Content -Path $envFile -Value $lines -Encoding UTF8

# ── Boş port bul ─────────────────────────────────────────────────────────────
function Test-PortFree { param([int]$Port)
    try { return $null -eq (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1) }
    catch { return $true }
}

# .env'deki PORT değerini oku
$preferredPort = 3500
$portLine = Get-Content $envFile | Where-Object { $_ -match '^PORT=' } | Select-Object -First 1
if ($portLine) {
    $pp = ($portLine -replace '^PORT=', '').Trim()
    if ($pp -match '^\d+$') { $preferredPort = [int]$pp }
}

$actualPort = $preferredPort
while (-not (Test-PortFree -Port $actualPort)) {
    $actualPort++
}

if ($actualPort -ne $preferredPort) {
    LogWarn "Port $preferredPort meşgul, $actualPort kullanılıyor."
    # .env'i güncelle
    $envLines = Get-Content $envFile
    $envLines = $envLines | Where-Object { $_ -notmatch '^PORT=' }
    $envLines += "PORT=$actualPort"
    Set-Content -Path $envFile -Value $envLines -Encoding UTF8
}

# ── PUPPETEER_EXECUTABLE_PATH belirle ────────────────────────────────────────
$puppeteerChromium = ""

# 1. runtime\chromium\ içinde ara
$chromiumRuntime = Join-Path $runtimeDir "chromium\chrome.exe"
if (-not (Test-Path $chromiumRuntime)) {
    $chromiumRuntime = Join-Path $runtimeDir "chromium\chromium.exe"
}
if (Test-Path $chromiumRuntime) {
    $puppeteerChromium = $chromiumRuntime
}

# 2. Puppeteer cache'ine bak (node_modules içinde)
if ([string]::IsNullOrEmpty($puppeteerChromium)) {
    $puppeteerCacheBase = Join-Path $WorkspacePath ".local-chromium"
    if (-not (Test-Path $puppeteerCacheBase)) {
        $puppeteerCacheBase = Join-Path $env:LOCALAPPDATA "puppeteer\chrome"
    }
    if (Test-Path $puppeteerCacheBase) {
        $chromeExe = Get-ChildItem -Path $puppeteerCacheBase -Filter "chrome.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($chromeExe) { $puppeteerChromium = $chromeExe.FullName }
    }
}

# 3. Sistem Chrome
if ([string]::IsNullOrEmpty($puppeteerChromium)) {
    $sysChromes = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles\Chromium\Application\chrome.exe"
    )
    foreach ($c in $sysChromes) {
        if (Test-Path $c) { $puppeteerChromium = $c; break }
    }
}

if (-not [string]::IsNullOrEmpty($puppeteerChromium)) {
    $envLines = Get-Content $envFile
    $envLines = $envLines | Where-Object { $_ -notmatch '^PUPPETEER_EXECUTABLE_PATH=' }
    $envLines += "PUPPETEER_EXECUTABLE_PATH=$puppeteerChromium"
    Set-Content -Path $envFile -Value $envLines -Encoding UTF8
    LogOK "Chromium: $puppeteerChromium"
} else {
    LogWarn "Chromium/Chrome bulunamadı. WhatsApp QR taraması çalışmayabilir."
}

# ── build/index.js var mı? ────────────────────────────────────────────────────
if (-not (Test-Path $buildFile)) {
    LogWarn "build\index.js bulunamadı — npm run build çalıştırılıyor..."
    $npmCmd = Join-Path $nodeDir "npm.cmd"
    if (-not (Test-Path $npmCmd)) { $npmCmd = "npm.cmd" }
    if (-not (Test-Path (Join-Path $WorkspacePath "node_modules"))) {
        Log "npm install çalıştırılıyor (internet bağlantısı gerekebilir)..."
        & $npmCmd install --prefix $WorkspacePath
    }
    & $npmCmd run build --prefix $WorkspacePath
    if (-not (Test-Path $buildFile)) {
        LogErr "build\index.js oluşturulamadı. Build başarısız."
        Read-Host "Devam etmek için ENTER"
        exit 1
    }
}

# ── Uygulamayı başlat ─────────────────────────────────────────────────────────
Log "Uygulama başlatılıyor (port $actualPort)..."

$env:PORT               = $actualPort
$env:NODE_ENV           = "production"
$env:MONGODB_URI        = $mongoUri
if (-not [string]::IsNullOrEmpty($puppeteerChromium)) {
    $env:PUPPETEER_EXECUTABLE_PATH = $puppeteerChromium
}

$appProc = Start-Process -FilePath $nodeBin `
    -ArgumentList "`"$buildFile`"" `
    -WorkingDirectory $WorkspacePath `
    -PassThru `
    -WindowStyle Minimized

LogOK "Uygulama PID: $($appProc.Id)"

# ── Uygulamanın hazır olmasını bekle ─────────────────────────────────────────
Log "Sunucu hazır bekleniyor (max 60s)..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep 2
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$actualPort/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
}

# ── Browser aç ────────────────────────────────────────────────────────────────
$adminUrl = "http://localhost:$actualPort/admin"
Start-Process $adminUrl

if ($ready) {
    LogOK "WhatsYpzck hazır → $adminUrl"
} else {
    LogWarn "WhatsYpzck başlatıldı ama health check yanıt vermedi → $adminUrl"
}

Write-Host ""
Write-Host "════════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host "  Admin Paneli : http://localhost:$actualPort/admin" -ForegroundColor White
Write-Host "  Panel        : http://localhost:$actualPort/panel" -ForegroundColor White
Write-Host "  QR Kod       : http://localhost:$actualPort/qr" -ForegroundColor White
Write-Host "  Durdurmak için bu pencereyi kapatın veya Ctrl+C" -ForegroundColor DarkGray
Write-Host "════════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host ""

# Pencereyi açık tut, uygulama bitene kadar bekle
if ($appProc) {
    $appProc.WaitForExit()
}
