# GitHub Uzerinden Render Canliya Alma Rehberi

## 1. GitHub'a gonder
1. Degisiklikleri kontrol et:
   - git status
2. Commit al:
   - git add .
   - git commit -m "deploy: render blueprint and production settings"
3. Branch'i gonder:
   - git push origin single-author-clean

## 2. Render'da servis olustur
1. Render dashboard ac.
2. New + -> Blueprint sec.
3. GitHub repository bagla.
4. Root'taki render.yaml dosyasi otomatik okunur.
5. Create blueprint ile servisi olustur.

## 3. Ortam degiskenlerini doldur
Render servisinde Environment bolumune su alanlari gir.

Zorunlu alanlar:
- MONGODB_URI
- JWT_SECRET
- ENCRYPTION_MASTER_KEY
- DEFAULT_ADMIN_USER
- DEFAULT_ADMIN_PASS
- ALLOWED_ORIGINS
- SMTP_HOST
- SMTP_PORT
- SMTP_USER
- SMTP_PASS
- SMTP_FROM_EMAIL
- ARIZA_TEAM_WHATSAPP
- ARIZA_TEAM_EMAILS
- GEMINI_API_KEY
- CHAT_GPT_API_KEY
- ANTHROPIC_API_KEY
- OPENWEATHERMAP_API_KEY

Render'da tanimli olmasi onerilen alanlar:
- ENV=production
- NODE_ENV=production
- JWT_EXPIRES_IN=2h
- SMTP_SECURE=false
- SMTP_FROM_NAME=WhatsYpzck
- AI_WEB_LOOKUP_ENABLED=true
- AI_WEB_LOOKUP_MODE=balanced

Not:
- render.yaml icinde PORT=3000 ve PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium zaten tanimli.
- MONGODB icin Atlas kullanmaniz onerilir.

PowerShell ile guvenli secret uretme:
- JWT_SECRET: [Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
- ENCRYPTION_MASTER_KEY: -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })

MONGODB_URI Atlas ornegi:
- mongodb+srv://USERNAME:PASSWORD@cluster0.xxxxx.mongodb.net/WhatsYpzck?retryWrites=true&w=majority

## 4. Ilk acilis kontrolu
Deploy bittikten sonra:
1. /health endpointini ac.
2. /admin girisini test et.
3. Bot QR/durum ekranini kontrol et.
4. Ilk giriste admin sifresini degistir.
5. Basit bir test talebi acip kapanis akisinin calistigini dogrula.

## 5. Otomatik guncelleme
- autoDeploy acik oldugu icin GitHub'a her push sonrasi Render otomatik yeni deploy baslatir.

## 6. Siklikla karsilasilan sorunlar
1. Build hatasi (paket bulunamadi):
   - Render Build Log'da eksik paket satirini kontrol et.
2. /health 500 donuyor:
   - MONGODB_URI, JWT_SECRET ve ENCRYPTION_MASTER_KEY degiskenlerini yeniden kontrol et.
3. SMTP bildirim gitmiyor:
   - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS ve SMTP_FROM_EMAIL uyumunu kontrol et.
