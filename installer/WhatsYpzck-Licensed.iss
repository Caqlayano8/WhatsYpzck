#define MyAppName "WhatsYpzck"
#define MyAppVersion "2.0.0"
#define MyAppPublisher "C.Kurtoglu"
#define MyAppURL "https://github.com/CaqlayanKurtoglu/WhatsYpzck"

#ifndef MyOutputDir
  #define MyOutputDir "output"
#endif

#ifndef MyLicenseFile
  #define MyLicenseFile "licenses\\license.key.json"
#endif

[Setup]
AppId={{E8D3F40B-746A-4D95-9F0B-C91D8C4C0E37}
AppName={#MyAppName} (Licensed)
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\WhatsYpzck
DefaultGroupName=WhatsYpzck
OutputDir={#MyOutputDir}
OutputBaseFilename=WhatsYpzck-Licensed-Full-Kurulum-Setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package-lock.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\.env.example"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\tsconfig.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\docs\WhatsYpzck-Kurulum-ve-Deployment-Rehberi.pdf"; DestDir: "{app}\docs"; Flags: ignoreversion skipifsourcedoesntexist
Source: "..\docs\Kurulum-Yonergesi.pdf"; DestDir: "{app}\docs"; Flags: ignoreversion skipifsourcedoesntexist
Source: "..\esbuild.config.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\ecosystem.config.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\src\*"; DestDir: "{app}\src"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\public\*"; DestDir: "{app}\public"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\scripts\*"; DestDir: "{app}\scripts"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\licenses\public.pem"; DestDir: "{app}\licenses"; Flags: ignoreversion
Source: "{#MyLicenseFile}"; DestDir: "{app}\licenses"; DestName: "license.key.json"; Flags: ignoreversion

[Icons]
Name: "{group}\WhatsYpzck Setup"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\windows\setup-whatsypzck.ps1"" -WorkspacePath ""{app}"" -LicenseAllowUnlicensed false"
Name: "{group}\WhatsYpzck Start"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\windows\start-whatsypzck.ps1"" -WorkspacePath ""{app}"""
Name: "{commondesktop}\WhatsYpzck Start"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\windows\start-whatsypzck.ps1"" -WorkspacePath ""{app}"""

[Run]
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\windows\setup-whatsypzck.ps1"" -WorkspacePath ""{app}"" -LicenseAllowUnlicensed false"; Description: "Ilk kurulum scriptini calistir"; Flags: postinstall shellexec
