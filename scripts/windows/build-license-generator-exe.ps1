# Author: C.Kurtoglu
# Description: Packages license-generator-app.ps1 into a standalone .exe using IExpress.

param(
    [string]$WorkspacePath = "C:\Users\34116\Documents\GitHub\Projelerim\WhatsYpzck",
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $WorkspacePath)) {
    throw "Workspace bulunamadi: $WorkspacePath"
}

Set-Location $WorkspacePath

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $WorkspacePath "dist-tools"
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$inputPs1 = Join-Path $WorkspacePath "scripts\windows\license-generator-app.ps1"
$outputExe = Join-Path $OutputDir "WhatsYpzck-License-Generator.exe"

if (-not (Test-Path $inputPs1)) {
    throw "Kaynak dosya bulunamadi: $inputPs1"
}

if (-not (Get-Command iexpress.exe -ErrorAction SilentlyContinue)) {
    throw "IExpress bulunamadi. Windows IExpress gerekli."
}

$tempDir = Join-Path $OutputDir "iex-temp"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

$bootstrapCmd = Join-Path $tempDir "run-license-generator.cmd"
$payloadPs1 = Join-Path $tempDir "license-generator-app.ps1"
$sedPath = Join-Path $tempDir "license-generator.sed"

Copy-Item -Path $inputPs1 -Destination $payloadPs1 -Force

$cmdContent = @"
@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0license-generator-app.ps1"
"@
Set-Content -Path $bootstrapCmd -Value $cmdContent -Encoding ASCII

$sedContent = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$outputExe
FriendlyName=WhatsYpzck License Generator
AppLaunched=run-license-generator.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[SourceFiles]
SourceFiles0=$tempDir
[SourceFiles0]
%FILE0%=license-generator-app.ps1
%FILE1%=run-license-generator.cmd
[Strings]
FILE0=license-generator-app.ps1
FILE1=run-license-generator.cmd
"@
Set-Content -Path $sedPath -Value $sedContent -Encoding ASCII

Write-Host "[LicenseApp] EXE paketi olusturuluyor (IExpress)..." -ForegroundColor Cyan
Start-Process -FilePath "iexpress.exe" -ArgumentList "/N", "/Q", $sedPath -Wait

if (-not (Test-Path $outputExe)) {
    throw "EXE olusturulamadi: $outputExe"
}

Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[LicenseApp] Tamamlandi: $outputExe" -ForegroundColor Green
