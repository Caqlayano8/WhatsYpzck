# WhatsYpzck v2

Bu surum Supsis.com benzeri cok kanalli ve AI destekli yapiya gecis icin hazirlandi.

## Eklenen Ozellikler

- ChatGPT-4 tabanli AI modulu (`src/modules/ai.ts`)
- Kullanici bazli context (kisa konusma hafizasi)
- Coklu kanal iskeleti:
  - WhatsApp (`whatsapp-web.js`)
  - Instagram (Meta Graph API handler iskeleti)
  - Messenger handler iskeleti
  - Telegram handler iskeleti
- Merkezi kanal yonetimi (`src/core/channelManager.ts`)
- Kanal loglama (`logs/channel.log`) ve genel v2 log (`logs_v2.txt`)
- Otomatik ceviri (`src/utils/translator.ts`)
- Dil ayarlari (`config.json`)
- Gorev/randevu kayit modulu (`src/modules/tasks.ts`, SQLite)
- Dakikalik hatirlatma cron'u (`node-cron`)
- RAG altyapisi (`src/modules/rag.ts`) + OpenAI embedding + semantik benzerlik

## Komutlar

- `npm run start`: v2 botu baslatir
- `npm run build`: TypeScript derler

## Canli Entegrasyon Degiskenleri (.env)

- `OPENAI_API_KEY`: AI ve embedding icin
- `TELEGRAM_BOT_TOKEN`: Telegram bot polling icin
- `META_PAGE_ACCESS_TOKEN`: Instagram/Messenger cevap gonderimi icin
- `META_VERIFY_TOKEN`: Meta webhook dogrulama token'i
- `META_APP_SECRET`: Meta `X-Hub-Signature-256` dogrulamasi icin
- `META_GRAPH_VERSION`: Opsiyonel, varsayilan `v20.0`
- `PORT`: Webhook server portu (varsayilan `3600`)

## Webhook Endpointleri

- `GET /webhook/meta`: Meta webhook verify
- `POST /webhook/meta`: Instagram + Messenger gelen mesaj yakalama
- `GET /health`: servis saglik kontrolu

## Guvenlik ve Tekrar-Islem Onlemi

- Meta webhook imzasi (`X-Hub-Signature-256`) dogrulanir.
- Ayni event tekrar geldiginde idempotency cache ile tekrar islenmez (TTL: 10 dk).

## Notlar

- WhatsApp icin ilk acilista QR okutulmalidir.
- OpenAI ozellikleri icin `OPENAI_API_KEY` gerekli.
- Instagram/Messenger/Telegram handlerlari API baglantisi icin token eklenerek genisletilecek sekilde hazirdir.
