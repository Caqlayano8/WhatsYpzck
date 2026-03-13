# Author: C.Kurtoglu
# Description: Builds two Windows installers (licensed/unlicensed) with Inno Setup.

param(
    [string]$WorkspacePath = "C:\Users\34116\Documents\GitHub\Projelerim\WhatsYpzck",
    [string]$LicensedLicenseFile = "",
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

function Remove-LegacySetupFiles {
    param(
        [string]$TargetDir
    )

    $legacyFiles = @(
        "WhatsYpzck-Licensed-Setup.exe",
        "WhatsYpzck-Unlicensed-Setup.exe"
    )

    foreach ($file in $legacyFiles) {
        $path = Join-Path $TargetDir $file
        if (Test-Path $path) {
            try {
                Remove-Item -Path $path -Force
                Write-Host "[Installer] Eski setup temizlendi: $file" -ForegroundColor DarkGray
            } catch {
                Write-Host "[Installer] Eski setup silinemedi (dosya kullanimda olabilir): $file" -ForegroundColor Yellow
            }
        }
    }
}

if (-not (Test-Path $WorkspacePath)) {
    throw "Workspace bulunamadi: $WorkspacePath"
}

Set-Location $WorkspacePath

$desktop = [Environment]::GetFolderPath("Desktop")
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $desktop "WhatsYpzck-Installers"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
Remove-LegacySetupFiles -TargetDir $OutputDir

$innoCandidates = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
)
$innoCompiler = $innoCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $innoCompiler) {
    throw "Inno Setup 6 bulunamadi. https://jrsoftware.org/isdl.php adresinden kurun."
}

Write-Host "[Installer] Build basladi..." -ForegroundColor Cyan
npm.cmd install
npm.cmd run build

$licensedIss = Join-Path $WorkspacePath "installer\WhatsYpzck-Licensed.iss"
$unlicensedIss = Join-Path $WorkspacePath "installer\WhatsYpzck-Unlicensed.iss"

if (-not (Test-Path $licensedIss) -or -not (Test-Path $unlicensedIss)) {
    throw "installer klasorundeki .iss dosyalari eksik."
}

& $innoCompiler "/DMyOutputDir=$OutputDir" $unlicensedIss | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "Unlicensed installer derleme basarisiz oldu."
}

if (-not [string]::IsNullOrWhiteSpace($LicensedLicenseFile)) {
    if (-not (Test-Path $LicensedLicenseFile)) {
        throw "Lisans dosyasi bulunamadi: $LicensedLicenseFile"
    }

    & $innoCompiler "/DMyOutputDir=$OutputDir" "/DMyLicenseFile=$LicensedLicenseFile" $licensedIss | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Licensed installer derleme basarisiz oldu."
    }
} else {
    Write-Host "[Installer] Lisansli paket atlandi. -LicensedLicenseFile parametresi verin." -ForegroundColor Yellow
}

$generatorPs1Source = Join-Path $WorkspacePath "scripts\windows\license-generator-app.ps1"
$generatorExeBuildScript = Join-Path $WorkspacePath "scripts\windows\build-license-generator-exe.ps1"
$generatorExeSource = Join-Path $WorkspacePath "dist-tools\WhatsYpzck-License-Generator.exe"
$generatorExeDest = Join-Path $OutputDir "WhatsYpzck-License-Generator.exe"
$generatorPs1Dest = Join-Path $OutputDir "WhatsYpzck-License-Generator.ps1"
$generatorBatDest = Join-Path $OutputDir "WhatsYpzck-License-Generator.bat"

$generatorAdded = $false

if (Test-Path $generatorExeBuildScript) {
    try {
        & powershell -ExecutionPolicy Bypass -File $generatorExeBuildScript -WorkspacePath $WorkspacePath -OutputDir (Join-Path $WorkspacePath "dist-tools") | Out-Host
        if (Test-Path $generatorExeSource) {
            Copy-Item -Path $generatorExeSource -Destination $generatorExeDest -Force
            Write-Host "[Installer] Lisans uretici EXE eklendi." -ForegroundColor Green
            $generatorAdded = $true
        }
    } catch {
        Write-Host "[Installer] Lisans uretici EXE olusturulamadi, PS1 fallback kullanilacak." -ForegroundColor Yellow
    }
}

if (-not $generatorAdded -and (Test-Path $generatorPs1Source)) {
    Copy-Item -Path $generatorPs1Source -Destination $generatorPs1Dest -Force
    $launcher = @"
@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0WhatsYpzck-License-Generator.ps1" -WorkspacePath "$WorkspacePath"
"@
    Set-Content -Path $generatorBatDest -Value $launcher -Encoding ASCII
    Write-Host "[Installer] Lisans uretici uygulamasi (PS1) cikti klasorune eklendi." -ForegroundColor Green
} elseif (-not $generatorAdded) {
    Write-Host "[Installer] Lisans uretici kaynagi bulunamadi: $generatorPs1Source" -ForegroundColor Yellow
}

Remove-LegacySetupFiles -TargetDir $OutputDir

Write-Host "[Installer] Tamamlandi. Cikti klasoru: $OutputDir" -ForegroundColor Green
