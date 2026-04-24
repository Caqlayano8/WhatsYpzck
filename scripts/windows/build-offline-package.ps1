# Author: Ç.Kurtoğlu
# Description: WhatsYpzck offline kurulum EXE'si hazırlar.
#              1) Portable Node.js LTS indirir/çıkarır  (installer\redist\node\)
#              2) Portable MongoDB indirir/çıkarır       (installer\redist\mongodb\)
#              3) Puppeteer Chromium indirir/çıkarır     (installer\redist\chromium\)
#              4) npm install + npm run build (esbuild)
#              5) Inno Setup ile EXE derler              (installer\output\)

param(
    [string]$WorkspacePath   = "",
    [string]$InnoSetupPath   = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    [string]$NodeVersion     = "22.14.0",
    [string]$MongoVersion    = "8.0.6",
    [switch]$SkipNodeDownload,
    [switch]$SkipMongoDownload,
    [switch]$SkipChromiumDownload,
    [switch]$SkipBuild,
    [switch]$SkipInnoSetup
)

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) {
    $WorkspacePath = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

$ErrorActionPreference = "Stop"

function Log    { param([string]$M, [string]$C="Cyan")   Write-Host "[BUILD] $M" -ForegroundColor $C }
function LogOK  { param([string]$M)  Write-Host "[BUILD] ✔ $M" -ForegroundColor Green }
function LogWarn{ param([string]$M)  Write-Host "[BUILD] ⚠ $M" -ForegroundColor Yellow }
function LogErr { param([string]$M)  Write-Host "[BUILD] ✘ $M" -ForegroundColor Red }

Log "== WhatsYpzck Offline Package Builder =="
Log "Workspace: $WorkspacePath"

$redistDir    = Join-Path $WorkspacePath  "installer\redist"
$nodeRedist   = Join-Path $redistDir      "node"
$mongoRedist  = Join-Path $redistDir      "mongodb"
$chromRedist  = Join-Path $redistDir      "chromium"
$issFile      = Join-Path $WorkspacePath  "installer\WhatsYpzck-LocalOffline.iss"
$outputDir    = Join-Path $WorkspacePath  "installer\output"

foreach ($d in @($redistDir, $nodeRedist, $mongoRedist, $chromRedist, $outputDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# ── 1. Portable Node.js ───────────────────────────────────────────────────────
if (-not $SkipNodeDownload) {
    $nodeExe = Join-Path $nodeRedist "node.exe"
    if (Test-Path $nodeExe) {
        LogOK "Portable Node.js zaten mevcut: $nodeExe"
    } else {
        Log "Node.js $NodeVersion portable indiriliyor..."
        $nodeZipUrl  = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
        $nodeZipPath = Join-Path $redistDir "node-portable.zip"
        $nodeExtract = Join-Path $redistDir "node-extract"

        try {
            Invoke-WebRequest -Uri $nodeZipUrl -OutFile $nodeZipPath -UseBasicParsing
            if (Test-Path $nodeExtract) { Remove-Item $nodeExtract -Recurse -Force }
            Expand-Archive -Path $nodeZipPath -DestinationPath $nodeExtract -Force

            # İçindeki node-vXX-win-x64 klasörünü redist\node\ olarak kopyala
            $extracted = Get-ChildItem $nodeExtract -Directory | Select-Object -First 1
            if ($extracted) {
                if (Test-Path $nodeRedist) { Remove-Item $nodeRedist -Recurse -Force }
                Move-Item $extracted.FullName $nodeRedist
                LogOK "Portable Node.js hazır: $nodeRedist"
            }
            Remove-Item $nodeZipPath -Force -ErrorAction SilentlyContinue
            Remove-Item $nodeExtract -Recurse -Force -ErrorAction SilentlyContinue
        } catch {
            LogWarn "Node.js indirilemedi: $_"
            LogWarn "Manuel: $nodeZipUrl adresinden indirip installer\redist\node\ klasörüne çıkarın."
        }
    }
}

# ── 2. Portable MongoDB ───────────────────────────────────────────────────────
if (-not $SkipMongoDownload) {
    $mongodExe = Join-Path $mongoRedist "bin\mongod.exe"
    if (Test-Path $mongodExe) {
        LogOK "Portable MongoDB zaten mevcut: $mongodExe"
    } else {
        Log "MongoDB $MongoVersion portable indiriliyor..."
        $mongoZipUrl  = "https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-$MongoVersion.zip"
        $mongoZipPath = Join-Path $redistDir "mongodb-portable.zip"
        $mongoExtract = Join-Path $redistDir "mongodb-extract"

        try {
            Invoke-WebRequest -Uri $mongoZipUrl -OutFile $mongoZipPath -UseBasicParsing
            if (Test-Path $mongoExtract) { Remove-Item $mongoExtract -Recurse -Force }
            Expand-Archive -Path $mongoZipPath -DestinationPath $mongoExtract -Force

            $extracted = Get-ChildItem $mongoExtract -Directory | Select-Object -First 1
            if ($extracted) {
                if (Test-Path $mongoRedist) { Remove-Item $mongoRedist -Recurse -Force }
                Move-Item $extracted.FullName $mongoRedist
                LogOK "Portable MongoDB hazır: $mongoRedist"
            }
            Remove-Item $mongoZipPath -Force -ErrorAction SilentlyContinue
            Remove-Item $mongoExtract -Recurse -Force -ErrorAction SilentlyContinue
        } catch {
            LogWarn "MongoDB indirilemedi: $_"
            LogWarn "Manuel: $mongoZipUrl adresinden indirip installer\redist\mongodb\ klasörüne çıkarın."
        }
    }
}

# ── 3. Puppeteer Chromium ─────────────────────────────────────────────────────
if (-not $SkipChromiumDownload) {
    $chromExe = Join-Path $chromRedist "chrome.exe"
    if (-not (Test-Path $chromExe)) {
        $chromExe = Join-Path $chromRedist "chromium.exe"
    }
    if (Test-Path $chromExe) {
        LogOK "Chromium zaten mevcut."
    } else {
        # Puppeteer'in kendi cache'ini al
        Log "Puppeteer Chromium aranıyor (puppeteer install)..."
        $nodeExeForNpm = Join-Path $nodeRedist "node.exe"
        if (-not (Test-Path $nodeExeForNpm)) { $nodeExeForNpm = "node.exe" }

        # Sistemde npm varsa puppeteer'in chromium'unu indir
        try {
            $env:PUPPETEER_CACHE_DIR = $chromRedist
            Push-Location $WorkspacePath
            & $nodeExeForNpm -e "const puppeteer = require('puppeteer'); puppeteer.executablePath();" 2>$null | Out-Null

            # Puppeteer cache konumunu bul
            $cacheLocations = @(
                (Join-Path $env:LOCALAPPDATA "puppeteer\chrome"),
                (Join-Path $WorkspacePath ".local-chromium"),
                (Join-Path $WorkspacePath "node_modules\puppeteer\.local-chromium"),
                (Join-Path $WorkspacePath "node_modules\puppeteer-core\.local-chromium")
            )
            foreach ($loc in $cacheLocations) {
                $foundChrome = Get-ChildItem -Path $loc -Filter "chrome.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($foundChrome) {
                    # Chromium klasörünü kopyala
                    $chromBaseDir = $foundChrome.DirectoryName
                    Log "Chromium bulundu: $chromBaseDir → kopyalanıyor..."
                    Copy-Item -Path "$chromBaseDir\*" -Destination $chromRedist -Recurse -Force
                    LogOK "Chromium hazır: $chromRedist"
                    break
                }
            }
            Pop-Location
        } catch {
            LogWarn "Chromium otomatik kopyalanamadı."
        }

        if (-not (Test-Path $chromExe)) {
            LogWarn "Chromium bulunamadı. Sistem Chrome kullanılacak (kurulumda gerekli)."
            LogWarn "Veya: https://chromium.woolyss.com adresinden indirip installer\redist\chromium\ klasörüne koyun."
        }
    }
}

# ── 4. npm install + esbuild ──────────────────────────────────────────────────
if (-not $SkipBuild) {
    $nodeExeForBuild = Join-Path $nodeRedist "node.exe"
    if (-not (Test-Path $nodeExeForBuild)) { $nodeExeForBuild = "node.exe" }

    $npmCmd = Join-Path $nodeRedist "npm.cmd"
    if (-not (Test-Path $npmCmd)) { $npmCmd = "npm.cmd" }

    Push-Location $WorkspacePath

    if (-not (Test-Path (Join-Path $WorkspacePath "node_modules"))) {
        Log "npm install çalıştırılıyor..."
        & $npmCmd install
    } else {
        LogOK "node_modules mevcut, install atlandı."
    }

    Log "esbuild (npm run build) çalıştırılıyor..."
    & $npmCmd run build

    if (Test-Path (Join-Path $WorkspacePath "build\index.js")) {
        LogOK "build\index.js oluşturuldu."
    } else {
        LogErr "build\index.js oluşturulamadı! Build başarısız."
        Pop-Location
        exit 1
    }

    Pop-Location
}

# ── 5. Inno Setup EXE derle ───────────────────────────────────────────────────
if (-not $SkipInnoSetup) {
    if (-not (Test-Path $InnoSetupPath)) {
        # 32-bit veya 64-bit konumu dene
        $altPaths = @(
            "C:\Program Files\Inno Setup 6\ISCC.exe",
            "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
        )
        foreach ($alt in $altPaths) {
            if (Test-Path $alt) { $InnoSetupPath = $alt; break }
        }
    }

    if (-not (Test-Path $InnoSetupPath)) {
        LogWarn "Inno Setup bulunamadı: $InnoSetupPath"
        LogWarn "İndirmek için: https://jrsoftware.org/isdl.php"
        LogWarn "Kurumdan sonra bu scripti tekrar çalıştırın veya -SkipInnoSetup ekleyin."
    } else {
        if (-not (Test-Path $issFile)) {
            LogErr ".iss dosyası bulunamadı: $issFile"
            exit 1
        }
        Log "Inno Setup derleniyor: $issFile"
        & $InnoSetupPath $issFile "/DMyOutputDir=$outputDir"
        if ($LASTEXITCODE -eq 0) {
            $exeFile = Get-ChildItem $outputDir -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            LogOK "EXE oluşturuldu: $($exeFile.FullName)"
        } else {
            LogErr "Inno Setup derleme başarısız (exit code: $LASTEXITCODE)"
            exit 1
        }
    }
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host "  Build tamamlandı." -ForegroundColor White
Write-Host "  EXE konumu : installer\output\" -ForegroundColor White
Write-Host "  Test için  : launch.bat çift tıklayın" -ForegroundColor White
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor DarkCyan
