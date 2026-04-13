/**
 * Author: Ç.Kurtoğlu
 * Description: Bot manager - WhatsApp mesaj yönetimi ve komut işleme
 */

import WAWebJS, { Client, Message, MessageMedia, MessageTypes } from "whatsapp-web.js";
import axios from "axios";
import { AppConfig } from "./configs/app.config";
import { ClientConfig } from "./configs/client.config";
import EnvConfig from "./configs/env.config";
import logger from "./configs/logger.config";
import { UserI18n } from "./utils/content/i18n.util";
import commands from "./commands";
import { onboard } from "./utils/content/onboarding.util";
import { ContactModel } from "./crm/models/contact.model";
import { SettingsModel } from "./crm/models/settings.model";
import { MessageModel } from "./crm/models/message.model";
import { ScoreRuleModel } from "./crm/models/score-rule.model";
import { CampaignModel } from "./crm/models/campaign.model";
import { messageEmitter } from "./utils/events/message-emitter.util";
import { AutoReplyModel } from "./crm/models/auto-reply.model";
import { IncidentModel } from "./crm/models/incident.model";
import { fireEvent } from "./utils/events/fire-event.util";
import { claudeCompletion } from "./utils/ai/claude.util";
import { FlowModel } from "./crm/models/flow.model";
import { FlowSessionModel } from "./crm/models/flow-session.model";
import { ollamaChat } from "./utils/ai/ollama.util";
import { getInternetContext, shouldUseInternetLookup } from "./utils/ai/internet-search.util";
import { getRelevantMemoryContext, saveInteractionMemory } from "./utils/ai/interaction-memory.util";
import { formatTrDateTime, formatTrTime, getTrNow, TR_TIME_ZONE } from "./utils/system/datetime.util";
import { normalizeConversationPhone } from "./utils/whatsapp/conversation-phone.util";
import { ContactGroupModel } from "./crm/models/contact-group.model";
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Per-contact auto-reply cooldown: phone → last triggered timestamp
const autoReplyCooldown = new Map<string, Map<string, Date>>();

async function applyScore(phoneNumber: string, action: string) {
    try {
        const rule = await ScoreRuleModel.findOne({ action, enabled: true }).lean();
        if (rule) {
            await ContactModel.updateOne({ phoneNumber }, { $inc: { score: rule.points } });
        }
    } catch (_) { /* non-critical */ }
}

export class BotManager {
    private static instance: BotManager;
    public client: any;
    public qrData = {
        qrCodeData: "",
        qrScanned: false,
        authenticated: false
    };
    private userI18nCache = new Map<string, UserI18n>();
    private kvkkAcceptedPhones = new Map<string, boolean>();
    private aiConversationState = new Map<string, {
        active: boolean;
        history: string[];
        infoProvided: boolean;
        dispatchDone: boolean;
        kvkkAccepted?: boolean;
        menuStep?: 'waiting';
        faultCategoryStep?: 'waiting';
        locationCoords?: { lat: number; lng: number } | null;
        pendingPhotoUrls?: string[];
        incidentFlow?: {
            active: boolean;
            awaiting: "issue" | "name" | "phone" | "address" | "askPhoto" | "photo" | "askLocation" | "location" | "meter" | "email" | "confirm" | "correctionField";
            correctingSingleField?: boolean;
            photoCoords?: { lat: number; lng: number } | null;
            locationCoords?: { lat: number; lng: number } | null;
            photoUrls?: string[];
            requestCategory?: "distribution" | "billing";
            data: {
                issueDescription: string;
                customerName: string;
                customerPhone: string;
                address: string;
                meterNo: string;
                customerEmail: string;
            };
        };
        statusFlow?: {
            active: boolean;
            awaiting: "name" | "phone" | "incidentId";
            data: {
                customerName: string;
                customerPhone: string;
                incidentId: string;
            };
        };
    }>();
    private prefix = AppConfig.instance.getBotPrefix();
    private processedMessageIds = new Map<string, number>();
    private perPhoneQueue = new Map<string, Promise<void>>();
    private aiInflight = 0;
    private aiWaitQueue: Array<() => void> = [];
    private readonly maxAiConcurrency = Math.max(1, Number(process.env.AI_MAX_CONCURRENCY || 2));
    private readonly maxAiQueueSize = Math.max(1, Number(process.env.AI_MAX_QUEUE_SIZE || 30));
    private readonly aiHybridEnabled = String(process.env.AI_HYBRID_ENABLED || "true").toLowerCase() !== "false";
    private readonly aiHybridTriggerInflight = Math.max(1, Number(process.env.AI_HYBRID_TRIGGER_INFLIGHT || 3));
    // Temporarily stores saved image URLs between the persist block and processMessageContent per phone
    private pendingMediaUrls = new Map<string, string>();
    private readonly aiHybridTriggerQueue = Math.max(0, Number(process.env.AI_HYBRID_TRIGGER_QUEUE || 1));
    private aiReplyCache = new Map<string, { reply: string; expiresAt: number }>();
    private readonly aiReplyCacheTtlMs = Math.max(0, Number(process.env.AI_REPLY_CACHE_TTL_MS || 45000));

    private async runInPhoneQueue<T>(phoneNumber: string, task: () => Promise<T>): Promise<T> {
        const prev = this.perPhoneQueue.get(phoneNumber) || Promise.resolve();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const next = prev.then(() => gate, () => gate);
        this.perPhoneQueue.set(phoneNumber, next);

        await prev;
        try {
            return await task();
        } finally {
            release();
            await next.catch(() => undefined);
            const current = this.perPhoneQueue.get(phoneNumber);
            if (current === next) {
                this.perPhoneQueue.delete(phoneNumber);
            }
        }
    }

    private getCachedAiReply(cacheKey: string): string | null {
        const cached = this.aiReplyCache.get(cacheKey);
        if (!cached) return null;
        if (cached.expiresAt <= Date.now()) {
            this.aiReplyCache.delete(cacheKey);
            return null;
        }
        return cached.reply;
    }

    private setCachedAiReply(cacheKey: string, reply: string) {
        if (this.aiReplyCacheTtlMs <= 0) return;
        this.aiReplyCache.set(cacheKey, {
            reply,
            expiresAt: Date.now() + this.aiReplyCacheTtlMs
        });

        if (this.aiReplyCache.size > 500) {
            const now = Date.now();
            for (const [key, value] of this.aiReplyCache.entries()) {
                if (value.expiresAt <= now) {
                    this.aiReplyCache.delete(key);
                }
            }
        }
    }

    private async runWithAiConcurrencyLimit<T>(task: () => Promise<T>): Promise<T> {
        if (this.aiInflight >= this.maxAiConcurrency) {
            if (this.aiWaitQueue.length >= this.maxAiQueueSize) {
                throw new Error("AI_QUEUE_FULL");
            }

            await new Promise<void>((resolve) => {
                this.aiWaitQueue.push(resolve);
            });
        }

        this.aiInflight += 1;
        try {
            return await task();
        } finally {
            this.aiInflight = Math.max(0, this.aiInflight - 1);
            const next = this.aiWaitQueue.shift();
            if (next) next();
        }
    }

    private shouldUseHybridFallback(): boolean {
        if (!this.aiHybridEnabled) return false;
        return this.aiInflight >= this.aiHybridTriggerInflight || this.aiWaitQueue.length >= this.aiHybridTriggerQueue;
    }

    private pushAiHistory(aiState: { history: string[] }, userText: string, assistantText: string) {
        aiState.history.push(`Kullanici: ${String(userText || "").slice(0, 180)}`);
        aiState.history.push(`Temsilci: ${String(assistantText || "").slice(0, 220)}`);
        if (aiState.history.length > 8) {
            aiState.history = aiState.history.slice(-8);
        }
    }

    private buildHybridQuickReply(text: string, infoProvided: boolean): string {
        if (this.isOutageComplaint(text)) {
            return this.applyEmojiPolicy(
                this.normalizeInstitutionalLanguage(this.buildOutageReply(!infoProvided))
            );
        }

        if (infoProvided) {
            return "Mesajinizi aldim. Su an yogunluk var; detayli yaniti kisa bir sure icinde iletecegim.";
        }

        return "Mesajinizi aldim. Su an yogunluk var; once hizli on yanit veriyorum. Detayli yanit birazdan gelecek.";
    }

    private async composeAiReply(text: string, prompt: string, systemPrompt: string): Promise<{ aiReply: string; aiReplyBase: string }> {
        let webContext = "";
        let webSourceLinks: string[] = [];
        let memoryContext = "";
        const webLookupEnabled = String(process.env.AI_WEB_LOOKUP_ENABLED || "true").toLowerCase() !== "false";

        if (webLookupEnabled && shouldUseInternetLookup(text)) {
            const webLookup = await getInternetContext(text);
            webContext = webLookup.context;
            webSourceLinks = webLookup.sourceLinks;
        }

        memoryContext = getRelevantMemoryContext(text, 3);

        const promptPieces = [prompt];
        if (memoryContext) {
            promptPieces.push(
                "",
                "Gecmis etkileşim hafizasi (daha tutarli cevap icin):",
                memoryContext
            );
        }
        if (webContext) {
            promptPieces.push(
                "",
                "Internetten cekilen baglam (ozet, dogrulama gerektirebilir):",
                webContext,
                "",
                "Yanitinda bu baglami dikkate al; emin olmadigin bilgiyi netce belirt."
            );
        }
        const promptWithContext = promptPieces.join("\n");

        const aiReplyRaw = await ollamaChat(promptWithContext, systemPrompt);
        const aiReplyBase = this.applyEmojiPolicy(
            this.normalizeInstitutionalLanguage(String(aiReplyRaw || "").trim())
        );
        const aiReply = this.appendSourceLinks(aiReplyBase, webSourceLinks);
        return { aiReply, aiReplyBase };
    }

    private shouldSkipMessage(message: Message): boolean {
        // Process only incoming user messages. Outgoing bot/user-self messages can cause reply loops.
        if ((message as any).fromMe) {
            return true;
        }

        const messageId = (message as any)?.id?._serialized;
        if (!messageId) {
            return false;
        }

        const now = Date.now();
        const ttlMs = 5 * 60 * 1000;
        const existing = this.processedMessageIds.get(messageId);
        if (existing && (now - existing) < ttlMs) {
            return true;
        }

        this.processedMessageIds.set(messageId, now);

        // Opportunistic cleanup to keep memory stable.
        if (this.processedMessageIds.size > 5000) {
            for (const [key, ts] of this.processedMessageIds.entries()) {
                if ((now - ts) > ttlMs) {
                    this.processedMessageIds.delete(key);
                }
            }
        }

        return false;
    }

    private normalizeIntentToken(value: string): string {
        return String(value || "")
            .toLowerCase()
            .replace(/ı/g, "i")
            .replace(/ğ/g, "g")
            .replace(/ü/g, "u")
            .replace(/ş/g, "s")
            .replace(/ö/g, "o")
            .replace(/ç/g, "c")
            .replace(/[^a-z0-9]/g, "")
            .trim();
    }

    private resolveCommandAlias(token: string): string {
        const normalized = this.normalizeIntentToken(token);
        const aliases: Record<string, string> = {
            merhaba: "merhaba",
            selam: "merhaba",
            selamlar: "merhaba",
            hey: "merhaba",
            sa: "merhaba",
            slm: "merhaba",
            gunaydin: "merhaba",
            iyiaksamlar: "merhaba",
            iyigunler: "merhaba"
        };
        return aliases[normalized] || normalized;
    }

    private normalizeInstitutionalLanguage(text: string): string {
        return String(text || "")
            .replace(/\bsenin\s+iyiyim\b/gi, "ben iyiyim")
            .replace(/\bsenin\s+iyi\s+misin\b/gi, "ben iyiyim")
            .replace(/te[sş]ekk[uü]r\s+ederim,?\s*senin\s+iyiyim/gi, "Teşekkür ederim, ben iyiyim")
            .replace(/te[sş]ekk[uü]r\s+ederim,?\s*senin\s+yard[iı]m[ıi]n[ıi]\s+istedi[gğ]in\s+i[cç]in\.?/gi, "Size yardım edebilmek için buradayız.")
            .replace(/senin\s+yard[iı]m[ıi]n[ıi]\s+istedi[gğ]in\s+i[cç]in\.?/gi, "Size yardım edebilmek için buradayız.")
            .replace(/ne\s+kadar\s+elektrik\s+ar[iı]zas[ıi]\s+ya[sş][ıi]yorsunuz\??/gi, "Elektrik arızası hangi adreste ve ne zamandır devam ediyor?")
            .replace(/\bburday[iı]z\b/gi, "buradayız")
            .replace(/sizinle\s+ileti[sş]ime\s+ge[cç]ebilirsiniz/gi, "bizimle iletişime geçebilirsiniz")
            .replace(/sizinle\s+ileti[sş]ime\s+ge[cç]in/gi, "bizimle iletişime geçin")
            .replace(/sizinle\s+irtibata\s+ge[cç]ebilirsiniz/gi, "bizimle irtibata geçebilirsiniz")
            .replace(/sizinle\s+irtibata\s+ge[cç]in/gi, "bizimle irtibata geçin")
                .replace(/\bbana\b/gi, "bize")
                .replace(/\bbeni\b/gi, "bizi")
                .replace(/\bbenimle\b/gi, "bizimle")
                .replace(/yard[iı]mc[iı]\s+olay[iı]m\s+m[iı]\??/gi, "yardımcı olalım mı?")
                .replace(/yard[iı]m\s+edeyim\s+mi\??/gi, "yardım edelim mi?")
                .replace(/benim\s+mahallemde\s+elektrik\s+kesintisi\s+mevcut\s+de[gğ]il\.?/gi, "Belirttiğiniz bölgede kesinti bilgisini teyit edebilmemiz için açık adresinizi paylaşmanızı rica ederiz.")
                .replace(/t[uü]rkiye\s*'?nin\s*ba[sş]kenti\s*t[uü]rkistan(?:'d[ıi]r)?\.?/gi, "Türkiye'nin başkenti Ankara'dır.")
            .replace(/\bsenin\b/gi, "sizin")
            .replace(/\bsen\b/gi, "siz")
            .trim();
    }

    private applyEmojiPolicy(text: string): string {
        return String(text || "")
            // Hearts (strictly forbidden)
            .replace(/[❤️❤💖💗💓💞💕💘💝💟🫶]/gu, "")
            // Angry emojis (strictly forbidden)
            .replace(/[😠😡🤬👿💢]/gu, "")
            // Cleanup extra spaces that may remain after emoji removal
            .replace(/\s{2,}/g, " ")
            .trim();
    }

    private appendSourceLinks(answer: string, sourceLinks: string[]): string {
        const cleanedAnswer = String(answer || "").trim();
        const links = Array.from(new Set((sourceLinks || []).map((url) => String(url || "").trim()).filter(Boolean))).slice(0, 3);
        if (!links.length) {
            return cleanedAnswer;
        }

        const sourceLines = links.map((url, idx) => `${idx + 1}. ${url}`).join("\n");
        return `${cleanedAnswer}\n\nKaynaklar:\n${sourceLines}`;
    }

    private sanitizeMeterNo(value: string): string {
        return String(value || "")
            .trim()
            .replace(/[.,;:!?]+$/g, "")
            .replace(/\s+/g, "")
            .replace(/^['"`]+|['"`]+$/g, "");
    }

    private isValidMeterNo(value: string): boolean {
        const v = this.sanitizeMeterNo(value);
        if (!v) return false;
        if (/^(\+?90)?0?5\d{9}$/.test(v)) return false;
        if (!/^[A-Za-z0-9-]{5,30}$/.test(v)) return false;
        const digitCount = (v.match(/\d/g) || []).length;
        const hasLetter = /[A-Za-z]/.test(v);
        return digitCount >= 5 && (hasLetter || /^\d{5,20}$/.test(v));
    }

    private normalizeTurkishPhone(value: string): string | null {
        const digits = String(value || "").replace(/\D/g, "");
        if (!digits) return null;
        if (digits.length === 10 && digits.startsWith("5")) return `90${digits}`;
        if (digits.length === 11 && digits.startsWith("0") && digits[1] === "5") return `90${digits.slice(1)}`;
        if (digits.length === 12 && digits.startsWith("90") && digits[2] === "5") return digits;
        if (digits.length === 13 && digits.startsWith("0090") && digits[4] === "5") return digits.slice(2);
        return null;
    }

    private isValidEmail(value: string): boolean {
        const email = String(value || "").trim().toLowerCase();
        if (!email || email.length > 254) return false;
        return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email);
    }

    private isPositiveConfirmation(value: string): boolean {
        const t = String(value || "")
            .trim()
            .toLowerCase()
            .replace(/ı/g, "i")
            .replace(/ğ/g, "g")
            .replace(/ü/g, "u")
            .replace(/ö/g, "o")
            .replace(/ş/g, "s")
            .replace(/ç/g, "c");

        return /^(evet|e|onay|onayliyorum|dogru|dogrudur|tamam|tamamdir|olur)(\b|$)/.test(t);
    }

    private isNegativeConfirmation(value: string): boolean {
        const t = String(value || "")
            .trim()
            .toLowerCase()
            .replace(/ı/g, "i")
            .replace(/ğ/g, "g")
            .replace(/ü/g, "u")
            .replace(/ö/g, "o")
            .replace(/ş/g, "s")
            .replace(/ç/g, "c");

        return /^(hayir|hayi|hayr|h|yanlis|degil|duzelt|duzeltelim|tekrar)(\b|$)/.test(t);
    }

    private parseIncidentCorrectionField(value: string): "issue" | "name" | "phone" | "address" | "meter" | "email" | null {
        const t = String(value || "")
            .trim()
            .toLowerCase()
            .replace(/ı/g, "i")
            .replace(/ğ/g, "g")
            .replace(/ü/g, "u")
            .replace(/ö/g, "o")
            .replace(/ş/g, "s")
            .replace(/ç/g, "c");

        if (/\bariza\b|\bsorun\b|\btalep\b|\baciklama\b/.test(t)) return "issue";
        if (/\badres\b|\bmahalle\b|\bsokak\b|\bcadde\b/.test(t)) return "address";
        if (/\btelefon\b|\bnumara\b|\bgsm\b/.test(t)) return "phone";
        if (/\btesisat\b|\bsayac\b|\babone\b/.test(t)) return "meter";
        if (/\be-?posta\b|\bmail\b/.test(t)) return "email";
        if (/\bad soyad\b|\bisim\b|\bsoyad\b/.test(t)) return "name";
        return null;
    }

    private async promptIncidentCorrectionField(
        message: Message,
        flow: {
            awaiting: "issue" | "name" | "phone" | "address" | "askPhoto" | "photo" | "askLocation" | "location" | "meter" | "email" | "confirm" | "correctionField";
            correctingSingleField?: boolean;
            data: { issueDescription: string; customerName: string; customerPhone: string; address: string; meterNo: string; customerEmail: string };
        },
        correctionField: "issue" | "name" | "phone" | "address" | "meter" | "email"
    ): Promise<void> {
        logger.info(`Incident correction field selected: ${correctionField}`);
        flow.awaiting = correctionField;
        flow.correctingSingleField = true;

        if (correctionField === "issue") {
            flow.data.issueDescription = "Bilinmiyor";
            await this.safeReply(message, "Ariza detayini tekrar kisa bir sekilde paylasir misiniz?");
            return;
        }
        if (correctionField === "name") {
            flow.data.customerName = "Bilinmiyor";
            await this.safeReply(message, "Lutfen dogru ad soyad bilginizi yazin.");
            return;
        }
        if (correctionField === "phone") {
            flow.data.customerPhone = "Bilinmiyor";
            await this.safeReply(message, "Lutfen dogru telefon numaranizi yazin. Ornek: 05XXXXXXXXX");
            return;
        }
        if (correctionField === "address") {
            flow.data.address = "Bilinmiyor";
            await this.safeReply(message, "Lutfen dogru acik adresinizi yazin.");
            return;
        }
        if (correctionField === "meter") {
            flow.data.meterNo = "Bilinmiyor";
            await this.safeReply(message, "Lutfen dogru tesisat no veya sayac no veya abone no bilginizi yazin.");
            return;
        }

        flow.data.customerEmail = "Bilinmiyor";
        await this.safeReply(message, "Lutfen dogru e-posta adresinizi yazin. Ornek: ad.soyad@example.com");
    }

    private buildPhotoConsentPrompt(): string {
        return "Arizaniza ait bir fotograf eklemek ister misiniz? Lutfen 'evet' veya 'hayir' yazin.";
    }

    private buildPhotoUploadPrompt(): string {
        return "Lutfen fotografi yukleyin veya kameradan cekip gonderin.";
    }

    private buildLocationConsentPrompt(): string {
        return "Konum eklemek ister misiniz? Lutfen 'evet' veya 'hayir' yazin.";
    }

    private buildLocationSharePrompt(): string {
        return "Lutfen WhatsApp konum paylasma ozelligi ile konumunuzu gonderin.";
    }

    private buildIncidentSummaryText(data: { issueDescription: string; customerName: string; customerPhone: string; address: string; meterNo: string; customerEmail: string }): string {
        return [
            "Bilgileri toplu olarak teyit eder misiniz?",
            `Ariza: ${data.issueDescription}`,
            `Ad Soyad: ${data.customerName}`,
            `Telefon: ${data.customerPhone}`,
            `Adres: ${data.address}`,
            `Tesisat/Sayac/Abone No: ${data.meterNo}`,
            `E-Posta: ${data.customerEmail}`,
            "Bilgiler dogruysa lutfen sadece 'evet' yazin.",
            "Yanlis bilgi varsa lutfen once 'hayir' yazin; sonra sadece yanlis alani secip guncelleyebilirsiniz."
        ].join("\n");
    }

    private getFirstMissingIncidentField(data: { issueDescription: string; customerName: string; customerPhone: string; address: string; meterNo: string; customerEmail: string }): "issue" | "name" | "phone" | "address" | "meter" | "email" | "confirm" {
        if (!data.issueDescription || data.issueDescription === "Bilinmiyor") return "issue";
        if (!data.customerName || data.customerName === "Bilinmiyor") return "name";
        if (!data.customerPhone || data.customerPhone === "Bilinmiyor") return "phone";
        if (!data.address || data.address === "Bilinmiyor") return "address";
        if (!data.meterNo || data.meterNo === "Bilinmiyor") return "meter";
        if (!data.customerEmail || data.customerEmail === "Bilinmiyor") return "email";
        return "confirm";
    }

    private parseIncidentIntent(text: string): boolean {
        const t = String(text || "").toLowerCase();
        return /ar[ıi]za|kesinti|elektrik\s+yok|tesisat|sayac|saya[cç]|abone\s*no|fatura|abonelik|tarife|otomatik\s*odeme/.test(t);
    }

    private parseIncidentStatusIntent(text: string): boolean {
        const t = String(text || "").toLowerCase();
        return /ar[ıi]za.*durum|durum.*ar[ıi]za|ar[ıi]za\s*(kayd[ıi]|no|numara).*sorgu|ar[ıi]za\s*(sorgula|sorgulama)|kay[ıi]t\s*no.*(durum|sorgu)|ar[ıi]zam[ıi]n\s*durumu/.test(t);
    }

    private parseDateTimeIntent(text: string): boolean {
        const t = String(text || "").toLowerCase();
        return /(saat\s*(kac|kaç|nedir|ne)|kac\s*saat|kaç\s*saat|bugun\s*(tarih|hangi\s*gun)|bugun\s*gunlerden\s*ne|tarih\s*(nedir|ne)|tarih\s*saat|simdi\s*saat\s*kac|şimdi\s*saat\s*kaç)/.test(t);
    }

    private parseIdentityIntent(text: string): boolean {
        const t = String(text || "").toLowerCase();
        return /(sen\s*kimsin|kiminle\s*konusuyorum|ad[inı]\s*ne|ad[ıi]n\s*ne|sen\s*nesin|kimsin\b|bot\s*musun)/.test(t);
    }

    private buildIdentityReply(): string {
        return [
            "Ben elektrik ariza musteri hizmetleri icin hizmet veren WhatsYpzck destek asistaniyim.",
            "",
            "Size hizli yardimci olabilmem icin iki secenek var:",
            "1. Ariza kaydi icin yasanan sorunu kisaca yazin.",
            "2. Durum sorgusu icin 'arizam ne durumda' yazin."
        ].join("\n");
    }

    private buildCurrentDateTimeReply(): string {
        const now = getTrNow();
        const dateText = now.toLocaleDateString("tr-TR", {
            timeZone: TR_TIME_ZONE,
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric"
        });
        const timeText = formatTrTime(now);

        return `Anlik tarih/saat bilgisi (TR): ${dateText}, ${timeText}.`;
    }

    private normalizeIncidentId(value: string): string {
        const raw = String(value || "").toUpperCase().trim();
        const compact = raw.replace(/\s+/g, "");
        if (/^ARZ-\d{6,}$/.test(compact)) return compact;
        const digits = compact.replace(/\D/g, "");
        if (digits.length >= 6) return `ARZ-${digits}`;
        return "";
    }

    private incidentStatusText(status: string): string {
        const map: Record<string, string> = {
            ALINDI: "Kayit alindi",
            INCELEMEDE: "Incelemede",
            ISLEME_ALINDI: "Isleme alindi",
            COZUMLENDI: "Cozumlendi",
            KAPATILDI: "Kapatildi"
        };
        return map[String(status || "").toUpperCase()] || "Bilinmiyor";
    }

    private async safeReply(message: Message, text: string): Promise<void> {
        try {
            if (this.client && typeof this.client.sendMessage === "function" && message?.from) {
                await this.client.sendMessage(message.from, text);
                return;
            }
        } catch (_) {
            // fallback below
        }
        try {
            const chat = await message.getChat();
            if (chat && typeof (chat as any).sendMessage === "function") {
                await (chat as any).sendMessage(text);
                return;
            }
        } catch (_) {
            // fallback below
        }
        await message.reply(text);
    }

    private isKvkkAccepted(phoneNumber: string): boolean {
        return this.kvkkAcceptedPhones.has(phoneNumber) ||
            !!(this.aiConversationState.get(phoneNumber)?.kvkkAccepted);
    }

    private isKvkkResponse(text: string): boolean {
        const normalized = String(text || "")
            .trim()
            .toLowerCase()
            .replace(/ı/g, "i")
            .replace(/ğ/g, "g")
            .replace(/ü/g, "u")
            .replace(/ş/g, "s")
            .replace(/ö/g, "o")
            .replace(/ç/g, "c");
        return /^(kabul ediyorum|kabul|evet|onayliyorum)(\b|$)/.test(normalized);
    }

    private buildKvkkMessage(): string {
        return [
            "Merhaba! 👋",
            "",
            "WhatsYpzck Elektrik Arıza Hattı'na hoş geldiniz.",
            "",
            "📋 *KİŞİSEL VERİLERİN KORUNMASI HAKKINDA BİLDİRİM*",
            "",
            "6698 sayılı Kişisel Verilerin Korunması Kanunu kapsamında sizi bilgilendirmek istiyoruz:",
            "",
            "• Adınız, soyadınız, telefon numaranız, adresiniz ve arıza bilgileriniz hizmet sunumu amacıyla işlenecektir.",
            "• Verileriniz üçüncü kişilerle paylaşılmayacaktır.",
            "• Verilerinize erişim, düzeltme ve silme haklarınız mevcuttur.",
            "",
            "Devam etmek için *KABUL EDİYORUM* yazınız."
        ].join("\n");
    }

    private buildWelcomeMenuMessage(): string {
        return [
            "✅ KVKK onayınız alındı, teşekkürler!",
            "",
            "Merhaba! Ben WhatsYpzck Elektrik Arıza Asistanıyım 🔧⚡",
            "",
            "Size nasıl yardımcı olabileceğimi seçin:",
            "",
            "1️⃣ *Arıza veya sorun bildirmek istiyorum*",
            "2️⃣ *Mevcut talebimin durumunu öğrenmek istiyorum*",
            "",
            "Lütfen *1* veya *2* yazın."
        ].join("\n");
    }

    private buildMainMenuMessage(): string {
        return [
            "Merhaba! Ben WhatsYpzck Elektrik Arıza Asistanıyım 🔧⚡",
            "",
            "Size nasıl yardımcı olabileceğimi seçin:",
            "",
            "1️⃣ *Arıza veya sorun bildirmek istiyorum*",
            "2️⃣ *Mevcut talebimin durumunu öğrenmek istiyorum*",
            "",
            "Lütfen *1* veya *2* yazın."
        ].join("\n");
    }

    private buildFaultCategoryMessage(): string {
        return [
            "Arızanızın türünü belirtir misiniz? 🔍",
            "",
            "1️⃣ *Dağıtım Altyapısı Arızası*",
            "   📌 Mahallede/sokakta elektrik kesintisi",
            "   📌 Trafo veya direk arızası",
            "   📌 Hat hasarı, kablo kopması",
            "   📌 Sayaç bağlantı sorunu",
            "",
            "2️⃣ *Fatura / Abonelik İşlemi*",
            "   📌 Fatura itirazı veya sorunu",
            "   📌 Tarife değişikliği",
            "   📌 Abonelik açma/kapatma",
            "   📌 Otomatik ödeme sorunu",
            "",
            "3️⃣ *İç Tesisat / Ev İçi Arıza*",
            "   📌 Ev içinde elektrik yok (sigorta attı vs.)",
            "   📌 Priz, anahtar, iç kablo arızası",
            "   ⚠️ _Bu tür arızalar için elektrikçi gereklidir, dağıtım şirketi müdahale etmez._",
            "",
            "Lütfen *1*, *2* veya *3* yazın.",
            "",
            "📸 İsterseniz arıza fotoğrafı da paylaşabilirsiniz!",
            "📍 Konum paylaşımı da kabul edilmektedir."
        ].join("\n");
    }

    private async extractPhotoExifCoords(message: Message): Promise<{ lat: number; lng: number } | null> {
        try {
            const media = await message.downloadMedia();
            if (!media?.data) return null;
            const buffer = Buffer.from(media.data, 'base64');
            const exifr = await import('exifr');
            const gps = await (exifr.default || exifr).gps(buffer);
            if (gps?.latitude && gps?.longitude) {
                return { lat: gps.latitude, lng: gps.longitude };
            }
        } catch (_) { /* non-critical */ }
        return null;
    }

    private async processIncidentStatusFlow(message: Message, aiState: {
        active: boolean;
        history: string[];
        infoProvided: boolean;
        dispatchDone: boolean;
        statusFlow?: {
            active: boolean;
            awaiting: "name" | "phone" | "incidentId";
            data: { customerName: string; customerPhone: string; incidentId: string };
        };
    }, text: string): Promise<boolean> {
        let justStarted = false;

        if (!aiState.statusFlow?.active) {
            if (!this.parseIncidentStatusIntent(text)) {
                return false;
            }
            aiState.statusFlow = {
                active: true,
                awaiting: "name",
                data: {
                    customerName: "Bilinmiyor",
                    customerPhone: "Bilinmiyor",
                    incidentId: "Bilinmiyor"
                }
            };
            justStarted = true;
        }

        const flow = aiState.statusFlow;
        if (!flow) return false;

        if (justStarted && flow.awaiting === "name") {
            await this.safeReply(message, "Ariza durumunu sorgulayabilmemiz icin lutfen adinizi ve soyadinizi yaziniz.");
            return true;
        }

        if (flow.awaiting === "name") {
            const name = String(text || "").trim();
            if (name.length < 3 || !/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(name)) {
                await this.safeReply(message, "Ad soyad bilginizi kontrol ederek tekrar yaziniz. Ornek: Ahmet Yilmaz");
                return true;
            }
            flow.data.customerName = name;
            flow.awaiting = "phone";
            await this.safeReply(message, "Tesekkur ederiz. Simdi telefon numaranizi yaziniz. Ornek: 05XXXXXXXXX");
            return true;
        }

        if (flow.awaiting === "phone") {
            const normalizedPhone = this.normalizeTurkishPhone(text);
            if (!normalizedPhone) {
                await this.safeReply(message, "Telefon numarasi gecersiz gorunuyor. Lutfen 05XXXXXXXXX formatinda tekrar yaziniz.");
                return true;
            }
            flow.data.customerPhone = normalizedPhone;
            flow.awaiting = "incidentId";
            await this.safeReply(message, "Lutfen ariza kayit numaranizi yaziniz. Ornek: ARZ-1773396737967");
            return true;
        }

        if (flow.awaiting === "incidentId") {
            const incidentId = this.normalizeIncidentId(text);
            if (!incidentId) {
                await this.safeReply(message, "Ariza kayit numarasi gecersiz gorunuyor. Lutfen ARZ- ile baslayan kayit noyu tekrar yaziniz.");
                return true;
            }
            flow.data.incidentId = incidentId;

            const escapedName = String(flow.data.customerName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const record = await IncidentModel.findOne({
                incidentId,
                customerPhone: flow.data.customerPhone,
                customerName: { $regex: `^${escapedName}$`, $options: 'i' }
            }).lean() as any;

            flow.active = false;

            if (!record) {
                await this.safeReply(message, "Belirttiginiz bilgilerle eslesen bir ariza kaydi bulunamadi. Lutfen ad soyad, telefon ve kayit numaranizi kontrol ederek tekrar deneyiniz.");
                return true;
            }

            await this.safeReply(message, [
                "*ARIZA DURUM BILGISI*",
                `Kayit No: ${record.incidentId}`,
                `Durum: ${this.incidentStatusText(record.status)}`,
                `Olusturma Zamani: ${formatTrDateTime(record.createdAt)}`,
                `Son Guncelleme: ${formatTrDateTime(record.updatedAt)}`,
                `Adres: ${record.address || 'Bilinmiyor'}`,
                `Tesisat/Sayac No: ${record.meterNo || 'Bilinmiyor'}`
            ].join("\n"));
            return true;
        }

        return false;
    }

    private mergeIncidentData(base: { issueDescription: string; customerName: string; customerPhone: string; address: string; meterNo: string; customerEmail: string }, incoming: { issueDescription: string; customerName: string; customerPhone: string; address: string; meterNo: string; customerEmail: string }) {
        return {
            issueDescription: incoming.issueDescription !== "Bilinmiyor" ? incoming.issueDescription : base.issueDescription,
            customerName: incoming.customerName !== "Bilinmiyor" ? incoming.customerName : base.customerName,
            customerPhone: incoming.customerPhone !== "Bilinmiyor" ? incoming.customerPhone : base.customerPhone,
            address: incoming.address !== "Bilinmiyor" ? incoming.address : base.address,
            meterNo: incoming.meterNo !== "Bilinmiyor" ? incoming.meterNo : base.meterNo,
            customerEmail: incoming.customerEmail !== "Bilinmiyor" ? incoming.customerEmail : base.customerEmail
        };
    }

    private async processIncidentFlow(message: Message, phoneNumber: string, aiState: {
        active: boolean;
        history: string[];
        infoProvided: boolean;
        dispatchDone: boolean;
        incidentFlow?: {
            active: boolean;
            awaiting: "issue" | "name" | "phone" | "address" | "askPhoto" | "photo" | "askLocation" | "location" | "meter" | "email" | "confirm" | "correctionField";
            correctingSingleField?: boolean;
            photoCoords?: { lat: number; lng: number } | null;
            locationCoords?: { lat: number; lng: number } | null;
            photoUrls?: string[];
            requestCategory?: "distribution" | "billing";
            data: { issueDescription: string; customerName: string; customerPhone: string; address: string; meterNo: string; customerEmail: string };
        };
    }, text: string): Promise<boolean> {
        let justStarted = false;

        if (!aiState.incidentFlow?.active) {
            const shouldStart = this.parseIncidentIntent(text) || this.hasContactInfo(text) || this.isOutageComplaint(text);
            if (!shouldStart || aiState.dispatchDone) {
                return false;
            }

            aiState.incidentFlow = {
                active: true,
                awaiting: "issue",
                correctingSingleField: false,
                locationCoords: (aiState as any).locationCoords || null,
                photoUrls: Array.isArray((aiState as any).pendingPhotoUrls) ? [ ...(aiState as any).pendingPhotoUrls ] : [],
                data: {
                    issueDescription: this.parseIncidentIntent(text) || this.isOutageComplaint(text) ? String(text || "").trim() : "Bilinmiyor",
                    customerName: "Bilinmiyor",
                    customerPhone: "Bilinmiyor",
                    address: "Bilinmiyor",
                    meterNo: "Bilinmiyor",
                    customerEmail: "Bilinmiyor"
                }
            };
            (aiState as any).pendingPhotoUrls = [];
            justStarted = true;
        }

        const flow = aiState.incidentFlow;
        if (!flow) {
            return false;
        }

        if (justStarted) {
            if (flow.awaiting === "issue") {
                if (flow.data.issueDescription !== "Bilinmiyor") {
                    flow.awaiting = "name";
                    await this.safeReply(message, "Kaydinizi olusturuyorum. Ad soyad bilginizi alabilir miyim?");
                    return true;
                }
                await this.safeReply(message, "Yasadiginiz sorunu kisaca tarif edebilir misiniz?");
                return true;
            }
            if (flow.awaiting === "confirm") {
                await this.safeReply(message, this.buildIncidentSummaryText(flow.data));
                return true;
            }
            if (flow.awaiting === "name") {
                await this.safeReply(message, "Kayit olusturmak icin once adinizi ve soyadinizi yazar misiniz?");
                return true;
            }
            if (flow.awaiting === "phone") {
                await this.safeReply(message, "Lutfen telefon numaranizi yazin. Ornek: 05XXXXXXXXX");
                return true;
            }
            if (flow.awaiting === "address") {
                await this.safeReply(message, "Lutfen acik adresinizi yazin.");
                return true;
            }
            if (flow.awaiting === "askPhoto") {
                await this.safeReply(message, this.buildPhotoConsentPrompt());
                return true;
            }
            if (flow.awaiting === "photo") {
                await this.safeReply(message, this.buildPhotoUploadPrompt());
                return true;
            }
            if (flow.awaiting === "askLocation") {
                await this.safeReply(message, this.buildLocationConsentPrompt());
                return true;
            }
            if (flow.awaiting === "location") {
                await this.safeReply(message, this.buildLocationSharePrompt());
                return true;
            }
            if (flow.awaiting === "email") {
                await this.safeReply(message, "Lutfen e-posta adresinizi yazin. Ornek: ad.soyad@example.com");
                return true;
            }
            await this.safeReply(message, "Lutfen tesisat no veya sayac no veya abone no bilginizi yazin.");
            return true;
        }

        if (flow.awaiting === "issue") {
            const issueText = String(text || "").trim();
            if (issueText.length < 4) {
                await this.safeReply(message, "Yasadiginiz sorunu biraz daha acik tarif edebilir misiniz?");
                return true;
            }
            flow.data.issueDescription = issueText;
            if (flow.correctingSingleField) {
                flow.correctingSingleField = false;
                flow.awaiting = "confirm";
                await this.safeReply(message, this.buildIncidentSummaryText(flow.data));
                return true;
            }
            flow.awaiting = "name";
            await this.safeReply(message, "Tesekkur ederim. Ad soyad bilginizi alabilir miyim?");
            return true;
        }

        if (flow.awaiting === "confirm") {
            if (this.isPositiveConfirmation(text)) {
                const photoCoords = (flow as any).photoCoords || null;
                const locationCoords = (flow as any).locationCoords || null;
                const photoUrls: string[] = Array.isArray((flow as any).photoUrls) ? (flow as any).photoUrls : [];
                const dispatched = await this.dispatchIncidentWithParsed(message, phoneNumber, flow.data, photoCoords, locationCoords, photoUrls);
                aiState.dispatchDone = dispatched;
                flow.active = false;
                aiState.infoProvided = true;
                if (dispatched) {
                    await this.safeReply(message, "Tesekkur ederiz. Kaydiniz olusturuldu ve ilgili numaraya/eposta adresine gonderildi.");
                } else {
                    await this.safeReply(message, "Kaydiniz olusturuldu ancak su an yonlendirme yapilamadi. Sistem ayarlari kontrol edilmelidir.");
                }
                return true;
            }

            if (this.isNegativeConfirmation(text)) {
                const correctionField = this.parseIncidentCorrectionField(text);
                if (correctionField) {
                    logger.info(`Incident confirmation negative with inline field: ${text} -> ${correctionField}`);
                    await this.promptIncidentCorrectionField(message, flow, correctionField);
                    return true;
                }

                flow.awaiting = "correctionField";
                flow.correctingSingleField = false;
                logger.info(`Incident confirmation negative without field: ${text}`);
                await this.safeReply(message, "Hangi bilgi yanlis? Lutfen sadece birini yazin: ad soyad, telefon, adres, tesisat no, e-posta.");
                return true;
            }

            await this.safeReply(message, "Bilgiler dogruysa sadece 'evet' yazin. Duzeltme yapmak isterseniz 'hayir' yazin; ben size hangi alanin yanlis oldugunu sorayim.");
            return true;
        }

        if (flow.awaiting === "correctionField") {
            const correctionField = this.parseIncidentCorrectionField(text);
            if (!correctionField) {
                logger.info(`Incident correction field not understood: ${text}`);
                await this.safeReply(message, "Hangi bilginin yanlis oldugunu anlayamadim. Lutfen su seceneklerden birini yazin: ad soyad, telefon, adres, tesisat no, e-posta.");
                return true;
            }

            logger.info(`Incident correction follow-up field: ${text} -> ${correctionField}`);
            await this.promptIncidentCorrectionField(message, flow, correctionField);
            return true;
        }

        if (flow.awaiting === "name") {
            const trimmed = String(text || "").trim();
            if (trimmed.length < 3 || !/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(trimmed)) {
                await this.safeReply(message, "Ad soyad bilgisini tekrar yazar misiniz? Ornek: Ahmet Yilmaz");
                return true;
            }
            flow.data.customerName = trimmed;
            if (flow.correctingSingleField) {
                flow.correctingSingleField = false;
                flow.awaiting = "confirm";
                await this.safeReply(message, this.buildIncidentSummaryText(flow.data));
                return true;
            }
            flow.awaiting = "phone";
            await this.safeReply(message, "Tesekkurler. Simdi telefon numaranizi yazin. Ornek: 05XXXXXXXXX");
            return true;
        }

        if (flow.awaiting === "phone") {
            const normalizedPhone = this.normalizeTurkishPhone(text);
            if (!normalizedPhone) {
                await this.safeReply(message, "Telefon numarasi gecersiz gorunuyor. Lutfen 05XXXXXXXXX formatinda tekrar yazin.");
                return true;
            }
            flow.data.customerPhone = normalizedPhone;
            if (flow.correctingSingleField) {
                flow.correctingSingleField = false;
                flow.awaiting = "confirm";
                await this.safeReply(message, this.buildIncidentSummaryText(flow.data));
                return true;
            }
            flow.awaiting = "address";
            await this.safeReply(message, "Tesekkurler. Simdi acik adresinizi yazin.");
            return true;
        }

        if (flow.awaiting === "address") {
            const addr = String(text || "").trim();
            if (addr.length < 8) {
                await this.safeReply(message, "Adres bilgisini daha acik yazmanizi rica ederiz.");
                return true;
            }
            flow.data.address = addr;
            if (flow.correctingSingleField) {
                flow.correctingSingleField = false;
                flow.awaiting = "confirm";
                await this.safeReply(message, this.buildIncidentSummaryText(flow.data));
                return true;
            }
            flow.awaiting = "askPhoto";
            await this.safeReply(message, this.buildPhotoConsentPrompt());
            return true;
        }

        if (flow.awaiting === "askPhoto") {
            if (this.isPositiveConfirmation(text)) {
                flow.awaiting = "photo";
                await this.safeReply(message, this.buildPhotoUploadPrompt());
                return true;
            }
            if (this.isNegativeConfirmation(text)) {
                flow.awaiting = "askLocation";
                await this.safeReply(message, this.buildLocationConsentPrompt());
                return true;
            }
            await this.safeReply(message, "Fotograf eklemek isteyip istemediginizi anlayamadim. Lutfen sadece 'evet' veya 'hayir' yazin.");
            return true;
        }

        if (flow.awaiting === "photo") {
            if (this.isNegativeConfirmation(text)) {
                flow.awaiting = "askLocation";
                await this.safeReply(message, this.buildLocationConsentPrompt());
                return true;
            }
            await this.safeReply(message, this.buildPhotoUploadPrompt());
            return true;
        }

        if (flow.awaiting === "askLocation") {
            if (this.isPositiveConfirmation(text)) {
                flow.awaiting = "location";
                await this.safeReply(message, this.buildLocationSharePrompt());
                return true;
            }
            if (this.isNegativeConfirmation(text)) {
                flow.awaiting = "meter";
                await this.safeReply(message, "Tesekkurler. Simdi tesisat no veya sayac no veya abone no bilginizi yazin.");
                return true;
            }
            await this.safeReply(message, "Konum eklemek isteyip istemediginizi anlayamadim. Lutfen sadece 'evet' veya 'hayir' yazin.");
            return true;
        }

        if (flow.awaiting === "location") {
            if (this.isNegativeConfirmation(text)) {
                flow.awaiting = "meter";
                await this.safeReply(message, "Konum adimini atladim. Simdi tesisat no veya sayac no veya abone no bilginizi yazin.");
                return true;
            }
            await this.safeReply(message, this.buildLocationSharePrompt());
            return true;
        }

        if (flow.awaiting === "meter") {
            const meter = this.sanitizeMeterNo(text);
            if (!this.isValidMeterNo(meter)) {
                await this.safeReply(message, "Tesisat/Sayac/Abone no bilgisini kontrol edip tekrar yazar misiniz?");
                return true;
            }
            flow.data.meterNo = meter;
            if (flow.correctingSingleField) {
                flow.correctingSingleField = false;
                flow.awaiting = "confirm";
                await this.safeReply(message, this.buildIncidentSummaryText(flow.data));
                return true;
            }
            flow.awaiting = "email";
            await this.safeReply(message, "Tesekkurler. Simdi e-posta adresinizi yazin. Ornek: ad.soyad@example.com");
            return true;
        }

        if (flow.awaiting === "email") {
            const email = String(text || "").trim().toLowerCase();
            if (!this.isValidEmail(email)) {
                await this.safeReply(message, "E-posta adresi gecersiz gorunuyor. Lutfen gecerli bir e-posta yazin. Ornek: ad.soyad@example.com");
                return true;
            }
            flow.data.customerEmail = email;
            if (flow.correctingSingleField) {
                flow.correctingSingleField = false;
                flow.awaiting = "confirm";
                await this.safeReply(message, this.buildIncidentSummaryText(flow.data));
                return true;
            }
            flow.awaiting = "confirm";
            aiState.infoProvided = true;
            await this.safeReply(message, this.buildIncidentSummaryText(flow.data));
            return true;
        }

        return false;
    }

    private parseIncidentData(text: string, fallbackName: string, fallbackPhone: string) {
        const src = String(text || "");
        const issueDescription = src.trim().length >= 4 ? src.trim() : "Bilinmiyor";

        // --- Telefon ---
        const phoneMatch = src.match(/(\+?90\s*)?(\(?0?5\d{2}\)?[\s.-]*)\d{3}[\s.-]*\d{2}[\s.-]*\d{2}|\b0?5\d{9}\b/);

        // --- Anahtar kelimeli eşleşmeler ---
        const nameMatch = src.match(/(?:^|[\n,;])\s*(?:ad\s*soyad|isim|ad)\s*[:\-]?\s*([^\n,;]+)/i);
        const addressMatch = src.match(/(?:^|[\n,;])\s*adres\s*[:\-]?\s*([^\n]+)/i);
        const meterMatch = src.match(/(?:^|[\n,;])\s*(?:tesisat|tesi[sş]at|sayac|saya[cç]|abone)\s*(?:no|numara(?:s[ıi])?)?\s*[:\-]?\s*([A-Za-z0-9\-]{5,30})/i);

        let address = addressMatch?.[1]?.trim() || "";
        let meterNo = this.isValidMeterNo(meterMatch?.[1] || "") ? this.sanitizeMeterNo(meterMatch?.[1] || "") : "";
        let inferredName = nameMatch?.[1]?.trim() || "";

        // --- Anahtar kelime yoksa virgüllü/satırlı serbest formattan çıkar ---
        if (!address || !meterNo || !inferredName) {
            // Parçalara ayır: virgül, noktalı virgül veya satır sonu
            const parts = src.split(/[,،;\n]+/).map(p => p.trim()).filter(Boolean);

            // Tesisat/sayaç numarası: harflerle başlayan, ardından rakam gelen kısa kod (TBR-251435, TRX-778899 vb.)
            const meterCodePattern = /^(?=.{5,30}$)(?!((\+?90)?0?5\d{9})$)[A-Za-z0-9-]+$/;

            if (!inferredName && parts.length) {
                const first = parts[0];
                const firstDigits = first.replace(/\D/g, "");
                const looksLikePhone = /^(\+?90)?0?5\d{9}$/.test(first.replace(/[\s\-().]/g, ""));
                const looksLikeMeter = meterCodePattern.test(first.replace(/\s+/g, ""));
                if (!looksLikePhone && !looksLikeMeter && /[A-Za-zÇĞİÖŞÜçğıöşü]/.test(first) && firstDigits.length < 5) {
                    inferredName = first;
                }
            }

            if (!meterNo) {
                const explicitMeterLine = src.match(/(?:tesisat|tesi[sş]at|sayac|saya[cç]|abone)\s*(?:no|numara(?:s[ıi])?)?\s*[:\-]?\s*([A-Za-z0-9\-]{5,30})/i);
                if (explicitMeterLine && this.isValidMeterNo(explicitMeterLine[1])) {
                    meterNo = this.sanitizeMeterNo(explicitMeterLine[1]);
                }
            }

            if (!meterNo) {
                const meterToken = [...parts]
                    .reverse()
                    .find(p => {
                        const candidate = this.sanitizeMeterNo(p);
                        return meterCodePattern.test(candidate) && this.isValidMeterNo(candidate);
                    });
                if (meterToken) {
                    meterNo = this.sanitizeMeterNo(meterToken);
                }
            }

            if (!address) {
                // Adres ipucu: mahalle/sokak/cadde/no gibi kelimeler içeren, telefon veya sayaç olmayan parça
                const addrToken = parts.find(p => {
                    const lc = p.toLowerCase();
                    const hasAddrKeyword = /mahalle|mah\b|sokak|sok\b|cadde|cad\b|bulvar|blv\b|köy|koy|\bno\b|\bkat\b|daire|apartman|sitesi/i.test(lc);
                    const isPhone = /^(\+?90)?0?5\d{8,}$/.test(p.replace(/[\s\-().]/g, ""));
                    const isMeter = meterCodePattern.test(p.replace(/\s+/g, ""));
                    return hasAddrKeyword && !isPhone && !isMeter;
                });
                if (addrToken) {
                    address = addrToken.trim();
                }
            }

            if (!address && parts.length >= 3) {
                // Yaygin format: ad, telefon, adres, tesisat
                const maybeAddress = parts[2];
                const isMeter = meterCodePattern.test(maybeAddress.replace(/\s+/g, ""));
                if (!isMeter) {
                    address = maybeAddress.trim();
                }
            }

            // Son çare: telefon ve sayaç dışındaki en uzun parça adresi olabilir
            if (!address) {
                const candidate = parts
                    .filter(p => {
                        const isPhone = /^(\+?90)?0?5\d{8,}$/.test(p.replace(/[\s\-().]/g, ""));
                        const isMeter = meterCodePattern.test(p.replace(/\s+/g, ""));
                        const isName  = p === fallbackName || (nameMatch?.[1] && p.includes(nameMatch[1].trim()));
                        return !isPhone && !isMeter && !isName && p.length > 6;
                    })
                    .sort((a, b) => b.length - a.length)[0];
                if (candidate) {
                    address = candidate.trim();
                }
            }
        }

        const invalidNamePattern = /elektrik|ariza|sorun|talep|destek|yardim|\?/i;
        if (!inferredName || invalidNamePattern.test(inferredName)) {
            inferredName = fallbackName || "Bilinmiyor";
        }

        const emailMatch = src.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
        const normalizedEmail = emailMatch?.[0]?.trim().toLowerCase() || "";

        return {
            issueDescription,
            customerName: inferredName.trim(),
            customerPhone: this.normalizeTurkishPhone(phoneMatch?.[0] || "") || this.normalizeTurkishPhone(fallbackPhone) || "Bilinmiyor",
            address: address || "Bilinmiyor",
            meterNo: meterNo || "Bilinmiyor",
            customerEmail: this.isValidEmail(normalizedEmail) ? normalizedEmail : "Bilinmiyor"
        };
    }

    private csvEscape(value: string): string {
        const v = String(value ?? "");
        if (/[",\n]/.test(v)) {
            return `"${v.replace(/"/g, '""')}"`;
        }
        return v;
    }

    private toWhatsAppChatId(raw: string): string | null {
        const value = String(raw || "").trim();
        if (!value) return null;

        // If user already provided a full JID, use it directly.
        if (/@c\.us$|@g\.us$/i.test(value)) {
            return value;
        }

        let digits = value.replace(/\D/g, "");
        if (!digits) return null;

        // Normalize common TR formats:
        // 0545xxxxxxx -> 90545xxxxxxx
        // 545xxxxxxx  -> 90545xxxxxxx
        // 0090545...  -> 90545...
        if (digits.startsWith("00")) {
            digits = digits.slice(2);
        }
        if (digits.length === 11 && digits.startsWith("0")) {
            digits = `90${digits.slice(1)}`;
        } else if (digits.length === 10 && digits.startsWith("5")) {
            digits = `90${digits}`;
        }

        return `${digits}@c.us`;
    }

    private async sendIncidentEmailViaGraph(
        subject: string,
        bodyText: string,
        recipients: string,
        attachment?: { filePath: string; fileName: string; contentType?: string }
    ): Promise<boolean> {
        const tenantId = EnvConfig.M365_TENANT_ID;
        const clientId = EnvConfig.M365_CLIENT_ID;
        const clientSecret = EnvConfig.M365_CLIENT_SECRET;
        const senderUpn = EnvConfig.M365_SENDER_UPN || EnvConfig.SMTP_USER;

        if (!tenantId || !clientId || !clientSecret || !senderUpn) {
            logger.warn("Graph mail atlandi: M365 tenant/client bilgileri eksik.");
            return false;
        }

        const toRecipients = recipients
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
            .map((address) => ({ emailAddress: { address } }));

        if (!toRecipients.length) {
            return false;
        }

        const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
        const tokenBody = new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            scope: "https://graph.microsoft.com/.default",
            grant_type: "client_credentials"
        });

        const tokenResp = await axios.post(tokenUrl, tokenBody.toString(), {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 20000
        });

        const accessToken = tokenResp.data?.access_token;
        if (!accessToken) {
            throw new Error("Graph access token alinamadi.");
        }

        const attachments: any[] = [];
        if (attachment?.filePath && attachment?.fileName) {
            const fileBase64 = fs.readFileSync(attachment.filePath).toString('base64');
            attachments.push({
                "@odata.type": "#microsoft.graph.fileAttachment",
                name: attachment.fileName,
                contentType: attachment.contentType || "application/octet-stream",
                contentBytes: fileBase64
            });
        }

        const payload = {
            message: {
                subject,
                body: {
                    contentType: "Text",
                    content: bodyText
                },
                toRecipients,
                ...(attachments.length ? { attachments } : {})
            },
            saveToSentItems: false
        };

        await axios.post(
            `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderUpn)}/sendMail`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json"
                },
                timeout: 30000
            }
        );

        return true;
    }

    private async dispatchIncidentWithParsed(message: Message, phoneNumber: string, parsed: {
        issueDescription: string;
        customerName: string;
        customerPhone: string;
        address: string;
        meterNo: string;
        customerEmail: string;
    }, photoCoords?: { lat: number; lng: number } | null, locationCoords?: { lat: number; lng: number } | null, photoUrls?: string[]): Promise<boolean> {
        const settings = await SettingsModel.findOne().lean() as any;
        const routing = settings?.incidentRouting || {};
        const envWhatsApp = String(process.env.ARIZA_TEAM_WHATSAPP || "").trim();
        const envEmails = String(process.env.ARIZA_TEAM_EMAILS || "")
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);

        const configuredWhatsApp = Array.isArray(routing.whatsappNumbers)
            ? routing.whatsappNumbers.map((v: string) => String(v || '').trim()).filter(Boolean)
            : [];
        const configuredEmails = Array.isArray(routing.emails)
            ? routing.emails.map((v: string) => String(v || '').trim()).filter(Boolean)
            : [];

        const allWhatsAppTargets = Array.from(new Set([envWhatsApp, ...configuredWhatsApp].filter(Boolean)));
        const allEmailTargets = Array.from(new Set([...envEmails, ...configuredEmails].filter(Boolean)));

        const incidentId = `ARZ-${Date.now()}`;
        const createdAt = new Date();
        const issueSummary = parsed.issueDescription || "Elektrik arizasi bildirimi";
        const canonicalCustomerPhone = normalizeConversationPhone(parsed.customerPhone || phoneNumber);
        const normalizedAddress = String(parsed.address || '').toLocaleLowerCase('tr-TR');

        const incidentDoc = await IncidentModel.create({
            incidentId,
            customerName: parsed.customerName,
            customerPhone: parsed.customerPhone,
            customerEmail: parsed.customerEmail,
            address: parsed.address,
            meterNo: parsed.meterNo,
            issueSummary,
            sourcePhoneNumber: phoneNumber,
            status: 'ALINDI',
            statusHistory: [{
                status: 'ALINDI',
                note: 'Kayit olusturuldu',
                at: createdAt
            }],
            notifications: {
                teamWhatsAppSent: false,
                teamEmailSent: false,
                customerEmailSent: false,
                lastError: ''
            },
            ...(photoCoords ? { photoCoords } : {}),
            ...(locationCoords ? { locationCoords } : {}),
            ...(photoUrls?.length ? { images: photoUrls } : {}),
        });
        fireEvent('incident.created', {
            incidentId,
            customerName: parsed.customerName,
            customerPhone: parsed.customerPhone,
            customerEmail: parsed.customerEmail,
            address: parsed.address,
            meterNo: parsed.meterNo,
            status: 'ALINDI',
            statusLabel: 'Alindi',
            source: 'whatsapp'
        }).catch(() => {});

        try {
            if (canonicalCustomerPhone && normalizedAddress) {
                const matchingGroups = await ContactGroupModel.find({
                    enabled: true,
                    addressKeywords: { $exists: true, $ne: [] }
                });

                for (const group of matchingGroups) {
                    const matches = (group.addressKeywords || []).some((keyword) => normalizedAddress.includes(String(keyword || '').toLocaleLowerCase('tr-TR')));
                    if (!matches) continue;

                    const existingMembers = new Set((group.memberPhones || []).map((value) => normalizeConversationPhone(value)).filter(Boolean));
                    if (!existingMembers.has(canonicalCustomerPhone)) {
                        existingMembers.add(canonicalCustomerPhone);
                        group.memberPhones = Array.from(existingMembers);
                        await group.save();
                    }
                }
            }
        } catch (error) {
            logger.error('Failed to auto-assign incident contact into address-based groups:', error);
        }

        const summaryMessage = [
            "*YENI ARIZA BILDIRIMI*",
            `Kayit No: ${incidentId}`,
            `Ariza: ${parsed.issueDescription}`,
            `Musteri Ismi: ${parsed.customerName}`,
            `Telefon: ${parsed.customerPhone}`,
            `Adres: ${parsed.address}`,
            `Tesisat/Sayac No: ${parsed.meterNo}`,
            `Musteri E-Posta: ${parsed.customerEmail}`,
            `Imza: ${AppConfig.instance.getBotAuthor()}`,
            `Talep: ${issueSummary}`,
            `Olusturma Zamani: ${createdAt.toLocaleString('tr-TR')}`
        ].join("\n") +
        (photoCoords ? `\n📍 Fotoğraf GPS: ${photoCoords.lat.toFixed(6)}, ${photoCoords.lng.toFixed(6)}` : "") +
        (locationCoords ? `\n📍 Konum: ${locationCoords.lat.toFixed(6)}, ${locationCoords.lng.toFixed(6)}` : "") +
        (photoUrls?.length ? `\n🖼 Resimler (${photoUrls.length} adet):\n${photoUrls.join('\n')}` : "");

        const reportsDir = path.join("public", "reports", "incidents");
        if (!fs.existsSync(reportsDir)) {
            fs.mkdirSync(reportsDir, { recursive: true });
        }

        const fileName = `${incidentId}.csv`;
        const filePath = path.join(reportsDir, fileName);
        const csvHeader = ["KayitNo", "Tarih", "MusteriIsmi", "Telefon", "MusteriEposta", "Adres", "TesisatSayacNo", "Imza", "Talep", "KaynakNumara", "ResimURLleri", "FotografGPS", "KonumGPS"].join(",");
        const csvRow = [
            this.csvEscape(incidentId),
            this.csvEscape(createdAt.toISOString()),
            this.csvEscape(parsed.customerName),
            this.csvEscape(parsed.customerPhone),
            this.csvEscape(parsed.customerEmail),
            this.csvEscape(parsed.address),
            this.csvEscape(parsed.meterNo),
            this.csvEscape(AppConfig.instance.getBotAuthor()),
            this.csvEscape(issueSummary),
            this.csvEscape(phoneNumber),
            this.csvEscape((photoUrls || []).join('; ')),
            this.csvEscape(photoCoords ? `${photoCoords.lat.toFixed(6)}, ${photoCoords.lng.toFixed(6)}` : ''),
            this.csvEscape(locationCoords ? `${locationCoords.lat.toFixed(6)}, ${locationCoords.lng.toFixed(6)}` : '')
        ].join(",");
        // \uFEFF = UTF-8 BOM — Excel'in Turkce karakterleri dogru okumasi icin gerekli
        fs.writeFileSync(filePath, `\uFEFF${csvHeader}\n${csvRow}\n`, "utf8");

        let sentAny = false;
        let teamWhatsAppSent = false;
        let teamEmailSent = false;
        let customerEmailSent = false;
        let lastError = "";

        for (const target of allWhatsAppTargets) {
            const teamChatId = this.toWhatsAppChatId(target);
            if (!teamChatId) continue;
            try {
                await this.client.sendMessage(teamChatId, summaryMessage);
                const csvMedia = MessageMedia.fromFilePath(filePath);
                await this.client.sendMessage(teamChatId, csvMedia, { caption: `Ariza raporu (Excel uyumlu CSV): ${incidentId}` });
                sentAny = true;
                teamWhatsAppSent = true;
            } catch (err) {
                logger.error("Ariza bildirimi WhatsApp ekibine gonderilemedi:", err);
                lastError = String((err as any)?.message || err || "");
            }
        }

        const smtpDb = settings?.smtp || {};
        const smtp = {
            host: smtpDb.host || EnvConfig.SMTP_HOST,
            port: smtpDb.port || Number(EnvConfig.SMTP_PORT || 587),
            secure: typeof smtpDb.secure === 'boolean' ? smtpDb.secure : String(EnvConfig.SMTP_SECURE || 'false').toLowerCase() === 'true',
            user: smtpDb.user || EnvConfig.SMTP_USER,
            pass: smtpDb.pass || EnvConfig.SMTP_PASS,
            fromName: smtpDb.fromName || EnvConfig.SMTP_FROM_NAME || 'WhatsYpzck',
            fromEmail: smtpDb.fromEmail || EnvConfig.SMTP_FROM_EMAIL || ''
        };

        const sendEmailWithFallback = async (
            subject: string,
            textBody: string,
            recipients: string,
            attachment?: { filePath: string; fileName: string; contentType?: string }
        ): Promise<boolean> => {
            if (!recipients.trim()) return false;

            if (smtp?.host && smtp?.user && smtp?.pass) {
                try {
                    const nodemailer = await import('nodemailer');
                    const transporter = nodemailer.default.createTransport({
                        host: smtp.host,
                        port: smtp.port || 587,
                        secure: smtp.secure || false,
                        auth: { user: smtp.user, pass: smtp.pass }
                    });

                    const from = smtp.fromEmail
                        ? `"${smtp.fromName || 'WhatsYpzck'}" <${smtp.fromEmail}>`
                        : smtp.user;

                    await transporter.sendMail({
                        from,
                        to: recipients,
                        subject,
                        text: textBody,
                        ...(attachment
                            ? {
                                attachments: [
                                    {
                                        filename: attachment.fileName,
                                        path: attachment.filePath,
                                        contentType: attachment.contentType || 'application/octet-stream'
                                    }
                                ]
                            }
                            : {})
                    });
                    return true;
                } catch (smtpErr) {
                    logger.error("Ariza mail gonderimi SMTP ile basarisiz, Graph denenecek:", smtpErr);
                }
            } else {
                logger.warn("Ariza mail gonderimi SMTP atlandi: SMTP ayarlari eksik. Graph denenecek.");
            }

            try {
                return await this.sendIncidentEmailViaGraph(subject, textBody, recipients, attachment);
            } catch (graphErr) {
                logger.error("Ariza mail gonderimi Graph ile de basarisiz:", graphErr);
                return false;
            }
        };

        if (allEmailTargets.length) {
            const teamEmailRecipients = allEmailTargets.join(',');
            const teamMailSent = await sendEmailWithFallback(
                `[Ariza] ${incidentId} - ${parsed.customerName}`,
                summaryMessage,
                teamEmailRecipients,
                { filePath, fileName, contentType: 'text/csv' }
            );
            if (teamMailSent) {
                sentAny = true;
                teamEmailSent = true;
            }
        }

        if (this.isValidEmail(parsed.customerEmail)) {
            const notificationTemplates = settings?.notificationTemplates || {};
            const institutionName = String(
                notificationTemplates.institutionName || process.env.INCIDENT_MAIL_INSTITUTION || "Coruh EDAS Artvin Il Mudurlugu"
            ).trim();
            const signatureName = String(
                notificationTemplates.signatureName || AppConfig.instance.getBotAuthor()
            ).trim();
            const closingLine = String(
                notificationTemplates.closingLine || process.env.INCIDENT_MAIL_CLOSING || "Bilgilerinize sunar, iyi gunler dileriz."
            ).trim();
            const createdEmailTemplate = String(
                notificationTemplates.createdEmailTemplate ||
                "Sayin Musterimiz,\n\nElektrik ariza bildiriminiz sistemimize basariyla kaydedilmistir.\nAsagida basvurunuza ait bilgiler yer almaktadir:\n\nKayit No: {{incidentId}}\nMusteri Ismi: {{customerName}}\nTelefon: {{customerPhone}}\nE-Posta: {{customerEmail}}\nAdres: {{address}}\nTesisat/Sayac No: {{meterNo}}\nOlusturma Zamani: {{createdAt}}\n\nBelirtmis oldugunuz ariza bildirimi yukaridaki gibidir. Lutfen bu bilgileri saklayiniz.\nDaha sonra bu bilgiler uzerinden ariza kaydinizi sorgulayabilirsiniz.\n\n{{closingLine}}\n{{institutionName}}\nYetkili: {{signatureName}}"
            );

            const customerMailBody = createdEmailTemplate
                .replace(/\{\{\s*incidentId\s*\}\}/g, incidentId)
                .replace(/\{\{\s*customerName\s*\}\}/g, parsed.customerName)
                .replace(/\{\{\s*customerPhone\s*\}\}/g, parsed.customerPhone)
                .replace(/\{\{\s*customerEmail\s*\}\}/g, parsed.customerEmail)
                .replace(/\{\{\s*address\s*\}\}/g, parsed.address)
                .replace(/\{\{\s*meterNo\s*\}\}/g, parsed.meterNo)
                .replace(/\{\{\s*createdAt\s*\}\}/g, formatTrDateTime(createdAt))
                .replace(/\{\{\s*closingLine\s*\}\}/g, closingLine)
                .replace(/\{\{\s*institutionName\s*\}\}/g, institutionName)
                .replace(/\{\{\s*signatureName\s*\}\}/g, signatureName)
                .replace(/\{\{\s*signature\s*\}\}/g, signatureName)
                .replace(/\n{3,}/g, "\n\n")
                .trim();

            const customerMailSent = await sendEmailWithFallback(
                `Ariza Bildiriminiz Alinmistir - ${incidentId}`,
                customerMailBody,
                parsed.customerEmail
            );
            if (customerMailSent) {
                sentAny = true;
                customerEmailSent = true;
            }
        }

        if (!allWhatsAppTargets.length && !allEmailTargets.length) {
            logger.warn("Ariza yonlendirmesi icin alici tanimli degil. ARIZA_TEAM_WHATSAPP veya ARIZA_TEAM_EMAILS ayarlayin.");
        }

        try {
            incidentDoc.notifications = {
                teamWhatsAppSent,
                teamEmailSent,
                customerEmailSent,
                lastError
            };
            await incidentDoc.save();
        } catch (incidentSaveErr) {
            logger.error("Ariza kaydi bildirim alanlari guncellenemedi:", incidentSaveErr);
        }

        return sentAny;
    }

    private async dispatchIncident(message: Message, phoneNumber: string, userText: string, history: string[]): Promise<boolean> {
        const contact = await message.getContact();
        const fallbackName = contact?.pushname || contact?.name || "Bilinmiyor";
        const parsedCurrent = this.parseIncidentData(userText, fallbackName, phoneNumber);
        const parsedHistory = this.parseIncidentData(history.join("\n"), fallbackName, phoneNumber);
        const parsed = this.mergeIncidentData(parsedHistory, parsedCurrent);
        return this.dispatchIncidentWithParsed(message, phoneNumber, parsed);
    }

    private hasContactInfo(text: string): boolean {
        const t = (text || "").toLowerCase();
        const hasPhone = /(\+?90\s*)?(\(?0?5\d{2}\)?[\s.-]*)\d{3}[\s.-]*\d{2}[\s.-]*\d{2}|\b0?5\d{9}\b/.test(t);
        const hasAddressHint = /adres|mahalle|sokak|cadde|no\b|daire|apartman/.test(t);
        const hasNameHint = /ad\s*soyad|ben\s+[a-zçğıöşü]+\s+[a-zçğıöşü]+/i.test(text || "");
        const hasMeterHint = /tesisat|sayac|abone\s*no|tesisat\s*no/.test(t);

        // Accept as provided when user gives at least two strong signals.
        const score = Number(hasPhone) + Number(hasAddressHint) + Number(hasNameHint) + Number(hasMeterHint);
        return score >= 2;
    }

    private isOutageComplaint(text: string): boolean {
        const t = String(text || "").toLowerCase();
        return /(elektrik.*(kesinti|kesintisi|ar[ıi]za|yok|gitti|gitti))|(kesinti.*(var|mevcut))|(ar[ıi]za.*(var|mevcut))|(mahallemde.*elektrik)|(evimde.*elektrik)|(sokakta.*elektrik)/.test(t);
    }

    private buildOutageReply(needsInfo: boolean): string {
        if (needsInfo) {
            return [
                "Yaşadığınız elektrik kesintisi için üzgünüz.",
                "Kaydı doğru şekilde oluşturabilmemiz için lütfen şu bilgileri paylaşır mısınız:",
                "Ad Soyad, Telefon, Açık Adres (mahalle/sokak/no) ve varsa Tesisat/Sayaç No."
            ].join(" ");
        }

        return "Teşekkür ederiz, paylaştığınız bilgiler alındı. Arıza kaydınızı öncelikli olarak işleme alıyoruz ve gelişmeleri size ileteceğiz.";
    }

    private normalizeCorporateAiReply(rawReply: string, infoProvided: boolean = false): string {
        const infoTemplate = [
            "Ad Soyad: Ali Veli",
            "Telefon: 0555 111 22 33",
            "Adres: Ankara Çankaya Atatürk Cad No:10",
            "Tesisat No: TRX-778899",
            "Elektrik kesintisi var"
        ].join("\n");

        const clean = String(rawReply || "")
            .replace(/\r/g, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();

        const sanitizeField = (value: string): string => {
            const v = String(value || "")
                .replace(/^(Durum|Yap[iı]lacak\s*I[sş]lem|Aksiyon|Gerekli\s*Bilgi|Sizden\s*Istenen|Sonraki\s*Ad[iı]m)\s*:\s*/i, "")
                .replace(/\baptalama\b/gi, "tespit")
                .replace(/elektrik\s+ağınızı\s+kontrol\s+edin\s+veya\s+bir\s+ar[iı]za\s+bildirin\.?/gi, "Elektrik arızanızı bildirin.")
                .replace(/\s+/g, " ")
                .trim();
            return v;
        };

        const hasDurum = /(^|\n)\s*Durum\s*:/i.test(clean);
        const hasIslem = /(^|\n)\s*(Yap[iı]lacak\s*I[sş]lem|Aksiyon)\s*:/i.test(clean);
        const hasBilgi = /(^|\n)\s*(Gerekli\s*Bilgi|Sizden\s*Istenen)\s*:/i.test(clean);
        const hasSonraki = /(^|\n)\s*Sonraki\s*Ad[iı]m\s*:/i.test(clean);

        const extractSection = (labelPattern: string): string => {
            const rx = new RegExp(`(?:^|\\n)\\s*${labelPattern}\\s*:\\s*(.+?)(?=\\n\\s*[A-Za-zÇĞİÖŞÜçğıöşü ]+\\s*:|$)`, "is");
            const match = clean.match(rx);
            return match?.[1]?.replace(/\s+/g, " ").trim() || "";
        };

        let durum = "";
        let islem = "";
        let bilgi = "";
        let sonraki = "";

        if (hasDurum && hasIslem && hasBilgi && hasSonraki) {
            durum = extractSection("Durum");
            islem = extractSection("Yap[iı]lacak\\s*I[sş]lem|Aksiyon");
            bilgi = extractSection("Gerekli\\s*Bilgi|Sizden\\s*Istenen");
            sonraki = extractSection("Sonraki\\s*Ad[iı]m");
        } else {
            const lines = clean.split(/\n+/).map((l) => l.trim()).filter(Boolean);
            durum = lines[0] || "Talebinizi aldik ve durum degerlendirmesi baslatildi.";
            islem = lines[1] || "Bolge kontrolu ve gerekli teknik yonlendirme icin kayit olusturuyoruz.";
            bilgi = "Ad soyad, telefon, acik adres ve tesisat/sayac numaranizi paylasmanizi rica ederiz.";
            sonraki = "Bilgileriniz ulasinca kaydinizi tamamlayip gelismeleri tarafiniza iletecegiz.";
        }

        durum = sanitizeField(durum);
        islem = sanitizeField(islem);
        bilgi = sanitizeField(bilgi);
        sonraki = sanitizeField(sonraki);

        if (infoProvided) {
            durum = "Bilgileriniz icin tesekkur ederiz.";
            islem = "Gec donus icin ozur dileriz. Ariza kaydiniz oncelikli olarak isleme alinmistir.";
            bilgi = "Ek bir bilgi gerekmemektedir.";
            sonraki = "Ekiplerimiz en kisa surede mudahale edecek ve size donus saglayacaktir.";
        } else {
            bilgi = infoTemplate;
        }

        return [
            "*KURUMSAL DESTEK YANITI*",
            `*Durum:* ${durum}`,
            `*Yapilacak Islem:* ${islem}`,
            `*Gerekli Bilgi:* ${bilgi}`,
            `*Sonraki Adim:* ${sonraki}`
        ].join("\n\n");
    }

    private constructor() {
        this.client = new Client(ClientConfig);
        this.setupEventHandlers();
    }

    public static getInstance(): BotManager {
        if (!BotManager.instance) {
            BotManager.instance = new BotManager();
        }
        return BotManager.instance;
    }

    private setupEventHandlers() {
        console.log("Setting up event handlers...");
        this.client.on('ready', this.handleReady.bind(this));
        this.client.on('authenticated', this.handleAuthenticated.bind(this));
        this.client.on('auth_failure', this.handleAuthFailure.bind(this));
        this.client.on('qr', this.handleQr.bind(this));
        this.client.on('message', this.handleMessage.bind(this));
        this.client.on('message_create', this.handleOutgoingMessage.bind(this));
        this.client.on('disconnected', this.handleDisconnect.bind(this));
    }

    private async handleOutgoingMessage(message: Message) {
        try {
            if (!(message as any)?.fromMe || message.isStatus) {
                return;
            }

            if (!message) {
                return;
            }

            const whatsappMessageId = (message as any)?.id?._serialized;
            if (whatsappMessageId) {
                const existing = await MessageModel.findOne({ whatsappMessageId }).lean();
                if (existing) {
                    return;
                }
            }

            let phoneNumber = "";
            const rawTo = String((message as any).to || "");
            const rawFrom = String((message as any).from || "");
            const chatId = rawTo || rawFrom;
            if (!phoneNumber) {
                if (!chatId || /@g\.us$/i.test(chatId)) {
                    return;
                }

                if (/@lid$/i.test(chatId) && typeof (this.client as any).getContactLidAndPhone === "function") {
                    try {
                        const resolved = await (this.client as any).getContactLidAndPhone([chatId]);
                        const mappedPhone = resolved?.[0]?.pn;
                        if (mappedPhone) {
                            phoneNumber = String(mappedPhone);
                        }
                    } catch (_) {
                        // fallback below
                    }
                }

                if (!phoneNumber) {
                    phoneNumber = chatId.replace(/@(c\.us|lid)$/i, "");
                }
            }

            if (!phoneNumber) {
                try {
                    if (typeof (message as any).getContact === "function") {
                        const contact = await (message as any).getContact();
                        if (contact?.number) {
                            phoneNumber = String(contact.number);
                        }
                    }
                } catch (_) {
                    // fallback already tried above
                }
            }

            if (!phoneNumber) {
                return;
            }

            phoneNumber = normalizeConversationPhone(phoneNumber);
            if (!phoneNumber) {
                return;
            }

            const ownPhone = normalizeConversationPhone(String(this.client?.info?.wid?._serialized || this.client?.info?.wid?.user || ""));
            if (ownPhone && phoneNumber === ownPhone) {
                logger.info(`Skipping outgoing inbox persistence for own bot number: ${phoneNumber}`);
                return;
            }

            const body = message.body?.trim() || (message.type === MessageTypes.VOICE ? '[Voice message]' : '[Empty message]');
            const type = message.type === MessageTypes.TEXT ? 'text' : 'other';

            const msgDoc = await MessageModel.create({
                phoneNumber,
                body,
                type,
                direction: 'out',
                whatsappMessageId,
                sentVia: 'whatsapp',
                read: true,
                timestamp: new Date()
            });
            messageEmitter.emit('message', msgDoc.toObject());
        } catch (error) {
            logger.error('Failed to persist outgoing WhatsApp message:', error);
        }
    }


    private async handleReady() {
        this.qrData.qrScanned = true;
        this.qrData.authenticated = true;
        logger.info("Client is ready!");
    }

    private handleAuthenticated() {
        logger.info('Client authenticated successfully!');
        this.qrData.authenticated = true;
        this.qrData.qrScanned = true;
    }

    private handleAuthFailure(message: string) {
        logger.error('Authentication failed:', message);
        this.qrData.authenticated = false;
        this.qrData.qrScanned = false;
        this.qrData.qrCodeData = "";
    }

    private handleQr(qr: string) {
        logger.info('QR RECEIVED');
        this.qrData.qrCodeData = qr;
        this.qrData.qrScanned = false;
        this.qrData.authenticated = false;
        console.log(qr);
        qrcode.generate(qr, { small: true });
    }

    private handleDisconnect(reason: string) {
        logger.info(`Client disconnected: ${reason}`);
        this.qrData.qrScanned = false;
        this.qrData.authenticated = false;
        this.qrData.qrCodeData = "";

        setTimeout(() => {
            logger.info('Attempting to reconnect...');
            this.client.initialize();
        }, 5000);
    }

    public initialize() {
        try {
            this.client.initialize();
        } catch (error) {
            logger.error(`Client initialization error: ${error}`);
        }
    }

    public getStatus(): { status: string; phone?: string; pushName?: string; qrCode?: string; uptime: number } {
        const info = this.client?.info;
        if (info) {
            return {
                status: 'connected',
                phone: info.wid?.user,
                pushName: info.pushname,
                uptime: process.uptime()
            };
        }
        if (this.qrData.qrCodeData && !this.qrData.qrScanned) {
            return { status: 'scanning', qrCode: this.qrData.qrCodeData, uptime: process.uptime() };
        }
        return { status: 'disconnected', uptime: process.uptime() };
    }

    public async reconnect(): Promise<void> {
        try {
            this.qrData.qrScanned = false;
            this.qrData.authenticated = false;
            this.qrData.qrCodeData = '';
            await this.client.destroy();
        } catch (_) { /* ignore destroy errors */ }
        setTimeout(() => {
            logger.info('Reconnecting client...');
            this.client.initialize();
        }, 1000);
    }

    private async trackContact(user: WAWebJS.Contact, _message: Message, userI18n: UserI18n) {
        try {
            const existing = await ContactModel.findOne({ phoneNumber: user.number }).lean();
            const isNew = !existing;

            await ContactModel.findOneAndUpdate(
                { phoneNumber: user.number },
                {
                    $set: {
                        name: user.name || user.pushname,
                        pushName: user.pushname,
                        language: userI18n.getLanguage(),
                        lastInteraction: new Date()
                    },
                    $inc: { interactionsCount: 1 }
                },
                { upsert: true, new: true }
            );

            if (isNew) {
                await applyScore(user.number, 'first_interaction');
                fireEvent('contact.new', { phoneNumber: user.number, name: user.name || user.pushname }).catch(() => {});
            }
            await applyScore(user.number, 'message_received');
        } catch (error) {
            logger.error('Failed to track contact:', error);
        }
    }

    private async handleMessage(message: Message) {
        let chat = null;
        let userI18n: UserI18n;
        let shouldPrioritizeIncidentFlow = false;

        if (this.shouldSkipMessage(message)) {
            return;
        }

        const content = message.body?.trim() || "";

        if (AppConfig.instance.getSupportedMessageTypes().indexOf(message.type) === -1) {
            return;
        }

        try {
            const user = await message.getContact();
            logger.info(`Message from @${user.pushname} (${user.number}): ${content}`);

            if (!user || !user.number) {
                return;
            }

            userI18n = this.getUserI18n(user.number);

            if (!user.isMe) await this.trackContact(user, message, userI18n);
            chat = await message.getChat();

            if (message.from === this.client.info.wid._serialized || message.isStatus) {
                return;
            }

            // KVKK consent check
            const userPhone = user.number;
            if (!user.isMe && !this.isKvkkAccepted(userPhone)) {
                const contactDoc = await ContactModel.findOne({ phoneNumber: userPhone }).lean() as any;
                if (contactDoc?.kvkkAccepted) {
                    this.kvkkAcceptedPhones.set(userPhone, true);
                } else {
                    if (this.isKvkkResponse(content)) {
                        this.kvkkAcceptedPhones.set(userPhone, true);
                        await ContactModel.findOneAndUpdate(
                            { phoneNumber: userPhone },
                            { $set: { kvkkAccepted: true } },
                            { upsert: true }
                        );
                        const existing = this.aiConversationState.get(userPhone);
                        this.aiConversationState.set(userPhone, {
                            active: true,
                            history: existing?.history || [],
                            infoProvided: false,
                            dispatchDone: false,
                            menuStep: 'waiting',
                            locationCoords: existing?.locationCoords || null,
                            pendingPhotoUrls: Array.isArray(existing?.pendingPhotoUrls) ? existing.pendingPhotoUrls : [],
                        });
                        await this.safeReply(message, this.buildWelcomeMenuMessage());
                        return;
                    } else {
                        await this.safeReply(message, this.buildKvkkMessage());
                        return;
                    }
                }
            }

            // Check maintenance mode (save flag into message, reply & stop if active)
            let _maintenanceModeActive = false;
            let _maintenanceModeData: { enabled: boolean; message?: string; endsAt?: Date | null } | null = null;
            if (!user.isMe) {
                try {
                    const _mmSettings = await SettingsModel.findOne().select('maintenanceMode').lean() as any;
                    const _mm = _mmSettings?.maintenanceMode;
                    if (_mm?.enabled) {
                        _maintenanceModeActive = true;
                        _maintenanceModeData = _mm;
                    }
                } catch (_) { /* non-critical */ }
            }

                // Persist incoming message for inbox
            if (!user.isMe) {
                const inboxBody = content || (message.type === MessageTypes.VOICE ? '[Voice message]' : '[Empty message]');
                const inboxType: 'text' | 'image' | 'other' = message.type === MessageTypes.IMAGE ? 'image' :
                    (message.type === MessageTypes.TEXT ? 'text' : 'other');
                const isGroup = chat?.isGroup ?? false;
                const normalizedContent = String(content || "").trim();
                const existingAiState = this.aiConversationState.get(user.number);
                shouldPrioritizeIncidentFlow = !!normalizedContent && (
                    this.parseIncidentIntent(normalizedContent) ||
                    this.parseIncidentStatusIntent(normalizedContent) ||
                    this.isOutageComplaint(normalizedContent) ||
                    this.hasContactInfo(normalizedContent) ||
                    Boolean(existingAiState?.incidentFlow?.active) ||
                    Boolean(existingAiState?.statusFlow?.active) ||
                    Boolean(existingAiState?.menuStep === 'waiting') ||
                    Boolean(existingAiState?.faultCategoryStep === 'waiting')
                );
                const conversationPhone = normalizeConversationPhone(user.number);

                // Save image to disk if message contains a photo
                let savedMediaUrl: string | undefined;
                if (message.type === MessageTypes.IMAGE) {
                    try {
                        const media = await message.downloadMedia();
                        if (media?.data) {
                            const buffer = Buffer.from(media.data, 'base64');
                            const ext = (media.mimetype?.split('/')[1]?.split(';')[0] || 'jpg').replace('jpeg', 'jpg');
                            const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'incident-images', user.number);
                            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
                            const filename = `${Date.now()}.${ext}`;
                            const filePath = path.join(uploadDir, filename);
                            fs.writeFileSync(filePath, buffer);
                            savedMediaUrl = `/public/uploads/incident-images/${user.number}/${filename}`;
                            this.pendingMediaUrls.set(user.number, savedMediaUrl);
                            logger.info(`Fotoğraf kaydedildi: ${filePath}`);
                        }
                    } catch (imgErr) {
                        logger.warn('Fotoğraf kaydedilemedi:', imgErr);
                    }
                }

                const msgDoc = await MessageModel.create({
                    phoneNumber: conversationPhone || user.number,
                    body: inboxBody,
                    type: inboxType,
                    direction: 'in',
                    sentVia: 'whatsapp',
                    read: false,
                    timestamp: new Date(),
                    isGroup,
                    groupId: isGroup ? message.from : undefined,
                    senderName: isGroup ? (user.pushname || user.name || user.number) : undefined,
                    receivedDuringMaintenance: _maintenanceModeActive,
                    ...(savedMediaUrl ? { mediaUrl: savedMediaUrl } : {}),
                });
                messageEmitter.emit('message', msgDoc.toObject());

                // Maintenance mode: reply and stop processing
                if (_maintenanceModeActive && _maintenanceModeData && !user.isMe) {
                    const _emergencyPhone = process.env.ARIZA_TEAM_WHATSAPP || '';
                    let _replyText = '\uD83D\uDD27 *Bak\u0131m Modu*\n\nSistemimiz \u015Fu anda bak\u0131m \u00E7al\u0131\u015Fmas\u0131 nedeniyle ge\u00E7ici olarak hizmet d\u0131\u015F\u0131ndad\u0131r.';
                    if (_maintenanceModeData.message) _replyText += '\n\n' + _maintenanceModeData.message;
                    if (_maintenanceModeData.endsAt) {
                        const _endsAt = new Date(_maintenanceModeData.endsAt);
                        _replyText += '\n\nTahmini biti\u015F: ' + _endsAt.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
                    }
                    _replyText += '\n\nMesaj\u0131n\u0131z kay\u0131t alt\u0131na al\u0131nm\u0131\u015Ft\u0131r. Bak\u0131m tamamland\u0131\u011F\u0131nda ekibimiz sizinle ileti\u015Fime ge\u00E7ecektir.';
                    if (_emergencyPhone) _replyText += '\n\n\u0130vedi durumlar i\u00E7in: ' + _emergencyPhone;
                    _replyText += '\n\nAnlay\u0131\u015F\u0131n\u0131z i\u00E7in te\u015Fekk\u00FCr ederiz. \uD83D\uDE4F';
                    await this.safeReply(message, _replyText);
                    return;
                }

                // Fire integration event
                fireEvent('message.received', { phoneNumber: conversationPhone || user.number, body: inboxBody }).catch(() => {});

                // Track campaign reply (mark first unacknowledged delivery for this phone)
                const updated = await CampaignModel.updateOne(
                    {
                        'deliveryReport.phone': user.number,
                        'deliveryReport.status': 'sent',
                        'deliveryReport.repliedAt': { $exists: false }
                    },
                    { $set: { 'deliveryReport.$.repliedAt': new Date() } }
                );
                if (updated.modifiedCount > 0) {
                    await applyScore(user.number, 'campaign_reply');
                }

                if (!shouldPrioritizeIncidentFlow) {
                    // Check auto-reply rules
                    const replied = await this.checkAutoReply(user.number, content, chat);
                    if (replied) return;

                    // Check active flows
                    const flowHandled = await this.executeFlow(user.number, content, chat);
                    if (flowHandled) return;
                }
            }

            if (shouldPrioritizeIncidentFlow) {
                await this.runInPhoneQueue(user.number, async () => {
                    await this.processMessageContent(message, content, userI18n, chat);
                });
                return;
            }

            const results = await Promise.allSettled([
                onboard(message, userI18n),
                this.runInPhoneQueue(user.number, async () => {
                    await this.processMessageContent(message, content, userI18n, chat);
                })
            ]);

            if (results[0].status === 'rejected') {
                logger.warn('Onboarding failed but message processing continued:', results[0].reason);
            }

            if (results[1].status === 'rejected') {
                throw results[1].reason;
            }

        } catch (error) {
            logger.error(`Message handling error: ${error}`);
            if (chat) {
                const errorMessage = userI18n?.t('errorOccurred') || 'An error occurred';
                chat.sendMessage(`> 🤖 ${errorMessage}`);
            }
        } finally {
            if (chat) await chat.clearState();
        }
    }

    private getUserI18n(userNumber: string): UserI18n {
        if (!this.userI18nCache.has(userNumber)) {
            const userI18n = new UserI18n(userNumber);
            this.userI18nCache.set(userNumber, userI18n);
            logger.info(`New user detected: ${userNumber} (${userI18n.getLanguage()})`);
        }
        return this.userI18nCache.get(userNumber)!;
    }

    private async processMessageContent(message: Message, content: string, userI18n: UserI18n, chat: any) {
        const phoneNumber = message.from.split('@')[0];

        // Handle location messages
        if ((message as any).type === 'location') {
            const loc = (message as any).location;
            if (loc?.latitude != null && loc?.longitude != null) {
                const aiState = this.aiConversationState.get(phoneNumber) || {
                    active: true,
                    history: [],
                    infoProvided: false,
                    dispatchDone: false,
                    menuStep: 'waiting' as const,
                    pendingPhotoUrls: [],
                };
                if (aiState) {
                    // Always store at aiState level so it's available even before incidentFlow starts
                    aiState.locationCoords = { lat: loc.latitude, lng: loc.longitude };
                    if (aiState.incidentFlow?.active) {
                        aiState.incidentFlow.locationCoords = { lat: loc.latitude, lng: loc.longitude };
                    }
                    this.aiConversationState.set(phoneNumber, aiState);
                }
                if (aiState?.incidentFlow?.active && aiState.incidentFlow.awaiting === 'location') {
                    aiState.incidentFlow.awaiting = 'meter';
                    this.aiConversationState.set(phoneNumber, aiState);
                    await this.safeReply(message, "Konumunuz iletildi. Tesekkur ederiz. Simdi tesisat no veya sayac no veya abone no bilginizi yazin.");
                    return;
                }
                await this.safeReply(message, `📍 Konum alındı: ${loc.latitude}, ${loc.longitude}. Teşekkürler!`);
            }
            return;
        }

        // Handle image messages - extract EXIF coords and save reference in incident flow
        if ((message as any).type === 'image') {
            const mediaUrl = this.pendingMediaUrls.get(phoneNumber);
            this.pendingMediaUrls.delete(phoneNumber);

            const coords = await this.extractPhotoExifCoords(message);
            const aiState = this.aiConversationState.get(phoneNumber) || {
                active: true,
                history: [],
                infoProvided: false,
                dispatchDone: false,
                menuStep: 'waiting' as const,
                pendingPhotoUrls: [],
            };
            if (aiState?.incidentFlow?.active) {
                if (coords) {
                    (aiState.incidentFlow as any).photoCoords = coords;
                    this.aiConversationState.set(phoneNumber, aiState);
                    await this.safeReply(message, `📸 Fotoğraf alındı. GPS koordinatları: ${coords.lat}, ${coords.lng}`);
                } else {
                    await this.safeReply(message, `📸 Fotoğraf alındı. GPS koordinatı bulunamadı.`);
                }
                // Accumulate image URL in the incident flow so it's saved when incident is created
                if (mediaUrl) {
                    if (!Array.isArray((aiState.incidentFlow as any).photoUrls)) {
                        (aiState.incidentFlow as any).photoUrls = [];
                    }
                    (aiState.incidentFlow as any).photoUrls.push(mediaUrl);
                }
                if (aiState.incidentFlow.awaiting === 'photo') {
                    aiState.incidentFlow.awaiting = 'askLocation';
                    this.aiConversationState.set(phoneNumber, aiState);
                    await this.safeReply(message, "Resmi aldim. Konum eklemek ister misiniz? Lutfen 'evet' veya 'hayir' yazin.");
                    return;
                }
                this.aiConversationState.set(phoneNumber, aiState);
                return;
            }
            if (mediaUrl) {
                if (!Array.isArray(aiState.pendingPhotoUrls)) {
                    aiState.pendingPhotoUrls = [];
                }
                aiState.pendingPhotoUrls.push(mediaUrl);
            }
            if (coords) {
                aiState.locationCoords = aiState.locationCoords || coords;
            }
            this.aiConversationState.set(phoneNumber, aiState);
            if (aiState.faultCategoryStep === 'waiting') {
                await this.safeReply(message, 'Fotografi aldim. Simdi ariza turunu secmek icin 1, 2 veya 3 yazabilirsiniz.');
                return;
            }
            if (aiState.menuStep === 'waiting') {
                await this.safeReply(message, 'Fotografi aldim. Devam etmek icin once 1 veya 2 secenegini yazin.');
                return;
            }
            await this.safeReply(message, coords
                ? `📸 Fotoğraf alındı. GPS koordinatları kaydedildi: ${coords.lat}, ${coords.lng}`
                : '📸 Fotoğraf alındı. Arıza kaydına eklemek için devam edebilirsiniz.');
            return;
        }

        if (message.type === MessageTypes.TEXT) {
            await this.handleTextMessage(message, content, userI18n, chat);
        }
    }

    private async checkAutoReply(phoneNumber: string, content: string, chat: any): Promise<boolean> {
        try {
            const rules = await AutoReplyModel.find({ enabled: true }).sort({ priority: -1 }).lean();
            for (const rule of rules) {
                // Cooldown check
                const cooldownKey = String(rule._id);
                const phoneCooldowns = autoReplyCooldown.get(phoneNumber);
                if (phoneCooldowns) {
                    const lastTriggered = phoneCooldowns.get(cooldownKey);
                    if (lastTriggered) {
                        const elapsedMs = Date.now() - lastTriggered.getTime();
                        if (elapsedMs < rule.cooldownMinutes * 60 * 1000) continue;
                    }
                }

                // Match check
                const lc = content.toLowerCase();
                const trigger = rule.trigger.toLowerCase();
                let matched = false;
                if (rule.matchType === 'exact') matched = lc === trigger;
                else if (rule.matchType === 'contains') matched = lc.includes(trigger);
                else if (rule.matchType === 'startsWith') matched = lc.startsWith(trigger);
                else if (rule.matchType === 'regex') {
                    try { matched = new RegExp(rule.trigger, 'i').test(content); } catch { matched = false; }
                }

                if (!matched) continue;

                let replyText = rule.response;

                if (rule.useAI && rule.aiProvider !== 'none') {
                    try {
                        if (rule.aiProvider === 'openai') {
                            const { default: OpenAI } = await import('openai');
                            const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                            const completion = await client.chat.completions.create({
                                model: 'gpt-4o-mini',
                                messages: [
                                    { role: 'system', content: rule.aiPrompt || 'You are a helpful WhatsApp assistant. Reply briefly.' },
                                    { role: 'user', content }
                                ],
                                max_tokens: 300
                            });
                            replyText = completion.choices[0]?.message?.content || rule.response;
                        } else if (rule.aiProvider === 'gemini') {
                            const { GoogleGenerativeAI } = await import('@google/generative-ai');
                            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
                            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
                            const result = await model.generateContent(`${rule.aiPrompt}\n\nUser: ${content}`);
                            replyText = result.response.text() || rule.response;
                        } else if (rule.aiProvider === 'claude') {
                            const result = await claudeCompletion(
                                content,
                                rule.aiPrompt || 'You are a helpful WhatsApp assistant. Reply briefly.'
                            );
                            replyText = result?.content?.find((item: any) => item.type === 'text')?.text || rule.response;
                        }
                    } catch (aiErr) {
                        logger.warn('Auto-reply AI generation failed, using static response:', aiErr);
                        replyText = rule.response;
                    }
                }

                if (replyText) {
                    await chat.sendMessage(replyText);
                    // Update cooldown
                    if (!autoReplyCooldown.has(phoneNumber)) autoReplyCooldown.set(phoneNumber, new Map());
                    autoReplyCooldown.get(phoneNumber)!.set(cooldownKey, new Date());
                    fireEvent('autoreply.triggered', { phoneNumber, rule: rule.name, trigger: rule.trigger }).catch(() => {});
                    return true;
                }
            }
        } catch (err) {
            logger.error('checkAutoReply error:', err);
        }
        return false;
    }

    // ─── Flow Execution Engine ────────────────────────────────────────────────

    private async executeFlow(phoneNumber: string, content: string, chat: any): Promise<boolean> {
        try {
            // 1. Check for active session
            const session = await FlowSessionModel.findOne({ phoneNumber, status: 'active' })
                .populate<{ flowId: any }>('flowId')
                .exec();

            if (session && session.flowId) {
                const flow = session.flowId;

                // Clear expired delay
                if (session.resumeAt && new Date() < session.resumeAt) {
                    session.resumeAt = undefined;
                }

                if (session.waitingForReply) {
                    // Store the reply in the named variable
                    if (session.pendingVariable) {
                        session.variables.set(session.pendingVariable, content);
                    }
                    session.waitingForReply = false;
                    session.pendingVariable = '';

                    // Advance to the next node connected from the question's output
                    const nextEdge = flow.edges.find((e: any) => e.source === session.currentNodeId && e.sourceHandle === 'out');
                    if (!nextEdge) { await this.endFlowSession(session); return true; }
                    const nextNode = flow.nodes.find((n: any) => n.id === nextEdge.target);
                    if (!nextNode) { await this.endFlowSession(session); return true; }

                    session.currentNodeId = nextNode.id;
                    session.lastActivityAt = new Date();
                    await session.save();
                    await this.runFlowNode(session, nextNode, flow, chat);
                    return true;
                }
                // Active session but not waiting — shouldn't block normal messages
                return false;
            }

            // 2. No active session — match published flows by trigger
            const flows = await FlowModel.find({ status: 'published' }).lean();
            for (const flow of flows) {
                const trigger = flow.trigger;
                let matches = false;

                if (trigger.type === 'any_message') {
                    matches = true;
                } else if (trigger.type === 'keyword') {
                    const lc = content.toLowerCase().trim();
                    matches = (trigger.keywords || []).some(kw => lc === kw.toLowerCase().trim() || lc.startsWith(kw.toLowerCase().trim() + ' '));
                } else if (trigger.type === 'first_contact') {
                    const contact = await ContactModel.findOne({ phoneNumber }).lean();
                    matches = !contact || (contact as any).interactionsCount <= 1;
                } else if (trigger.type === 'campaign_reply') {
                    const campaign = await CampaignModel.findOne({ 'deliveryReport.phone': phoneNumber, 'deliveryReport.status': 'sent' }).lean();
                    matches = !!campaign;
                } else if (trigger.type === 'tag_applied') {
                    const contact = await ContactModel.findOne({ phoneNumber }).lean();
                    matches = !!(contact as any)?.tags?.includes(trigger.tagName);
                }

                if (!matches) continue;

                const triggerNode = flow.nodes.find(n => n.type === 'trigger');
                if (!triggerNode) continue;

                const newSession = await FlowSessionModel.create({
                    phoneNumber,
                    flowId: flow._id,
                    currentNodeId: triggerNode.id,
                    variables: {},
                    waitingForReply: false,
                    pendingVariable: '',
                    status: 'active',
                    startedAt: new Date(),
                    lastActivityAt: new Date(),
                });
                await FlowModel.updateOne({ _id: flow._id }, { $inc: { 'stats.activations': 1 } });
                await this.runFlowNode(newSession, triggerNode, flow as any, chat);
                return true;
            }
        } catch (err) {
            logger.error('Flow execution error:', err);
        }
        return false;
    }

    private async runFlowNode(session: any, node: any, flow: any, chat: any, depth = 0): Promise<void> {
        if (depth > 20) { await this.endFlowSession(session); return; } // guard against loops

        const vars = Object.fromEntries(session.variables as Map<string, string>);
        const contact = await ContactModel.findOne({ phoneNumber: session.phoneNumber }).lean() as any;
        const ctx: Record<string, string> = {
            name:  contact?.name || contact?.pushName || 'Friend',
            phone: session.phoneNumber,
            ...vars,
        };
        const resolve = (text: string) =>
            (text || '').replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (_: string, k: string, fb: string) => ctx[k] || fb || '');

        const advance = async (handle = 'out') => {
            const edge = flow.edges.find((e: any) => e.source === node.id && e.sourceHandle === handle);
            if (!edge) { await this.endFlowSession(session); return; }
            const nextNode = flow.nodes.find((n: any) => n.id === edge.target);
            if (!nextNode) { await this.endFlowSession(session); return; }
            session.currentNodeId = nextNode.id;
            session.lastActivityAt = new Date();
            await session.save();
            await this.runFlowNode(session, nextNode, flow, chat, depth + 1);
        };

        try {
            switch (node.type) {
                case 'trigger':
                    await advance('out');
                    break;

                case 'message': {
                    const text = resolve(node.data.text || '');
                    if (text) await chat.sendMessage(text);
                    await advance('out');
                    break;
                }

                case 'question': {
                    const text = resolve(node.data.text || '');
                    if (text) await chat.sendMessage(text);
                    session.waitingForReply = true;
                    session.pendingVariable = node.data.variable || 'answer';
                    session.lastActivityAt = new Date();
                    await session.save();
                    break; // wait for reply — DO NOT advance
                }

                case 'condition': {
                    const actual   = ctx[node.data.variable || ''] || '';
                    const expected = resolve(node.data.value || '');
                    const op       = node.data.operator || 'equals';
                    let result = false;
                    if (op === 'equals')      result = actual.toLowerCase() === expected.toLowerCase();
                    else if (op === 'contains')    result = actual.toLowerCase().includes(expected.toLowerCase());
                    else if (op === 'starts_with') result = actual.toLowerCase().startsWith(expected.toLowerCase());
                    else if (op === 'not_empty')   result = actual.trim() !== '';
                    else if (op === 'is_empty')    result = actual.trim() === '';
                    await advance(result ? 'yes' : 'no');
                    break;
                }

                case 'tag': {
                    const tag    = node.data.tag || '';
                    const action = node.data.action || 'add';
                    if (tag) {
                        if (action === 'add') await ContactModel.updateOne({ phoneNumber: session.phoneNumber }, { $addToSet: { tags: tag } });
                        else                   await ContactModel.updateOne({ phoneNumber: session.phoneNumber }, { $pull:    { tags: tag } });
                    }
                    await advance('out');
                    break;
                }

                case 'delay': {
                    const secs = (parseInt(node.data.seconds) || 0) + (parseInt(node.data.minutes) || 0) * 60;
                    if (secs > 0 && secs <= 60) {
                        await new Promise(r => setTimeout(r, secs * 1000));
                    } else if (secs > 60) {
                        session.resumeAt = new Date(Date.now() + secs * 1000);
                        await session.save();
                    }
                    await advance('out');
                    break;
                }

                case 'set_variable': {
                    const varName = node.data.variable || '';
                    const value   = resolve(node.data.value || '');
                    if (varName) session.variables.set(varName, value);
                    await advance('out');
                    break;
                }

                case 'score': {
                    const pts = parseInt(node.data.points) || 0;
                    if (pts !== 0) await ContactModel.updateOne({ phoneNumber: session.phoneNumber }, { $inc: { score: pts } });
                    await advance('out');
                    break;
                }

                case 'transfer': {
                    const note = node.data.note ? resolve(node.data.note) : null;
                    if (note) await chat.sendMessage(`ℹ️ ${note}`);
                    await ContactModel.updateOne({ phoneNumber: session.phoneNumber }, { $addToSet: { tags: 'transfer-requested' } });
                    await this.endFlowSession(session);
                    break;
                }

                case 'jump': {
                    const targetFlow = await FlowModel.findById(node.data.flowId).lean();
                    if (targetFlow) {
                        const tNode = targetFlow.nodes.find((n: any) => n.type === 'trigger');
                        if (tNode) {
                            session.flowId = targetFlow._id;
                            session.currentNodeId = tNode.id;
                            await session.save();
                            await FlowModel.updateOne({ _id: targetFlow._id }, { $inc: { 'stats.activations': 1 } });
                            await this.runFlowNode(session, tNode, targetFlow as any, chat, depth + 1);
                            return;
                        }
                    }
                    await this.endFlowSession(session);
                    break;
                }

                case 'end':
                default: {
                    const text = node.data.text ? resolve(node.data.text) : null;
                    if (text) await chat.sendMessage(text);
                    await this.endFlowSession(session);
                    break;
                }
            }
        } catch (err) {
            logger.error(`runFlowNode error (type=${node.type}):`, err);
            await this.endFlowSession(session);
        }
    }

    private async endFlowSession(session: any): Promise<void> {
        session.status = 'completed';
        session.lastActivityAt = new Date();
        await session.save();
        await FlowModel.updateOne({ _id: session.flowId }, { $inc: { 'stats.completions': 1 } });
    }

    // ─────────────────────────────────────────────────────────────────────────

    private async handleTextMessage(message: Message, content: string, userI18n: UserI18n, chat: any) {
        const phoneNumber = message.from.split('@')[0];
        const text = content.trim();

        let command: string | undefined;
        let args: string[] = [];

        // Check if message starts with prefix
        if (content.startsWith(this.prefix)) {
            const parts = content.slice(this.prefix.length).trim().split(/ +/);
            const first = parts.shift() || "";
            command = this.resolveCommandAlias(first);
            args = parts;
        } else {
            // Check if the first word is a valid command name (without prefix)
            const parts = content.trim().split(/ +/);
            const firstWord = this.resolveCommandAlias(parts[0]);
            
            if (firstWord in commands) {
                command = firstWord;
                args = parts.slice(1);
            }
        }

        if (command && command in commands) {
            const settings = await SettingsModel.findOne().lean();
            if (settings?.disabledCommands?.includes(command)) {
                chat.sendMessage(`> 🤖 ${userI18n.t('unknownCommand', { command, prefix: this.prefix })}`);
                return;
            }
            if (chat) await chat.sendStateTyping();
            await commands[command].run(message, args, userI18n);
            if (command === "merhaba") {
                const existingState = this.aiConversationState.get(phoneNumber);
                this.aiConversationState.set(phoneNumber, {
                    active: true,
                    history: existingState?.history || [],
                    infoProvided: false,
                    dispatchDone: false,
                    menuStep: 'waiting',
                    locationCoords: existingState?.locationCoords || null,
                    pendingPhotoUrls: Array.isArray(existingState?.pendingPhotoUrls) ? existingState.pendingPhotoUrls : [],
                    incidentFlow: {
                        active: false,
                        awaiting: "issue",
                        photoUrls: Array.isArray(existingState?.pendingPhotoUrls) ? [ ...existingState.pendingPhotoUrls ] : [],
                        data: {
                            issueDescription: "Bilinmiyor",
                            customerName: "Bilinmiyor",
                            customerPhone: "Bilinmiyor",
                            address: "Bilinmiyor",
                            meterNo: "Bilinmiyor",
                            customerEmail: "Bilinmiyor"
                        }
                    },
                    statusFlow: {
                        active: false,
                        awaiting: "name",
                        data: {
                            customerName: "Bilinmiyor",
                            customerPhone: "Bilinmiyor",
                            incidentId: "Bilinmiyor"
                        }
                    }
                });
                await this.safeReply(message, this.buildMainMenuMessage());
            }
            applyScore(phoneNumber, 'command_used').catch(() => {});
            SettingsModel.findOneAndUpdate(
                {}, { $inc: { [`commandStats.${command}`]: 1 } }, { upsert: true }
            ).catch(() => {});
        } else if (text) {
            let aiState = this.aiConversationState.get(phoneNumber);
            if (!aiState) {
                aiState = {
                    active: true,
                    history: [],
                    infoProvided: false,
                    dispatchDone: false,
                    incidentFlow: {
                        active: false,
                        awaiting: "issue",
                        data: {
                            issueDescription: "Bilinmiyor",
                            customerName: "Bilinmiyor",
                            customerPhone: "Bilinmiyor",
                            address: "Bilinmiyor",
                            meterNo: "Bilinmiyor",
                            customerEmail: "Bilinmiyor"
                        }
                    },
                    statusFlow: {
                        active: false,
                        awaiting: "name",
                        data: {
                            customerName: "Bilinmiyor",
                            customerPhone: "Bilinmiyor",
                            incidentId: "Bilinmiyor"
                        }
                    }
                };
                this.aiConversationState.set(phoneNumber, aiState);
            }
            if (aiState?.active) {
                if (chat) await chat.sendStateTyping();

                // Handle main menu selection step
                if (aiState.menuStep === 'waiting') {
                    const choice = text.trim();
                    if (choice === '1') {
                        aiState.menuStep = undefined;
                        aiState.faultCategoryStep = 'waiting';
                        this.aiConversationState.set(phoneNumber, aiState);
                        await this.safeReply(message, this.buildFaultCategoryMessage());
                        return;
                    } else if (choice === '2') {
                        aiState.menuStep = undefined;
                        aiState.statusFlow = {
                            active: true,
                            awaiting: 'name',
                            data: { customerName: 'Bilinmiyor', customerPhone: 'Bilinmiyor', incidentId: 'Bilinmiyor' }
                        };
                        this.aiConversationState.set(phoneNumber, aiState);
                        await this.safeReply(message, 'Arıza durumunu sorgulayabilmemiz için lütfen adınızı ve soyadınızı yazınız.');
                        return;
                    } else {
                        await this.safeReply(message, this.buildMainMenuMessage());
                        return;
                    }
                }

                // Handle fault category selection step
                if (aiState.faultCategoryStep === 'waiting') {
                    const choice = text.trim();
                    if (choice === '1') {
                        aiState.faultCategoryStep = undefined;
                        const pendingLocation = aiState.locationCoords || null;
                        aiState.incidentFlow = {
                            active: true,
                            awaiting: 'issue',
                            correctingSingleField: false,
                            locationCoords: pendingLocation,
                            data: {
                                issueDescription: 'Bilinmiyor',
                                customerName: 'Bilinmiyor',
                                customerPhone: 'Bilinmiyor',
                                address: 'Bilinmiyor',
                                meterNo: 'Bilinmiyor',
                                customerEmail: 'Bilinmiyor'
                            }
                        };
                        this.aiConversationState.set(phoneNumber, aiState);
                        await this.safeReply(message, 'Yaşadığınız sorunu kısaca tarif edebilir misiniz?');
                        return;
                    } else if (choice === '2') {
                        aiState.faultCategoryStep = undefined;
                        const pendingLocation = aiState.locationCoords || null;
                        aiState.incidentFlow = {
                            active: true,
                            awaiting: 'issue',
                            correctingSingleField: false,
                            requestCategory: 'billing',
                            locationCoords: pendingLocation,
                            data: {
                                issueDescription: 'Bilinmiyor',
                                customerName: 'Bilinmiyor',
                                customerPhone: 'Bilinmiyor',
                                address: 'Bilinmiyor',
                                meterNo: 'Bilinmiyor',
                                customerEmail: 'Bilinmiyor'
                            }
                        };
                        this.aiConversationState.set(phoneNumber, aiState);
                        await this.safeReply(message, 'Fatura veya abonelik talebinizi kısaca tarif edebilir misiniz?');
                        return;
                    } else if (choice === '3') {
                        aiState.faultCategoryStep = undefined;
                        aiState.menuStep = 'waiting';
                        this.aiConversationState.set(phoneNumber, aiState);
                        await this.safeReply(message, [
                            'İç tesisat arızaları dağıtım şirketinin sorumluluk alanı dışındadır.',
                            'Bu tür sorunlar için bir elektrikçi veya tesisatçıdan yardım almanızı öneririz.',
                            'Başka bir konuda yardımcı olabilir miyim?',
                            '',
                            this.buildMainMenuMessage()
                        ].join('\n'));
                        return;
                    } else {
                        await this.safeReply(message, this.buildFaultCategoryMessage());
                        return;
                    }
                }

                const correctionField = this.parseIncidentCorrectionField(text);
                const incidentFlow = aiState.incidentFlow;
                const incidentFlowReadyForCorrection = !!incidentFlow?.active &&
                    this.getFirstMissingIncidentField(incidentFlow.data) === "confirm";
                if (incidentFlowReadyForCorrection && correctionField && !this.isPositiveConfirmation(text)) {
                    logger.info(`Incident correction force-catch: ${text} -> ${correctionField}`);
                    await this.promptIncidentCorrectionField(message, incidentFlow, correctionField);
                    this.aiConversationState.set(phoneNumber, aiState);
                    return;
                }
                if (incidentFlow?.active && incidentFlow.awaiting === "confirm" && this.isNegativeConfirmation(text) && correctionField) {
                    logger.info(`Incident correction shortcut at confirm: ${text} -> ${correctionField}`);
                    await this.promptIncidentCorrectionField(message, incidentFlow, correctionField);
                    this.aiConversationState.set(phoneNumber, aiState);
                    return;
                }
                if (incidentFlow?.active && incidentFlow.awaiting === "correctionField" && correctionField) {
                    logger.info(`Incident correction shortcut at field-select: ${text} -> ${correctionField}`);
                    await this.promptIncidentCorrectionField(message, incidentFlow, correctionField);
                    this.aiConversationState.set(phoneNumber, aiState);
                    return;
                }

                if (this.parseDateTimeIntent(text)) {
                    const nowReply = this.buildCurrentDateTimeReply();
                    await this.safeReply(message, nowReply);
                    aiState.history.push(`Kullanici: ${text.slice(0, 180)}`);
                    aiState.history.push(`Temsilci: ${nowReply.slice(0, 220)}`);
                    if (aiState.history.length > 8) {
                        aiState.history = aiState.history.slice(-8);
                    }
                    this.aiConversationState.set(phoneNumber, aiState);
                    return;
                }

                if (this.parseIdentityIntent(text)) {
                    const identityReply = this.buildIdentityReply();
                    await this.safeReply(message, identityReply);
                    aiState.history.push(`Kullanici: ${text.slice(0, 180)}`);
                    aiState.history.push(`Temsilci: ${identityReply.slice(0, 220)}`);
                    if (aiState.history.length > 8) {
                        aiState.history = aiState.history.slice(-8);
                    }
                    this.aiConversationState.set(phoneNumber, aiState);
                    return;
                }

                try {
                    const statusFlowHandled = await this.processIncidentStatusFlow(message, aiState, text);
                    this.aiConversationState.set(phoneNumber, aiState);
                    if (statusFlowHandled) {
                        return;
                    }
                } catch (statusFlowErr) {
                    logger.error("Ariza durum sorgu akisi hatasi:", statusFlowErr);
                }

                try {
                    const flowHandled = await this.processIncidentFlow(message, phoneNumber, aiState, text);
                    this.aiConversationState.set(phoneNumber, aiState);
                    if (flowHandled) {
                        return;
                    }
                } catch (flowErr) {
                    logger.error("Ariza bilgi toplama akisi hatasi:", flowErr);
                }

                if (this.isOutageComplaint(text)) {
                    const stableReply = "Ariza kaydi olusturabilmemiz icin once adinizi ve soyadinizi yazar misiniz?";
                    aiState.incidentFlow = {
                        active: true,
                        awaiting: "issue",
                        data: {
                            issueDescription: String(text || "").trim() || "Bilinmiyor",
                            customerName: "Bilinmiyor",
                            customerPhone: "Bilinmiyor",
                            address: "Bilinmiyor",
                            meterNo: "Bilinmiyor",
                            customerEmail: "Bilinmiyor"
                        }
                    };
                    this.aiConversationState.set(phoneNumber, aiState);
                    await this.safeReply(message, stableReply);
                    return;
                }

                aiState.menuStep = 'waiting';
                this.aiConversationState.set(phoneNumber, aiState);
                await this.safeReply(message, this.buildMainMenuMessage());
                return;
            }
        } else if (content.startsWith(this.prefix)) {
            const errorMessage = userI18n.t('unknownCommand', {
                command: command || '',
                prefix: this.prefix
            });
            chat.sendMessage(`> 🤖 ${errorMessage}`);
        }
    }
}

