# WhatsApp Talep Kapatma Akisi Test Senaryosu

## On Kosullar
- Sistem calisir durumda.
- Test musterisi icin en az 1 acik talep bulunur.
- Munkunse 2+ acik talep ile coklu secim de test edilir.

## Senaryo 1: Kapatma Niyeti ve Talep Secimi
1. Musteri su mesajlardan birini gonderir: `iptal`, `talebi iptal etmek istiyorum`, `sorunum duzeldi`.
2. Bot acik talepleri `Talep No` ile listeler.
3. Musteri listeden bir talep numarasi gonderir.
4. Bot secilen talep no ve durumu ile onay ister.

Beklenen:
- Talep numaralari net sekilde gorunur.
- Hatali secimde bot listeyi tekrar gosterir.

## Senaryo 2: Onay ve Kapatma
1. Onay adiminda musteri `kabul ediyorum` yazar.
2. Bot kapatma basari mesaji doner.

Beklenen:
- Talep durumu `KAPATILDI` olur.
- `statusHistory` icine musteri istegi notu eklenir.
- Yönetici/teknisyen bilgilendirmesi ve e-posta denemeleri tetiklenir.

## Senaryo 3: Onay Vermeme
1. Onay adiminda musteri farkli bir yazi yazar.

Beklenen:
- Bot sadece onay metnini tekrar ister.
- Talep kapanmaz.

## Senaryo 4: Vazgecme / Sohbet Sonlandirma
1. Kapatma akisinda musteri `sonra gorusuruz` veya `musait degilim` yazar.

Beklenen:
- Sadece konusma sonlanir.
- Talep kapanmaz.

## Senaryo 5: Acik Talep Yok
1. Acik talebi olmayan musteri `iptal` yazar.

Beklenen:
- Bot acik talep olmadigini bildirir.
- Kapanis islemi yapmaz.
