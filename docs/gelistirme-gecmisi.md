# WhatsYpzck — Geliştirme Geçmişi

_Son güncelleme: 2026-04-14_

---

## 2026-04-14 — Guvenli Kayit ve Yedekleme

### Yapilanlar
- Konusma ozeti proje icine kaydedildi: `docs/konusma-kaydi-2026-04-14.md`
- Tam proje yedegi olusturuldu:
  - `C:\Users\kurto\OneDrive\Desktop\WhatsYpzck-Backup-20260414-110627`
- Yedek klasorune geri donus icin git metaverileri eklendi:
  - `git-status.txt`
  - `working-tree.diff`
  - `git-branch.txt`

### Amac
- Hata durumunda kodu ve son calisma farklarini hizli sekilde geri alabilmek.

---

## 2026-04-14 — Bot Kimliği Admin Panelinden Yönetim

### Yapılanlar
- **`src/crm/models/settings.model.ts`** → `botIdentity: { name, author }` subdocument eklendi  
  (varsayılan: `WhatsYpzck` / `Ç. Kurtoğlu`)
- **`src/crm/api/crm.api.ts`** → PUT `/crm/settings` rotasına `botIdentity` güncelleme bloğu eklendi
- **`src/bot.manager.ts`** → 3 yerdeki `AppConfig.instance.getBotAuthor()` çağrısı  
  `settings?.botIdentity?.author` öncelikli fallback ile güncellendi  
  (arıza özeti mesajı satırı, CSV imzası, müşteri e-posta imzası)
- **`src/views/admin.ejs`** → Sistem Ayarları sekmesine "Bot Kimliği" kartı eklendi  
  (Bot Adı + İmza/Yazar input alanları)
- **`public/js/admin/system.js`** → `loadSettings` ve `saveSettings` fonksiyonlarına  
  `botIdentity` load/save wiring eklendi; bot-info-grid dinamik gösterim

### Nasıl Kullanılır
Admin Paneli → Sistem Ayarları → **Bot Kimliği** kartı → Düzenle → Kaydet  
Değişiklik anında arıza bildirimi WhatsApp mesajlarına, CSV raporlarına ve müşteri e-postalarına yansır.

---

## 2026-04-14 — Resim/Video Durum Güncellemesi

### Sorun
Admin panelinden durum güncellerken eklenen resimler müşteriye WhatsApp üzerinden gitmiyordu.

### Kök Neden
`file://` protokolü whatsapp-web.js ile çalışmıyor.

### Çözüm
`src/crm/api/crm.api.ts` — durum güncelleme endpoint'inde HTTP URL oluşturma:
```typescript
const mediaUrl = uploadedMediaUrl.startsWith('http')
    ? uploadedMediaUrl
    : `http://localhost:${process.env.PORT || 3500}${uploadedMediaUrl}`;
const mediaFile = await WAWebJS.default.MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
await botManager.client.sendMessage(chatId, mediaFile, { caption: text });
```

---

## Önceki Oturumlar — Teknisyen Akışı ve Şablonlar

### Teknisyen WhatsApp Dispatch
- Arıza oluşunca alan eşleşmesine göre otomatik teknisyen ataması
- Atanan teknisyene WhatsApp bildirimi
- Alan bazlı yönlendirme: mahalle/sokak/keyword matching, `routing` alanı kullanıcı modelinde

### Bot Mesaj Şablonları (Admin Panelden)
- KVKK metni, karşılama menüsü, ana menü, arıza kategorisi, durum sorgulama başlangıç/sonuç mesajları
- Hepsi `botMessageTemplates` subdocument altında, DB'de saklanır, admin panelinden editlenebilir

### Müşteri Bildirim Şablonları
- Kurum adı, imza, kapanış, WhatsApp durum şablonu, e-posta durum/oluşturma şablonları
- `notificationTemplates` subdocument

### 2FA
- E-posta OTP (5 dk geçerli, bcrypt hashli)
- Google Authenticator TOTP (speakeasy, QR kod üretimi)
- `src/crm/utils/auth.util.ts` → `AuthService`

---

## Ortam Notları

- **Port:** 3500
- **MongoDB:** `mongodb://localhost:27018/WhatsYpzck` (Docker, auth yok)  
  `.env` dosyasında tek `MONGODB_URI` satırı kalmalı (27018), 27017 satırı yorum satırı olmalı
- **Çalıştırma:** `npm run dev`
- **Tip kontrolü:** `npm run type-check`

---

## Dosya Haritası

```
src/
  index.ts                    — Uygulama giriş noktası
  bot.manager.ts              — WhatsApp runtime + mesaj/arıza işleme (ana dosya)
  configs/
    app.config.ts             — Bot adı/imza hardcoded fallback
    env.config.ts             — .env okuma
    db.config.ts              — MongoDB bağlantı
  crm/
    api/crm.api.ts            — Tüm CRM REST API
    models/
      settings.model.ts       — Settings şeması (botIdentity, botMessageTemplates, notificationTemplates...)
      user.model.ts           — Kullanıcı şeması (rol, routing, 2FA alanları)
      incident.model.ts       — Arıza şeması
    utils/auth.util.ts        — Giriş, 2FA, rol normalizasyonu
  views/
    admin.ejs                 — Admin HTML şablonu
    panel.ejs                 — Teknisyen panel şablonu
public/
  js/admin/
    system.js                 — Sistem ayarları JS (settings, users, commands, audit)
```
