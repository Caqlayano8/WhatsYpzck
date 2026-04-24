# Konuşma Kaydı — 22 Nisan 2026

## Oturumun Özeti

Bu oturumda yapılan işlemler sırasıyla:

1. **npm run build** çalıştırıldı → `build/index.js` güncellendi (22.04.2026 15:43, ~7 MB)
2. **WhatsYpzck-Afis.html** oluşturuldu → `C:\Users\34116\Desktop\WhatsYpzck-Afis.html`
   - Koyu tema, WhatsApp yeşili renk şeması
   - Bölümler: Header, Metrikler (4 kart), Özellikler (6 kart), AI Motorları, Tech Stack, Mimari şema, Footer
3. **installer\.iss dosyaları güncellendi** → Her ikisine de PDF source satırları eklendi:
   ```ini
   Source: "..\docs\WhatsYpzck-Kurulum-ve-Deployment-Rehberi.pdf"; DestDir: "{app}\docs"; Flags: ignoreversion skipifsourcedoesntexist
   Source: "..\docs\Kurulum-Yonergesi.pdf"; DestDir: "{app}\docs"; Flags: ignoreversion skipifsourcedoesntexist
   ```
4. **İki installer build** çalıştırıldı:
   - 1. build (PDFsiz) → Tamamlandı, ~332 sn
   - 2. build (PDF dahil) → Bu oturum sonunda tamamlandı

---

## Proje Durumu

### Klasörler
| Klasör | Durum |
|---|---|
| `C:\Users\34116\Desktop\WhatsYpzck\` | ✅ Güncel (build 15:43) |
| `C:\Users\34116\Desktop\WhatsYpzck-Installers\` | ✅ Güncellendi (Unlicensed + LicenseGen) |
| `C:\Users\34116\Desktop\WhatsYpzck_Yedek_2026-04-14\` | ⛔ Dokunulmadı (kasıtlı) |

### Installer Durumu
- `WhatsYpzck-Unlicensed-Full-Kurulum-Setup.exe` → ✅ Yeniden derlendi (PDF dahil)
- `WhatsYpzck-License-Generator.exe` → ✅ Yeniden derlendi
- `WhatsYpzck-Licensed-Full-Kurulum-Setup.exe` → ⚠️ Yeniden derlenmedi (script `-LicensedLicenseFile` parametresi gerektiriyor)

### Lisanslı installer'ı da rebuild etmek için:
```powershell
powershell -ExecutionPolicy Bypass -File "scripts\windows\build-installers.ps1" `
  -WorkspacePath "C:\Users\34116\Desktop\WhatsYpzck" `
  -OutputDir "C:\Users\34116\Desktop\WhatsYpzck-Installers" `
  -LicensedLicenseFile "C:\Users\34116\Desktop\WhatsYpzck\licenses\license.key.json"
```

---

## Teknik Bilgiler

- **Node.js + TypeScript**, v2.0.0
- **Build:** `npm run build` → esbuild → `build/` klasörü
- **Installer Tool:** Inno Setup 6.7.1 → `C:\Users\34116\AppData\Local\Programs\Inno Setup 6\ISCC.exe`
- **Installer script:** `scripts\windows\build-installers.ps1`
- **PDF konumu:** `docs\WhatsYpzck-Kurulum-ve-Deployment-Rehberi.pdf` ve `docs\Kurulum-Yonergesi.pdf`
- **Lisans dosyası:** `licenses\license.key.json`

---

## Önceki Oturumlarda Yapılanlar (Referans)

- Kişi filtresi düzeltildi (contacts filter)
- Gelen kutusu sıralama düzeltildi (inbox sort)
- İPTAL kapanışında anket eklendi (survey on IPTAL closure)

---

## Installer Sonuç Durumu (Oturum Sonu)

Tüm installer'lar başarıyla güncellendi:

| Dosya | Tarih | Boyut |
|---|---|---|
| `WhatsYpzck-Unlicensed-Full-Kurulum-Setup.exe` | ✅ 22.04.2026 | ~304 MB (PDF dahil) |
| `WhatsYpzck-License-Generator.exe` | ✅ 22.04.2026 | ~0.2 MB |
| `WhatsYpzck-Licensed-Full-Kurulum-Setup.exe` | ✅ 22.04.2026 | ~304 MB (PDF + lisans dahil) |

---

## Yeni Fikir: Plugin Sistemi (Henüz Kodlanmadı)

### Karar
WhatsYpzck'e **eklenti (plugin) sistemi** kurulacak. CRM modülü bu sisteme ilk eklenti olarak eklenecek.

### Mimari
```
Admin Panel
└── Eklentiler sayfası
    ├── [toggle] CRM Modülü → açıkken menüde görünür
    ├── [toggle] Telegram Entegrasyonu (gelecekte)
    └── [toggle] Instagram Entegrasyonu (gelecekte)
```

### Neden bu yaklaşım?
- WhatsYpzck mevcut hali **bozulmaz** (sadece WhatsYpzck isteyen müşteri için değişmez)
- CRM isteyen müşteri toggle ile açar
- Gelecekte başka eklentiler de aynı sisteme eklenir

### Yapılacak İşler (Sırasıyla)
1. [ ] Plugin sistemi altyapısı — `src/plugins/` klasörü, config dosyası (~1 gün)
2. [ ] Admin panele "Eklentiler" sekmesi — toggle UI (~1 gün)
3. [ ] CRM modülü — müşteri kartları (~2-3 gün)
4. [ ] CRM modülü — pipeline/kanban (~2-3 gün)
5. [ ] WhatsYpzck ↔ CRM bağlantısı — webhook/API endpoint (~1 gün)

### Tahmini Süre: 1.5-2 hafta

---

## Diğer Yapılacaklar

- [ ] npm audit fix — 18 vulnerability mevcut (2 low, 5 moderate, 10 high, 1 critical)
- [ ] Yedek klasörünü güncelle (eğer istenirse)

---

## Notlar

- `WhatsYpzck-Afis.html` → Tanıtım afişi, HTML formatında, tarayıcıda açılabilir
- ONNX model dosyaları (~189 MB) installer derleme süresini uzatıyor (~5-6 dk)
- `husky install` komutu deprecated uyarısı veriyor ama sorun değil
