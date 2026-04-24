#define MyAppName "WhatsYpzck"
#define MyAppVersion "2.0.0"
#define MyAppPublisher "C.Kurtoglu"
#define MyAppURL "https://github.com/CaqlayanKurtoglu/WhatsYpzck"
#define MyAppExeName "scripts\\windows\\start-whatsypzck.ps1"

#ifndef MyOutputDir
  #define MyOutputDir "output"
#endif

[Setup]
AppId={{8CB1AEFD-3898-4D95-BAC4-628FA9F4D22A}
AppName={#MyAppName} (Unlicensed)
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\WhatsYpzck
DefaultGroupName=WhatsYpzck
OutputDir={#MyOutputDir}
OutputBaseFilename=WhatsYpzck-Unlicensed-Full-Kurulum-Setup
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
Source: "..\licenses\public.pem"; DestDir: "{app}\licenses"; Flags: ignoreversion skipifsourcedoesntexist

[Dirs]
Name: "{app}\licenses"

[Icons]
Name: "{group}\WhatsYpzck Setup"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\windows\setup-whatsypzck.ps1"" -WorkspacePath ""{app}"" -LicenseAllowUnlicensed true"
Name: "{group}\WhatsYpzck Start"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\windows\start-whatsypzck.ps1"" -WorkspacePath ""{app}"""
Name: "{commondesktop}\WhatsYpzck Start"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\windows\start-whatsypzck.ps1"" -WorkspacePath ""{app}"""

[Run]
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\windows\setup-whatsypzck.ps1"" -WorkspacePath ""{app}"" -LicenseAllowUnlicensed true"; Description: "Ilk kurulum scriptini calistir"; Flags: postinstall shellexec
