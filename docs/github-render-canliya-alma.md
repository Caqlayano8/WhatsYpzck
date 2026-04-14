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
Render servisinde Environment bolumune su alanlari gir:
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

Not:
- render.yaml icinde PORT=3000 ve PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium zaten tanimli.
- MONGODB icin Atlas kullanmaniz onerilir.

## 4. Ilk acilis kontrolu
Deploy bittikten sonra:
1. /health endpointini ac.
2. /admin girisini test et.
3. Bot QR/durum ekranini kontrol et.

## 5. Otomatik guncelleme
- autoDeploy acik oldugu icin GitHub'a her push sonrasi Render otomatik yeni deploy baslatir.
