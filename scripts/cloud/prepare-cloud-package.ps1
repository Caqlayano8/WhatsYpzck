# Author: Ç.Kurtoğlu
# Description: WhatsYpzck'ı Render / Railway / VPS / Docker hosting için hazırlar.
#              Temiz bir deploy-package/ klasörü ve ZIP oluşturur.
#              Ayrıca .env.production şablonu oluşturur (değerleri doldurmanız gerekir).

param(
    [string]$WorkspacePath = "",
    [string]$OutputDir     = "",
    [switch]$SkipZip
)

if ([string]::IsNullOrWhiteSpace($WorkspacePath)) {
    $WorkspacePath = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
    # scripts\cloud\ içindeyiz → 3 üst dizin
    # Eğer scripts\cloud\ yoksa scripts\windows\..\..\
    if (-not (Test-Path (Join-Path $WorkspacePath "package.json"))) {
        $WorkspacePath = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
    }
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $WorkspacePath "deploy-package"
}

$ErrorActionPreference = "Stop"

function Log    { param([string]$M, [string]$C="Cyan")  Write-Host "[CLOUD] $M" -ForegroundColor $C }
function LogOK  { param([string]$M) Write-Host "[CLOUD] ✔ $M" -ForegroundColor Green }
function LogWarn{ param([string]$M) Write-Host "[CLOUD] ⚠ $M" -ForegroundColor Yellow }

Log "== WhatsYpzck Cloud Deploy Hazırlıyıcı =="
Log "Kaynak  : $WorkspacePath"
Log "Çıktı   : $OutputDir"

# Önceki paketi temizle
if (Test-Path $OutputDir) {
    Log "Eski deploy-package temizleniyor..."
    Remove-Item $OutputDir -Recurse -Force
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

# ── Kopyalanacak dosya ve klasörler ──────────────────────────────────────────
$includeDirs = @(
    "src",
    "public",
    "views",
    "scripts",
    "licenses"
)

$includeFiles = @(
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "esbuild.config.js",
    "ecosystem.config.js",
    "nodemon.json",
    "Dockerfile",
    "docker-compose.yml",
    "render.yaml",
    ".env.example",
    "README.md"
)

# Klasörleri kopyala
foreach ($dir in $includeDirs) {
    $src = Join-Path $WorkspacePath $dir
    if (Test-Path $src) {
        $dst = Join-Path $OutputDir $dir
        Copy-Item -Path $src -Destination $dst -Recurse -Force
        LogOK "Kopyalandı: $dir\"
    } else {
        LogWarn "$dir bulunamadı, atlandı."
    }
}

# Dosyaları kopyala
foreach ($file in $includeFiles) {
    $src = Join-Path $WorkspacePath $file
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination (Join-Path $OutputDir $file) -Force
        LogOK "Kopyalandı: $file"
    } else {
        LogWarn "$file bulunamadı, atlandı."
    }
}

# ── .env.production şablonu oluştur ──────────────────────────────────────────
$envProdPath = Join-Path $OutputDir ".env.production"
@"
# WhatsYpzck - Production Ortam Değişkenleri
# Bu dosyayı hosting sağlayıcınızın environment variables bölümüne ekleyin.
# Dosyayı doğrudan Git'e commit ETMEYİN!

# ── Uygulama ──────────────────────────────────────────────────────────────────
NODE_ENV=production
PORT=3000
TZ=Europe/Istanbul

# ── Güvenlik (ZORUNLU — güçlü değer oluşturun) ────────────────────────────────
# Üretmek için: openssl rand -base64 32
JWT_SECRET=BURAYA_GUCLU_JWT_SECRET_KOYUN_MIN_32_KARAKTER

# Üretmek için: openssl rand -hex 32
ENCRYPTION_MASTER_KEY=BURAYA_64_KARAKTER_HEX_DEGER_KOYUN

# ── Yönetici Hesabı ───────────────────────────────────────────────────────────
DEFAULT_ADMIN_USER=admin
DEFAULT_ADMIN_PASS=BURAYA_GUCLU_SIFRE_KOYUN

# ── Veritabanı (MongoDB Atlas önerilen) ───────────────────────────────────────
# MongoDB Atlas için: https://www.mongodb.com/atlas
MONGODB_URI=mongodb+srv://kullanici:sifre@cluster.mongodb.net/whatsypzck?retryWrites=true&w=majority

# ── CORS ──────────────────────────────────────────────────────────────────────
# Kendi domain'inizi veya * koyun
ALLOWED_ORIGINS=https://sizin-siteniz.com

# ── WhatsApp ──────────────────────────────────────────────────────────────────
BOT_AUTO_START=true
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
# Render/Railway için: /usr/bin/chromium veya /usr/bin/google-chrome

# ── Arıza Bildirimleri ────────────────────────────────────────────────────────
ARIZA_TEAM_WHATSAPP=905XXXXXXXXX
ARIZA_TEAM_EMAILS=ekip@sirketiniz.com

# ── E-posta (SMTP) ────────────────────────────────────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=noreply@sirketiniz.com
SMTP_PASS=GMAIL_UYGULAMA_SIFRESI
SMTP_FROM_EMAIL=noreply@sirketiniz.com

# ── Yapay Zeka API'leri (opsiyonel) ──────────────────────────────────────────
GEMINI_API_KEY=GOOGLE_AI_STUDIO_DAN_ALIN
CHAT_GPT_API_KEY=OPENAI_API_KEYI

# ── Lisans ────────────────────────────────────────────────────────────────────
LICENSE_ALLOW_UNLICENSED=true
SKIP_SHERPA_MODELS=true
"@ | Set-Content $envProdPath -Encoding UTF8
LogOK ".env.production şablonu oluşturuldu."

# ── Hosting Rehberi oluştur ───────────────────────────────────────────────────
$guidePath = Join-Path $OutputDir "HOSTING-REHBERI.md"
@"
# WhatsYpzck — Hosting / Deployment Rehberi
*Ç.Kurtoğlu tarafından hazırlanmıştır.*

---

## 1. Render.com (Ücretsiz — Önerilen)

1. [render.com](https://render.com) hesabı oluşturun.
2. **New → Web Service → Deploy from GitHub** (veya zip yükleyin).
3. **Runtime:** Docker
4. **render.yaml** zaten hazır — otomatik algılanır.
5. **Environment Variables** bölümüne `.env.production` içindeki değerleri girin.
6. **MongoDB:** [MongoDB Atlas](https://www.mongodb.com/atlas) ücretsiz cluster oluşturun.
   - `MONGODB_URI` değerini Atlas connection string ile değiştirin.
7. Deploy edin → URL'nizi alın.

---

## 2. Railway.app

\`\`\`bash
npm install -g @railway/cli
railway login
railway init
railway up
\`\`\`
Environment variables'ları Railway dashboard'dan ekleyin.

---

## 3. Docker ile VPS (Ubuntu/Debian)

\`\`\`bash
# Sunucuya dosyaları kopyalayın
scp -r deploy-package/ user@sunucu-ip:/opt/whatsypzck/
ssh user@sunucu-ip
cd /opt/whatsypzck

# .env dosyası oluşturun
cp .env.production .env
nano .env  # Değerleri doldurun

# Docker Compose ile başlatın
docker-compose up -d
\`\`\`

---

## 4. Elle VPS (Node.js kurulu, Docker yok)

\`\`\`bash
# Node.js 22 LTS kur (yoksa)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# MongoDB kur (yoksa)
# https://www.mongodb.com/docs/manual/installation/

# Uygulamayı kur
cd /opt/whatsypzck
npm install
npm run build

# .env hazırla
cp .env.production .env
nano .env

# PM2 ile başlat (otomatik restart)
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Sunucu yeniden başladığında otomatik başlasın
\`\`\`

---

## 5. Önemli Notlar

- **WhatsApp QR:** Hosting'de `BOT_AUTO_START=true` iken ilk açılışta `/qr` sayfasından QR tarayın.
- **MongoDB Atlas:** Ücretsiz tier yeterlidir (512MB). IP Whitelist'e `0.0.0.0/0` ekleyin.
- **Chromium:** Render/Railway Docker imajı otomatik kurar (Dockerfile'da yazılı).
- **HTTPS:** Render ve Railway otomatik SSL sertifikası verir.
- **Port:** Hosting platformu `PORT` env var'ını otomatik ayarlar — değiştirmeyin.

---

## Hızlı Kontrol Listesi

- [ ] MONGODB_URI (Atlas connection string)
- [ ] JWT_SECRET (min 32 karakter random)
- [ ] ENCRYPTION_MASTER_KEY (64 hex karakter)
- [ ] DEFAULT_ADMIN_PASS (güçlü şifre)
- [ ] SMTP_USER / SMTP_PASS (e-posta bildirimleri için)
- [ ] ARIZA_TEAM_WHATSAPP / ARIZA_TEAM_EMAILS
- [ ] Deploy sonrası /admin → ilk giriş → admin şifresini değiştir
"@ | Set-Content $guidePath -Encoding UTF8
LogOK "HOSTING-REHBERI.md oluşturuldu."

# ── ZIP oluştur ────────────────────────────────────────────────────────────────
if (-not $SkipZip) {
    $zipPath = Join-Path $WorkspacePath "WhatsYpzck-CloudDeploy-$(Get-Date -Format 'yyyyMMdd-HHmmss').zip"
    Log "ZIP oluşturuluyor: $zipPath"
    Compress-Archive -Path "$OutputDir\*" -DestinationPath $zipPath -Force
    LogOK "ZIP hazır: $zipPath"
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host "  Cloud deploy paketi hazır!" -ForegroundColor White
Write-Host "  Klasör : deploy-package\" -ForegroundColor White
Write-Host "  Rehber : deploy-package\HOSTING-REHBERI.md" -ForegroundColor White
if (-not $SkipZip) {
    Write-Host "  ZIP    : WhatsYpzck-CloudDeploy-*.zip" -ForegroundColor White
}
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor DarkCyan
