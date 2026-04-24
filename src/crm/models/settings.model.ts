/**
 * Author: Ç.Kurtoğlu
 * Description: Settings Model - Sistem ayarları modeli
 */

import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema({
    maxFileSizeMb: {
        type: Number,
        default: 150
    },
    autoDownloadEnabled: {
        type: Boolean,
        default: true
    },
    defaultAudioAiCommand: {
        type: String,
        enum: ['chat', 'gpt', 'claude'],
        default: 'chat'
    },
    ollamaAssistant: {
        enabled: {
            type: Boolean,
            default: false
        },
        outsideFlowShortReplyEnabled: {
            type: Boolean,
            default: false
        },
        maxReplyChars: {
            type: Number,
            default: 240
        }
    },
    disabledCommands: {
        type: [String],
        default: []
    },
    commandStats: {
        type: Map,
        of: Number,
        default: {}
    },
    apiKeys: {
        type: Map,
        of: String,
        default: {}
    },
    inboundApiKey: {
        type: String,
        default: ''
    },
    aggressiveMode: {
        type: Boolean,
        default: false
    },
    restrictionsRemoved: {
        type: Boolean,
        default: false
    },
    maskPhoneNumbers: {
        type: Boolean,
        default: true
    },
    maskContactNames: {
        type: Boolean,
        default: true
    },
    smtp: {
        host:     { type: String, default: '' },
        port:     { type: Number, default: 587 },
        secure:   { type: Boolean, default: false },
        user:     { type: String, default: '' },
        pass:     { type: String, default: '' },
        fromName: { type: String, default: 'WhatsYpzck' },
        fromEmail:{ type: String, default: '' }
    },
    incidentRouting: {
        whatsappNumbers: {
            type: [String],
            default: []
        },
        emails: {
            type: [String],
            default: []
        }
    },
    notificationTemplates: {
        institutionName: {
            type: String,
            default: 'Kurum Bilgi Sistemi'
        },
        signatureName: {
            type: String,
            default: 'C. Kurtoglu'
        },
        closingLine: {
            type: String,
            default: 'Bilgilerinize sunariz.'
        },
        statusWhatsappTemplate: {
            type: String,
            default: 'Sayin Musterimiz,\n\nAriza kaydinizin durumu guncellenmistir.\nKayit No: {{incidentId}}\nGuncel Durum: {{statusLabel}}\nGuncelleme Zamani: {{updatedAt}}\n{{noteLine}}\n\n{{closingLine}}\n{{institutionName}}\nYetkili: {{signatureName}}'
        },
        statusEmailTemplate: {
            type: String,
            default: 'Sayin Musterimiz,\n\nAriza kaydinizin durumu guncellenmistir.\nKayit No: {{incidentId}}\nGuncel Durum: {{statusLabel}}\nGuncelleme Zamani: {{updatedAt}}\n{{noteLine}}\n\n{{closingLine}}\n{{institutionName}}\nYetkili: {{signatureName}}'
        },
        createdEmailTemplate: {
            type: String,
            default: 'Sayin Musterimiz,\n\nElektrik ariza bildiriminiz sistemimize basariyla kaydedilmistir.\nAsagida basvurunuza ait bilgiler yer almaktadir:\n\nKayit No: {{incidentId}}\nMusteri Ismi: {{customerName}}\nTelefon: {{customerPhone}}\nE-Posta: {{customerEmail}}\nAdres: {{address}}\nTesisat/Sayac No: {{meterNo}}\nOlusturma Zamani: {{createdAt}}\n\nBelirtmis oldugunuz ariza bildirimi yukaridaki gibidir. Lutfen bu bilgileri saklayiniz.\nDaha sonra bu bilgiler uzerinden ariza kaydinizi sorgulayabilirsiniz.\n\n{{closingLine}}\n{{institutionName}}\nYetkili: {{signatureName}}'
        }
    },
    botMessageTemplates: {
        kvkkMessage: {
            type: String,
            default: "Merhaba! 👋\n\nWhatsYpzck Elektrik Ariza Hatti'na hos geldiniz.\n\n📋 *KISISSEL VERILERIN KORUNMASI HAKKINDA BILDIRIM*\n\n6698 sayili Kisisel Verilerin Korunmasi Kanunu kapsaminda sizi bilgilendirmek istiyoruz:\n\n• Adiniz, soyadiniz, telefon numaraniz, adresiniz ve ariza bilgileriniz hizmet sunumu amaciyla islenecektir.\n• Verileriniz ucuncu kisilerle paylasilmayacaktir.\n• Verilerinize erisim, duzeltme ve silme haklariniz mevcuttur.\n\nDevam etmek icin *KABUL EDIYORUM* yaziniz."
        },
        welcomeMenuMessage: {
            type: String,
            default: "✅ KVKK onayiniz alindi, tesekkurler!\n\nMerhaba! Ben WhatsYpzck Elektrik Ariza Asistaniyim 🔧⚡\n\nSize nasil yardimci olabilecegimi secin:\n\n1️⃣ *Ariza veya sorun bildirmek istiyorum*\n2️⃣ *Mevcut talebimin durumunu ogrenmek istiyorum*\n\nLutfen *1* veya *2* yazin."
        },
        mainMenuMessage: {
            type: String,
            default: "Merhaba! Ben WhatsYpzck Elektrik Ariza Asistaniyim 🔧⚡\n\nSize nasil yardimci olabilecegimi secin:\n\n1️⃣ *Ariza veya sorun bildirmek istiyorum*\n2️⃣ *Mevcut talebimin durumunu ogrenmek istiyorum*\n\nLutfen *1* veya *2* yazin."
        },
        faultCategoryMessage: {
            type: String,
            default: "Arizanizin turunu belirtir misiniz? 🔍\n\n1️⃣ *Dagitim Altyapisi Arizasi*\n   📌 Mahallede/sokakta elektrik kesintisi\n   📌 Trafo veya direk arizasi\n   📌 Hat hasari, kablo kopmasi\n   📌 Sayac baglanti sorunu\n\n2️⃣ *Fatura / Abonelik Islemi*\n   📌 Fatura itirazi veya sorunu\n   📌 Tarife degisikligi\n   📌 Abonelik acma/kapatma\n   📌 Otomatik odeme sorunu\n\n3️⃣ *Ic Tesisat / Ev Ici Ariza*\n   📌 Ev icinde elektrik yok (sigorta atti vs.)\n   📌 Priz, anahtar, ic kablo arizasi\n   ⚠️ _Bu tur arizalar icin elektrikci gereklidir, dagitim sirketi mudahale etmez._\n\nLutfen *1*, *2* veya *3* yazin.\n\n📸 Isterseniz ariza fotografi da paylasabilirsiniz!\n📍 Konum paylasimi da kabul edilmektedir."
        },
        incidentStatusStartMessage: {
            type: String,
            default: 'Ariza durumunu sorgulayabilmemiz icin lutfen adinizi ve soyadinizi yaziniz.'
        },
        incidentStatusResultTemplate: {
            type: String,
            default: "*ARIZA DURUM BILGISI*\nKayit No: {{incidentId}}\nDurum: {{statusText}}\nOlusturma Zamani: {{createdAt}}\nSon Guncelleme: {{updatedAt}}\nAdres: {{address}}\nTesisat/Sayac No: {{meterNo}}"
        },
        incidentClosureNoOpenMessage: {
            type: String,
            default: 'Uzerinize kayitli kapatilabilecek acik talep bulunamadi. Dilerseniz mevcut talep numaranizi paylasabilirsiniz.'
        },
        incidentClosureSelectionMessage: {
            type: String,
            default: '*TALEP KAPATMA SECIMI*\nKapatmak istediginiz talep numarasini asagidaki listeden seciniz:\n\n{{incidentList}}\n\nLutfen kapatmak istediginiz talep numarasini yaziniz.'
        },
        incidentClosureConfirmMessage: {
            type: String,
            default: "Talep No: {{incidentId}}\nDurum: {{statusText}}\nTalebiniz en kisa sure icerisinde sonlandirilacaktir.\nOnayliyorsaniz lutfen sadece 'kabul ediyorum' yaziniz."
        },
        incidentClosureNeedApprovalMessage: {
            type: String,
            default: "Devam etmek icin lutfen sadece 'kabul ediyorum' yaziniz. Vazgecmek isterseniz 'sonra gorusuruz' yazabilirsiniz."
        },
        incidentClosureSuccessMessage: {
            type: String,
            default: 'Talep No: {{incidentId}}\nSizin isteginiz uzere talebiniz mudahale edilmeden kapatilmistir.\nBizi tercih ettiginiz icin tesekkur ederiz. Gorusmek uzere.'
        },
        personalizedMenuMessage: {
            type: String,
            default: 'Hos geldiniz, *{{firstName}}* 👋 Size hemen yardimci olabilirim.\n\nSize nasil yardimci olabilecegimi secin:\n\n1️⃣ *Ariza veya sorun bildirmek istiyorum*\n2️⃣ *Mevcut talebimin durumunu ogrenmek istiyorum*\n\nLutfen *1* veya *2* yazin.'
        },
        infoRedirectMessage: {
            type: String,
            default: 'Bu konuda size en dogru bilgiyi verebilmesi icin sizi canli bir temsilcimize yonlendirebiliriz. 🎧\n\nMusteri hizmetlerimize ulasmak icin:\n☎️ *186*\'yi arayabilirsiniz.\n🕐 7/24 hizmetinizdeyiz.\n\nIsterseniz su an *186*\'yi arayarak bir temsilcimizle gorusebilirsiniz. Sorununuz en kisa surede cozume kavusturulacaktir. 🙏\n\nElektrik arizasi veya mevcut talebinizle ilgili bir islem icin ise size hemen yardimci olabilirim.'
        },
        unknownQuestionMessage: {
            type: String,
            default: 'Uzgunuz, bu konuda size yardimci olamiyorum. 🙏\n\nDaha fazla bilgi icin *186*\'yi arayabilirsiniz. ☎️\n\nAncak asagidaki konularda size hemen yardimci olabilirim:\n⚡ *1. Ariza Bildirimi* — Elektrik kesintisi veya ariza kaydi olusturma\n📋 *2. Talep Durumu* — Mevcut ariza kaydinizin durumunu sorgulama\n❌ *3. Talep Iptali* — Acik talebinizi iptal etme\n\nBunlardan biri icin yardim almak ister misiniz?'
        },
        noEmailFallbackMessage: {
            type: String,
            default: 'E-posta bilginizin olmadigini belirttiniz. Iletisim icin telefon numaraniz kullanilacaktir.'
        },
        incidentCreatedSuccessMessage: {
            type: String,
            default: 'Tesekkur ederiz. Kaydiniz olusturuldu ve ilgili numaraya/eposta adresine gonderildi.'
        },
        incidentCreatedDispatchFailedMessage: {
            type: String,
            default: 'Kaydiniz olusturuldu ancak su an yonlendirme yapilamadi. Sistem ayarlari kontrol edilmelidir.'
        },
        chatMediaPreviewText: {
            type: String,
            default: 'Fotograf gonderildi'
        }
    },
    botIdentity: {
        name:   { type: String, default: 'WhatsYpzck' },
        author: { type: String, default: 'Ç. Kurtoğlu' },
    },
    maintenanceMode: {
        enabled: { type: Boolean, default: false },
        message: { type: String,  default: '' },
        endsAt:  { type: Date,    default: null },
    },
    survey: {
        enabled: { type: Boolean, default: false },
        triggerStatus: { type: String, default: 'COZUMLENDI,KAPATILDI' },
        message: {
            type: String,
            default: 'Sayin {{customerName}},\n\nAriza kaydınız ({{incidentId}}) cozumlendi. Hizmetimizi degerlendirmenizi rica ederiz.\n\n1️⃣ - Cok Kotü\n2️⃣ - Kotü\n3️⃣ - Orta\n4️⃣ - Iyi\n5️⃣ - Cok Iyi\n\nLütfen 1-5 arasında bir puan gönderin.'
        },
        thankYouMessage: {
            type: String,
            default: 'Degerlendirmeniz için tesekkür ederiz! Geri bildiriminiz bizim için çok değerli.'
        },
    },
}, {
    timestamps: true
});

export const SettingsModel = mongoose.model('Settings', settingsSchema);
