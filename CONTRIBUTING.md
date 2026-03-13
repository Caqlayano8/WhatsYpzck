# Katkı Rehberi / Contributing Guide

Bu proje **Çağlayan Kurtoğlu** tarafından geliştirilmektedir.

---

## Projeye Katkı

### 1. Repo'yu fork edin
[https://github.com/CaqlayanKurtoglu/WhatsYpzck](https://github.com/CaqlayanKurtoglu/WhatsYpzck) adresinden fork yapın.

### 2. Klonlayın
```bash
git clone https://github.com/<kullanici-adiniz>/WhatsYpzck.git
cd WhatsYpzck
```

### 3. Yeni bir branch oluşturun
```bash
git checkout -b feature/ozellik-adi
```

### 4. Değişiklikleri commit edip push edin
```bash
git add .
git commit -m "feat: kısa açıklama"
git push origin feature/ozellik-adi
```

### 5. Pull Request açın

---

## Proje Yapısı

```
src/
├── bot.manager.ts          # WhatsApp mesaj orkestratörü ve arıza akışı
├── index.ts                # Uygulama başlangıç noktası
│
├── api/                    # Genel API katmanı
├── commands/               # WhatsApp bot komutları
├── configs/                # Konfigürasyon dosyaları
│
├── crm/
│   ├── api/                # Admin REST API (crm.api.ts)
│   ├── middlewares/        # JWT auth middleware
│   ├── models/             # Mongoose modelleri
│   └── utils/              # Seed admin, auth util
│
├── crons/                  # Zamanlanmış görevler
│
└── utils/
    ├── ai/                 # GPT, Claude, Gemini, Ollama, HuggingFace
    ├── content/            # i18n, onboarding, çeviri
    ├── core/               # Genel yardımcılar
    ├── events/             # EventEmitter, webhook
    ├── location/           # Ülke/dil tespiti
    ├── media/              # İndirme, STT, TTS
    └── system/             # Crypto, log buffer, runtime config

public/
├── js/admin/               # Admin panel JS modülleri (13 modül)
└── reports/incidents/      # Arıza CSV raporları

scripts/
└── windows/                # Windows kurulum/başlatma scriptleri
```

---

## Kod Standartları

- TypeScript kullanın (`.ts`)
- Her yeni util/komut dosyasına `Author: Ç.Kurtoğlu` header ekleyin
- `npm run type-check` ile TypeScript hatalarını doğrulayın
- Commit mesajları: `feat:`, `fix:`, `chore:`, `docs:` prefix kullanın

---

Copyright © 2026 Çağlayan Kurtoğlu — MIT Lisansı
