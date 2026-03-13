# Author: Ç.Kurtoğlu
# Description: Creates desktop launcher scripts for setup and one-click start

param(
    [string]$WorkspacePath = "C:\Users\34116\Documents\GitHub\Projelerim\WhatsYpzck",
    [string]$DesktopPath = "$env:USERPROFILE\Desktop"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $WorkspacePath)) {
    throw "Workspace bulunamadi: $WorkspacePath"
}

if (-not (Test-Path $DesktopPath)) {
    throw "Desktop bulunamadi: $DesktopPath"
}

$setupBat = @"
@echo off
powershell -ExecutionPolicy Bypass -File "$WorkspacePath\scripts\windows\setup-whatsypzck.ps1"
"@

$startBat = @"
@echo off
powershell -ExecutionPolicy Bypass -File "$WorkspacePath\scripts\windows\start-whatsypzck.ps1"
"@

$adminBat = @"
@echo off
start http://localhost:3000/admin/login
"@

Set-Content -Path (Join-Path $DesktopPath "WhatsYpzck-Setup-C.Kurtoglu.bat") -Value $setupBat -Encoding ASCII
Set-Content -Path (Join-Path $DesktopPath "WhatsYpzck-Baslat-C.Kurtoglu.bat") -Value $startBat -Encoding ASCII
Set-Content -Path (Join-Path $DesktopPath "WhatsYpzck-Admin-Login-C.Kurtoglu.bat") -Value $adminBat -Encoding ASCII

Write-Host "[Ç.Kurtoğlu] Masaustu dosyalari olusturuldu." -ForegroundColor Green
