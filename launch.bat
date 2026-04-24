@echo off
:: WhatsYpzck - Tek Tiklama Baslat
:: VS Code, terminal veya teknik bilgi gerekmez.
:: Ç.Kurtoğlu tarafından geliştirildi.

title WhatsYpzck - Baslatiliyor...

:: Yonetici izni iste (MongoDB icin gerekebilir)
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [WhatsYpzck] Yonetici izni isteniyor...
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

:: Scriptin oldugu klasoru bul (launch.bat uygulama kokunde olmali)
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

set "PS_SCRIPT=%APP_DIR%\scripts\windows\start-installed.ps1"

if not exist "%PS_SCRIPT%" (
    echo [WhatsYpzck] HATA: start-installed.ps1 bulunamadi!
    echo Beklenen konum: %PS_SCRIPT%
    pause
    exit /b 1
)

title WhatsYpzck - Calisiyor...
powershell.exe -ExecutionPolicy Bypass -NoLogo -File "%PS_SCRIPT%" -WorkspacePath "%APP_DIR%"

if %errorlevel% neq 0 (
    echo.
    echo [WhatsYpzck] Uygulama kapandi veya hata olustu.
    pause
)
