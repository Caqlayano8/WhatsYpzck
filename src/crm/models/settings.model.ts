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
            default: 'Coruh EDAS Artvin Il Mudurlugu'
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
    }
}, {
    timestamps: true
});

export const SettingsModel = mongoose.model('Settings', settingsSchema);
