# WhatsYpzck (Turkce)

Turkce dokumantasyon sayfasina hos geldiniz. Bu dosya, projenin temel kurulumunu ve kullanimini Turkce olarak ozetler.

Dil secimi:
- English: [README.md](README.md)
- Turkce: [README.tr.md](README.tr.md)

---

## Proje Ozeti

WhatsYpzck, WhatsApp uzerinden otomasyon, destek ve CRM surecleri icin gelistirilmis bir bot altyapisidir.

Bu ozellestirilmis surumde odak:
- Kurumsal destek akisi
- Ilk mesaja selamlama, ikinci mesajdan itibaren AI destekli temsilci yaniti
- Yerel model (Ollama) ile calisma
- Sade komut yapisi

---

## Aktif Akis

Bu surumde ana komut akisi:
- `merhaba`

Calisma sekli:
1. Kullanici `merhaba` yazar.
2. Bot karsilama metni doner.
3. Sonraki kullanici mesajinda AI devreye girer.
4. AI cevabi kurumsal formatta verilir:
   - Durum
   - Yapilacak Islem
   - Gerekli Bilgi
   - Sonraki Adim

---

## Hızlı Baslangic

### 1. Gereksinimler
- Node.js
- MongoDB
- Google Chrome (Puppeteer icin)
- Ollama (yerel AI icin)

### 2. Kurulum

```bash
npm install
cp .env.example .env
```

### 3. Gelistirme Modu

```bash
npm run dev
```

Varsayilan erisim:
- `http://localhost:3000`

---

## Ollama Kurulumu (Yerel AI)

Ornek model kurulumu:

```bash
ollama pull mistral:7b-instruct
```

`.env` icine model tanimi:

```env
OLLAMA_MODEL=mistral:7b-instruct
```

Not:
- Model tam inmeden AI yaniti gec gelebilir veya hata verebilir.
- Model kurulduktan sonra botu yeniden baslatin.

---

## Ornek .env Alanlari

```env
ENV=development
PORT=3000
MONGODB_URI=mongodb://localhost:27017/WhatsYpzck
JWT_SECRET=your_secret_here
PUPPETEER_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
OLLAMA_MODEL=mistral:7b-instruct
```

---

## Proje Yapisi (Ozet)

- `src/commands`: aktif komutlar (sade)
- `src/utils/ai`: AI yardimcilari
- `src/utils/content`: i18n/onboarding/translate
- `src/utils/system`: log, crypto, runtime
- `src/utils/events`: event yardimcilari
- `src/utils/media`: medya ve model indirme araclari
- `scripts/windows`: setup ve installer otomasyon scriptleri
- `scripts/load`: yuk/perf benchmark scriptleri

---

## Admin Panel

Admin panel erisimi:
- `http://localhost:3000/admin`

Admin olusturma:

```bash
npm run create-admin
```

---

## Lisans

Bu proje MIT lisansi ile dagitilmaktadir.
Detay: [LICENSE](LICENSE)

Orijinal sahiplik ve degisiklik notlari lisans dosyasinda korunmustur.
