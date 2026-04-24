# Changelog

All notable changes to WhatsYpzck are documented here.

---

## [2.1.0] — 2026-04-16

### Added

#### CRM — Anket (Memnuniyet Değerlendirmesi)
- **Multi-step memnuniyet anketi**: Arıza çözüldüğünde müşteriye otomatik 3 adımlı WhatsApp anketi gönderilir.
  - **Adım 1** — "Probleminiz çözüldü mü? 1=Evet / 2=Hayır"
  - **Adım 2** — "Teknisyen iletişiminden memnun kaldınız mı? 1=Evet / 2=Hayır"
  - **Adım 3** — Serbest yorum (isteğe bağlı; "Hayır" yazarak geçilebilir)
- **SurveyResponse modeli** (`src/crm/models/survey-response.model.ts`) yeniden tasarlandı:
  - `solutionSatisfied`, `techSatisfied`, `freeComment`, `step`, `status: 'pending'|'completed'|'expired'` alanları
- **Admin Panel → Anketler** sekmesi tamamen güncellendi:
  - 4 istatistik kartı: Toplam Gönderilen, Tamamlanan, Problem Çözüldü ✅, Teknisyen Memnun ✅
  - Müşteri telefonu ve Arıza No ile filtreleme + sayfalama
  - Tabloda arıza bazlı ayrı ayrı satırlar: Çözüm, Teknisyen, Serbest Yorum sütunları

#### CRM — Manuel Kişi Ekleme
- **`POST /crm/contacts`** endpoint'i eklendi (Kişi Ekle butonu artık çalışıyor)
- Admin Panel → Kişiler → **"Kişi Ekle"** butonu → telefon, ad, soyad, adres girilebiliyor
- Hata mesajları artık API'den okunuyor (örn. "Bu telefon numarası zaten kayıtlı")

### Changed

- `apiFetch` fonksiyonu (`public/js/admin/state.js`) hata body'sini doğru okuyor — artık `POST /url → 409` yerine gerçek hata mesajı gösteriliyor
- `GET /crm/surveys` endpoint'i `customerPhone` ve `incidentId` filtre parametrelerini kabul ediyor
- Anket istatistik kartlarında rating yerine çözüm/teknisyen memnuniyet oranları gösteriliyor
- Anket mesaj şablonunu Admin → Anketler → Anket Ayarları'ndan düzenlemek mümkün

### Fixed

- Kişi ekle modal'ı 409 çakışma durumunda "Bu telefon numarası zaten kayıtlı" hatası veriyor (eski: "POST /crm/contacts → 409")
- Anket cevabı tek karakter kontrolünden çıkarıldı (herhangi uzunlukta serbest yorum destekleniyor)

---

## [2.0.0] — 2026-03

### Breaking Changes

- **Voice processing migrated to local sherpa-onnx** — AssemblyAI and Speechify cloud services removed. Models (`whisper-tiny.en` for STT, `vits-piper-en_US-lessac-medium` for TTS) are downloaded automatically on first startup (~400 MB). Remove `ASSEMBLYAI_API_KEY` and `SPEECHIFY_API_KEY` from `.env`.
- **API keys moved from `.env` to the database** — `GEMINI_API_KEY`, `CHAT_GPT_API_KEY`, `ANTHROPIC_API_KEY`, and `OPENWEATHERMAP_API_KEY` are now configured in **Admin → Settings** and stored (optionally encrypted) in MongoDB. The `.env` variables still work as fallbacks.
- **New required env variable** (strongly recommended): `ENCRYPTION_MASTER_KEY` — a 64-char hex string used to encrypt database-stored API keys at rest. Generate with `openssl rand -hex 32`.

### Added

#### Bot Commands
- `/claude` — Chat with Anthropic Claude directly from WhatsApp
- `/recap [period]` — AI-powered group chat summary (group chats only). Supports `1h`, `6h`, `12h`, `24h`, `2d`, `7d`, `1w`. Uses the AI provider selected in admin Settings.

#### Admin Panel — new tabs
- **Chats (Inbox)** — read and reply to 1-to-1 WhatsApp conversations in the browser via Server-Sent Events
- **Contact Scoring** — define point rules per engagement event; view top-10 leaderboard
- **Group Recap** — browser-only AI group summary; nothing sent on WhatsApp
- **Auto-Reply** — keyword-triggered automatic responses with optional AI generation and per-rule cooldown
- **Integrations** — webhooks, Slack, Discord, SMTP email forwarding, inbound API key

#### Admin Panel — campaign enhancements
- A/B variant message body
- Per-contact variable substitution with fallback syntax (`{{name|Friend}}`)
- Exclude-tags filter (skip contacts with matching tags)
- Throttle rate (messages per minute)
- Expiry date (auto-cancel if now > expiry)
- Multi-message sequences with per-step delay
- Per-contact preview and test send
- Pause / resume / cancel / archive actions
- Delivery report enhancements: reply tracking, status filter, CSV export

#### Admin Panel — template enhancements
- Pin templates to top of grid
- Duplicate template
- Approval workflow (draft → pending → approved)
- Usage count
- Revision history with one-click restore
- Live preview with sample data (resolves `{{variables}}` client-side)
- WhatsApp formatting toolbar (bold, italic, strikethrough, monospace)

#### Admin Panel — dashboard
- Delta indicators (today vs. yesterday) for contacts and messages
- Failed-campaign health banner
- Top commands widget
- Recent audit entries widget

#### Security
- AES-256-GCM encryption for API keys stored in MongoDB (`ENCRYPTION_MASTER_KEY`)
- Server-side validation for admin settings (`maxFileSizeMb` clamped to 1–500)

### Changed

- Frontend JavaScript split from a single 2 500-line `admin.js` into 13 focused modules under `public/js/admin/`
- Public pages (login, QR, status) redesigned to match the admin panel design language (light `#f1f5f9` background, white cards, indigo accent)
- Command prefix is now environment-aware: `/` in production, `!` in development
- Sherpa model paths persisted to the database so they survive restarts without manual `.env` entries

### Fixed

- Campaign variable substitution now supports `{{variable|fallback}}` syntax
- Command prefix display in the admin Commands tab now reflects the actual runtime prefix

---

## [1.x] — Earlier releases

See [GitHub commits](https://github.com/CaqlayanKurtoglu/WhatsYpzck/commits/main) for history prior to v2.0.
