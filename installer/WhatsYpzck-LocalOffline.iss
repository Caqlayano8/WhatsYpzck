; Author: Ç.Kurtoğlu
; Description: WhatsYpzck - Tam Offline Kurulum EXE
;              Portable Node.js + Portable MongoDB + App dosyalarını
;              hedef makineye kurar. VS Code, Git, npm bilgisi gerekmez.
;
; Önce build-offline-package.ps1 çalıştırın:
;   .\scripts\windows\build-offline-package.ps1
;
; Oluşturulan EXE'yi çift tıklayarak kurulum yapın.

#define MyAppName     "WhatsYpzck"
#define MyAppVersion  "2.0.0"
#define MyAppPublisher "C.Kurtoglu"
#define MyAppURL      "https://github.com/CaqlayanKurtoglu/WhatsYpzck"

#ifndef MyOutputDir
  #define MyOutputDir "output"
#endif

[Setup]
AppId={{A3F72E81-4D9C-4B5A-9C2D-1F8E6A3B7D55}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\WhatsYpzck
DefaultGroupName=WhatsYpzck
OutputDir={#MyOutputDir}
OutputBaseFilename=WhatsYpzck-Offline-Kurulum-Setup-v{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64
MinVersion=10.0
SetupLogging=yes
; Yönetici izni gereksin (MongoDB + veri dizini oluşturma için)
PrivilegesRequired=admin
; Kurulum sırasında eski sürümü kaldırma
UninstallDisplayIcon={app}\launch.bat
CloseApplications=yes

[Languages]
Name: "tr"; MessagesFile: "compiler:Languages\Turkish.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Messages]
; Türkçe kurulum mesajları
tr.BeveledLabel=WhatsYpzck Kurulumu

[Tasks]
Name: "desktopicon";    Description: "Masaüstüne kısayol oluştur";   GroupDescription: "Ek kısayollar:"; Flags: unchecked
Name: "startmenuicon";  Description: "Başlat menüsüne ekle";          GroupDescription: "Ek kısayollar:"

[Dirs]
; Veri ve log dizinleri önceden oluşturul
Name: "{app}\data\mongodb"
Name: "{app}\logs"
Name: "{app}\runtime"
Name: "{app}\runtime\node"
Name: "{app}\runtime\mongodb"
Name: "{app}\runtime\chromium"
Name: "{app}\public\uploads\incident-images"
Name: "{app}\public\uploads\incident-status-media"
Name: "{app}\public\reports\incidents"
Name: "{app}\build"
Name: "{app}\views"
Name: "{app}\licenses"

; ── Uygulama Dosyaları ────────────────────────────────────────────────────────
[Files]

; Derlenmiş uygulama (esbuild çıktısı — src yerine sadece build/ yeterli)
Source: "..\build\*";       DestDir: "{app}\build";       Flags: recursesubdirs createallsubdirs ignoreversion

; EJS görünüm şablonları
Source: "..\views\*";       DestDir: "{app}\views";       Flags: recursesubdirs createallsubdirs ignoreversion

; Statik dosyalar (JS widget, admin scriptleri)
Source: "..\public\js\*";   DestDir: "{app}\public\js";   Flags: recursesubdirs createallsubdirs ignoreversion

; package.json (bazı paketler okuyabilir)
Source: "..\package.json";  DestDir: "{app}";             Flags: ignoreversion

; .env şablon dosyası
Source: "..\env.default";   DestDir: "{app}";             DestName: ".env.default"; \
    Flags: ignoreversion skipifsourcedoesntexist
Source: "..\.env.example";  DestDir: "{app}";             DestName: ".env.default"; \
    Flags: ignoreversion skipifsourcedoesntexist

; Lisans dosyaları
Source: "..\licenses\*";    DestDir: "{app}\licenses";    Flags: recursesubdirs ignoreversion skipifsourcedoesntexist

; Başlatıcı scriptler
Source: "..\scripts\windows\start-installed.ps1"; DestDir: "{app}\scripts\windows"; Flags: ignoreversion
Source: "..\scripts\windows\start-whatsypzck.ps1"; DestDir: "{app}\scripts\windows"; Flags: ignoreversion
Source: "..\launch.bat";    DestDir: "{app}";             Flags: ignoreversion

; npm bağımlılıkları (esbuild external olanlar — runtime için gerekli)
Source: "..\node_modules\whatsapp-web.js\*";    DestDir: "{app}\node_modules\whatsapp-web.js";    Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist
Source: "..\node_modules\puppeteer\*";          DestDir: "{app}\node_modules\puppeteer";          Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist
Source: "..\node_modules\puppeteer-core\*";     DestDir: "{app}\node_modules\puppeteer-core";     Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist
Source: "..\node_modules\bcrypt\*";             DestDir: "{app}\node_modules\bcrypt";             Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist
Source: "..\node_modules\@ffmpeg-installer\*";  DestDir: "{app}\node_modules\@ffmpeg-installer";  Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist
Source: "..\node_modules\fluent-ffmpeg\*";      DestDir: "{app}\node_modules\fluent-ffmpeg";      Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist
Source: "..\node_modules\sharp\*";              DestDir: "{app}\node_modules\sharp";              Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist

; Portable Node.js (build-offline-package.ps1 tarafından indirilir)
Source: "redist\node\*";    DestDir: "{app}\runtime\node"; Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist

; Portable MongoDB (build-offline-package.ps1 tarafından indirilir)
Source: "redist\mongodb\*"; DestDir: "{app}\runtime\mongodb"; Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist

; Chromium (opsiyonel — varsa bundled)
Source: "redist\chromium\*"; DestDir: "{app}\runtime\chromium"; Flags: recursesubdirs createallsubdirs ignoreversion skipifsourcedoesntexist

[Icons]
; Başlat menüsü
Name: "{group}\{#MyAppName} Başlat";       Filename: "{app}\launch.bat"; \
    IconFilename: "{sys}\shell32.dll"; IconIndex: 13; \
    Tasks: startmenuicon
Name: "{group}\{#MyAppName} Kaldır";       Filename: "{uninstallexe}"

; Masaüstü
Name: "{userdesktop}\{#MyAppName}";        Filename: "{app}\launch.bat"; \
    IconFilename: "{sys}\shell32.dll"; IconIndex: 13; \
    Tasks: desktopicon

[Run]
; Kurulum sonrası: .env oluştur + ilk başlatma
Filename: "powershell.exe"; \
    Parameters: "-ExecutionPolicy Bypass -NoLogo -File ""{app}\scripts\windows\start-installed.ps1"" -WorkspacePath ""{app}"""; \
    Description: "WhatsYpzck'ı şimdi başlat ve admin panelini aç"; \
    Flags: postinstall shellexec nowait; \
    WorkingDir: "{app}"

[UninstallRun]
; Kaldırma öncesi: node.exe ve mongod.exe işlemlerini durdur
Filename: "powershell.exe"; \
    Parameters: "-ExecutionPolicy Bypass -Command ""Get-Process -Name node,mongod -ErrorAction SilentlyContinue | Stop-Process -Force"""; \
    RunOnceId: "StopProcesses"

[Code]
// Kurulum öncesi kontrol: 64-bit Windows mi?
function InitializeSetup(): Boolean;
begin
    if not Is64BitInstallMode then begin
        MsgBox('WhatsYpzck yalnızca 64-bit Windows sistemlerde çalışır.', mbError, MB_OK);
        Result := False;
        exit;
    end;
    Result := True;
end;

// Kurulum tamamlandığında bilgi göster
procedure CurStepChanged(CurStep: TSetupStep);
var
    AppDir: String;
begin
    if CurStep = ssPostInstall then begin
        AppDir := ExpandConstant('{app}');
        MsgBox(
            'WhatsYpzck başarıyla kuruldu!' + #13#10 + #13#10 +
            'Uygulama dizini: ' + AppDir + #13#10 + #13#10 +
            'Başlatmak için:' + #13#10 +
            '  • launch.bat çift tıklayın' + #13#10 +
            '  • veya Başlat Menüsü → WhatsYpzck Başlat' + #13#10 + #13#10 +
            'İlk açılışta WhatsApp QR kodu taramanız gerekecek.',
            mbInformation, MB_OK
        );
    end;
end;
