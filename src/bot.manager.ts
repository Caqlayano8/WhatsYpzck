/**
 * Author: Ç.Kurtoğlu
 * Description: Bot manager - WhatsApp mesaj yönetimi ve komut işleme
 */

import WAWebJS, { Client, LocalAuth, Message, MessageMedia, MessageTypes } from "whatsapp-web.js";
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
import { SurveyResponseModel } from "./crm/models/survey-response.model";
import { UserModel } from "./crm/models/user.model";
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
import { TenantSessionModel } from "./crm/models/tenant-session.model";
import { speechToText } from "./utils/media/speech-to-text.util";
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
    
    // Backwards-compat: default client (primary session for default tenant)
    public client: any;
    public qrData = {
        qrCodeData: "",
        qrScanned: false,
        authenticated: false
    };
    
    // Multi-client support: Map<"tenantId:sessionKey", {client, qrData, metadata}>
    private sessionClients = new Map<string, any>();
    private sessionQrData = new Map<string, any>();
    private sessionMetadata = new Map<string, any>();
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
        greetingStep?: 'askName';
        knownCustomerName?: string;
        locationCoords?: { lat: number; lng: number } | null;
        pendingPhotoUrls?: string[];
        lastIncidentSubmittedAt?: number;
        incidentFlow?: {
            active: boolean;
            awaiting: "issue" | "name" | "phone" | "phoneConfirm" | "address" | "addressConfirm" | "askPhoto" | "photo" | "askLocation" | "location" | "meter" | "email" | "confirm" | "correctionField";
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
            recentMatches?: Array<{
                incidentId: string;
                meterNo?: string;
                status?: string;
                updatedAt?: Date;
                createdAt?: Date;
            }>;
        };
        closureFlow?: {
            active: boolean;
            awaiting: "incidentId" | "confirm" | "searchCriteria";
            requestedReason?: string;
            selectedIncidentId?: string;
            candidates: Array<{
                incidentId: string;
                status?: string;
                meterNo?: string;
                address?: string;
                customerName?: string;
                customerPhone?: string;
                customerEmail?: string;
                updatedAt?: Date;
                createdAt?: Date;
            }>;
        };
    }>();
    private technicianUpdateState = new Map<string, {
        incidentId: string;
        status?: 'INCELEMEDE' | 'ISLEME_ALINDI' | 'COZUMLENDI' | 'KAPATILDI';
        note?: string;
        awaiting: 'status' | 'note' | 'media';
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
    private inactivityTimers = new Map<string, { warn?: ReturnType<typeof setTimeout>; end?: ReturnType<typeof setTimeout> }>();

    private startInactivityTimer(phoneNumber: string, chatId?: string): void {
        this.clearInactivityTimer(phoneNumber);
        if (!chatId) chatId = `${phoneNumber}@c.us`;
        logger.info(`[INACTIVITY] Timer started for ${phoneNumber}`);
        const warn = setTimeout(async () => {
            try {
                const state = this.inactivityTimers.get(phoneNumber);
                if (!state) {
                    logger.info(`[INACTIVITY] Warn timer fired but state cleared for ${phoneNumber}`);
                    return;
                }
                logger.info(`[INACTIVITY] Sending 60s warning to ${phoneNumber}`);
                if (this.client && typeof this.client.sendMessage === 'function') {
                    await this.client.sendMessage(chatId,
                        'Değerli Müşterimiz, 2 dakika boyunca herhangi bir işlem yapılmadığında görüşmemizin otomatik olarak sonlanacağını hatırlatmak isteriz.');
                } else {
                    logger.warn(`[INACTIVITY] client.sendMessage not available for ${phoneNumber}`);
                }
            } catch (err) {
                logger.error(`[INACTIVITY] Warn send error for ${phoneNumber}:`, err);
            }
        }, 60 * 1000);
        const end = setTimeout(async () => {
            try {
                this.inactivityTimers.delete(phoneNumber);
                const aiState = this.aiConversationState.get(phoneNumber);
                if (aiState) {
                    this.aiConversationState.delete(phoneNumber);
                }
                logger.info(`[INACTIVITY] Sending 120s end message to ${phoneNumber}`);
                if (this.client && typeof this.client.sendMessage === 'function') {
                    await this.client.sendMessage(chatId,
                        'Uzun süre işlem yapılmadığı için görüşmeniz otomatik olarak sonlandırılmıştır.\n\nBize zaman ayırdığınız için teşekkür ederiz. Herhangi bir sorun veya talebiniz olduğunda bize tekrar yazabilirsiniz. Sağlıklı günler dileriz. 🙂');
                } else {
                    logger.warn(`[INACTIVITY] client.sendMessage not available for ${phoneNumber}`);
                }
            } catch (err) {
                logger.error(`[INACTIVITY] End send error for ${phoneNumber}:`, err);
            }
        }, 2 * 60 * 1000);
        this.inactivityTimers.set(phoneNumber, { warn, end });
    }

    private clearInactivityTimer(phoneNumber: string): void {
        const timers = this.inactivityTimers.get(phoneNumber);
        if (timers) {
            if (timers.warn) clearTimeout(timers.warn);
            if (timers.end) clearTimeout(timers.end);
            this.inactivityTimers.delete(phoneNumber);
        }
    }

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

    private normalizeIntentTextLoose(value: string): string {
        let t = String(value || "")
            .toLowerCase()
            .replace(/ı/g, "i")
            .replace(/ğ/g, "g")
            .replace(/ü/g, "u")
            .replace(/ş/g, "s")
            .replace(/ö/g, "o")
            .replace(/ç/g, "c");

        // Common STT drifts in Turkish voice notes
        t = t
            .replace(/\bar(?:a|b)?iza\b/g, "ariza")
            .replace(/\barza\b/g, "ariza")
            .replace(/\barzam\b/g, "ariza")
            .replace(/\bmetciyet\b/g, "mevcut")
            .replace(/\bhayg[iy][rsz]?[i]?(s[i]?)?\b/g, "hayir")
            .replace(/\bhaygir\b/g, "hayir")
            .replace(/\bhariyaz\b/g, "hayir")
            .replace(/\baydinla\s*kadar\b/g, "aydinlatmalar")
            .replace(/\baydinla\b/g, "aydinlatma")
            .replace(/\bkesin\s*tisin\b/g, "kesintisi")
            .replace(/\bkesin\s*tisini\b/g, "kesintisi")
            .replace(/\bkesin\s*ti\b/g, "kesinti")
            .replace(/\bmevcudu\b/g, "mevcut")
            .replace(/\bmevcuttur\b/g, "mevcut")
            .replace(/\belektrin\b/g, "elektrik")
            .replace(/\belektrig?\b/g, "elektrik")
            .replace(/\bbildi(?:ri|ri)?mi\b/g, "bildirimi")
            .replace(/\bbildiyle\b/g, "bildirimi")
            .replace(/\bbindirimi\b/g, "bildirimi")
            .replace(/\bbindilini\b/g, "bildirimi")
            .replace(/\bkesik\b/g, "kesinti")
            .replace(/\bbici\b/g, "bir")
            .replace(/\bikii+\b/g, "iki")
            .replace(/\bucc?\b/g, "uc")
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        return t;
    }

    private levenshteinDistance(a: string, b: string): number {
        const s = String(a || "");
        const t = String(b || "");
        const rows = s.length + 1;
        const cols = t.length + 1;
        const dp: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

        for (let i = 0; i < rows; i++) dp[i][0] = i;
        for (let j = 0; j < cols; j++) dp[0][j] = j;

        for (let i = 1; i < rows; i++) {
            for (let j = 1; j < cols; j++) {
                const cost = s[i - 1] === t[j - 1] ? 0 : 1;
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,
                    dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + cost
                );
            }
        }

        return dp[s.length][t.length];
    }

    private hasApproxToken(text: string, candidates: string[], maxDistance = 2): boolean {
        const normalized = this.normalizeIntentTextLoose(text);
        const tokens = normalized
            .split(/\s+/)
            .map(token => this.normalizeIntentToken(token))
            .filter(Boolean);

        if (tokens.length === 0) return false;

        const normalizedCandidates = candidates.map(c => this.normalizeIntentToken(c));
        for (const token of tokens) {
            for (const candidate of normalizedCandidates) {
                if (!candidate) continue;
                if (token === candidate) return true;
                const distance = this.levenshteinDistance(token, candidate);
                const allowed = Math.min(maxDistance, Math.max(1, Math.ceil(candidate.length * 0.5)));
                if (distance <= allowed) return true;
            }
        }

        return false;
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

    private resolveMainMenuChoice(text: string): '1' | '2' | null {
        const normalized = this.normalizeIntentToken(this.normalizeIntentTextLoose(text));
        const loose = this.normalizeIntentTextLoose(text);
        if (/^(1|bir|birinci|ilk)$/.test(normalized)) return '1';
        if (/^(2|iki|ikinci)$/.test(normalized)) return '2';
        if (this.hasApproxToken(loose, ["bir", "birinci", "ilk"], 1)) return '1';
        if (this.hasApproxToken(loose, ["iki", "ikinci"], 1)) return '2';

        if (/ariza|kesinti|sorun|bildir|kayit|elektrik.*yok/.test(loose)) return '1';
        if (/durum|sorgu|sorgula|talep|basvuru/.test(loose)) return '2';

        return null;
    }

    private resolveFaultCategoryChoice(text: string): '1' | '2' | '3' | null {
        const normalized = this.normalizeIntentToken(this.normalizeIntentTextLoose(text));
        const loose = this.normalizeIntentTextLoose(text);
        if (/^(1|bir|birinci|ilk)$/.test(normalized)) return '1';
        if (/^(2|iki|ikinci)$/.test(normalized)) return '2';
        if (/^(3|uc|uuc|ucuncu|uuncu)$/.test(normalized)) return '3';
        if (this.hasApproxToken(loose, ["bir", "birinci", "ilk"], 1)) return '1';
        if (this.hasApproxToken(loose, ["iki", "ikinci"], 1)) return '2';
        if (this.hasApproxToken(loose, ["uc", "ucuncu"], 1)) return '3';

        if (/dagitim|altyapi|ariza|kesinti|sorun|trafo|direk|hat hasari|kablo kopmasi|sokak aydinlatma|aydinlatma|sayac baglanti|mahalle.*elektrik|sokak.*elektrik/.test(loose)) return '1';
        if (/fatura|abonelik|tarife|odeme|itiraz|abonelik acma|abonelik kapatma|otomatik odeme/.test(loose)) return '2';
        if (/ic tesisat|ev ici|evimde elektrik yok|sigorta|priz|anahtar|ic kablo|tesisatci|elektrikci/.test(loose)) return '3';

        return null;
    }

    private isLikelyHumanName(value: string): boolean {
        const raw = String(value || '').trim();
        if (!raw) return false;
        if (/\d/.test(raw)) return false;

        const normalized = this.normalizeIntentTextLoose(raw);
        if (!normalized) return false;
        if (/ariza|kesinti|elektrik|adres|telefon|numara|mahalle|sokak|cadde|fatura|abonelik|talep/.test(normalized)) return false;

        const tokens = raw.split(/\s+/).filter(Boolean);
        if (tokens.length < 2 || tokens.length > 4) return false;

        return tokens.every(token => /^[A-Za-zÇĞİÖŞÜçğıöşü]{2,}$/.test(token));
    }

    private isLikelyAddress(value: string): boolean {
        const raw = String(value || '').trim();
        if (raw.length < 10) return false;

        const normalized = this.normalizeIntentTextLoose(raw);
        if (!normalized) return false;

        const hasAddressKeyword = /mahalle|mah\b|sokak|sok\b|cadde|cad\b|bulvar|blv\b|apartman|site|sitesi|daire|kat|no\b|blok|kapi/.test(normalized);
        const hasNumber = /\d/.test(raw);
        const wordCount = normalized.split(/\s+/).filter(Boolean).length;

        return hasAddressKeyword || (wordCount >= 3 && hasNumber);
    }

    private toDigitsFromSpeech(value: string): string {
        const normalized = this.normalizeIntentTextLoose(value)
            .replace(/\bsifir\b/g, '0')
            .replace(/\bbir\b/g, '1')
            .replace(/\biki\b/g, '2')
            .replace(/\buc\b/g, '3')
            .replace(/\bdort\b/g, '4')
            .replace(/\bbes\b/g, '5')
            .replace(/\balti\b/g, '6')
            .replace(/\byedi\b/g, '7')
            .replace(/\bsekiz\b/g, '8')
            .replace(/\bdokuz\b/g, '9');

        return normalized.replace(/\D/g, '');
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
        const directDigits = String(value || "").replace(/\D/g, "");
        const speechDigits = this.toDigitsFromSpeech(value);
        const digits = speechDigits.length > directDigits.length ? speechDigits : directDigits;
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

        if (/^(evet|e|onay|onayliyorum|dogru|dogrudur|tamam|tamamdir|olur)(\b|$)/.test(t)) {
            return true;
        }

        return this.hasApproxToken(t, ["evet", "onay", "tamam", "dogru", "olur"], 2);
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

        if (/^(hayir|hayi|hayr|h|yanlis|degil|duzelt|duzeltelim|tekrar)(\b|$)/.test(t)) {
            return true;
        }

        // Handles noisy STT variants such as "haygıysı".
        return this.hasApproxToken(t, ["hayir", "yanlis", "degil", "duzelt", "tekrar"], 3);
    }

    private isNoEmailIntent(value: string): boolean {
        const t = String(value || "")
            .trim()
            .toLowerCase()
            .replace(/ı/g, "i")
            .replace(/ğ/g, "g")
            .replace(/ü/g, "u")
            .replace(/ö/g, "o")
            .replace(/ş/g, "s")
            .replace(/ç/g, "c");

        if (!t) return false;
            return /(e-?posta\s*(yok|yoktur|olmaz|olmadan|istemiyorum|kullanmiyorum)|eposta?m?\s*(yok|yoktur)|mail(im)?\s*(yok|yoktur|istemiyorum)|(eposta|mail)\s*olmadan(\s*da)?|yok\s*(eposta|mail)|(eposta|mail)\s*vermek\s*istemiyorum)/.test(t);
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
            awaiting: "issue" | "name" | "phone" | "phoneConfirm" | "address" | "addressConfirm" | "askPhoto" | "photo" | "askLocation" | "location" | "meter" | "email" | "confirm" | "correctionField";
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
        await this.safeReply(message, "Lutfen dogru e-posta adresinizi yazin. Ornek: ad.soyad@example.com (E-posta yoksa 'e-posta yok' yazabilirsiniz.)");
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

    private async resolveLocationAddress(lat: number, lng: number): Promise<string | null> {
        try {
            const response = await axios.get("https://nominatim.openstreetmap.org/reverse", {
                params: {
                    format: "jsonv2",
                    lat,
                    lon: lng,
                    zoom: 18,
                    addressdetails: 1
                },
                headers: {
                    "User-Agent": "WhatsYpzck/2.0"
                },
                timeout: 7000
            });

            const displayName = String(response?.data?.display_name || "").trim();
            return displayName || null;
        } catch (error) {
            logger.warn("Konum adresi cozumlenemedi:", error);
            return null;
        }
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
        const t = this.normalizeIntentTextLoose(text);
        return /ariza|kesinti|elektrik\s+yok|tesisat|sayac|abone\s*no|fatura|abonelik|tarife|otomatik\s*odeme|bildirimi|aydinlatma/.test(t);
    }

    private parseIncidentStatusIntent(text: string): boolean {
        const t = this.normalizeIntentTextLoose(text);
        return /ariza.*durum|durum.*ariza|ariza\s*(kaydi|no|numara).*sorgu|ariza\s*(sorgula|sorgulama)|kayit\s*no.*(durum|sorgu)|arizamin\s*durumu/.test(t);
    }

    private isConversationEndIntent(text: string): boolean {
        const t = String(text || "")
            .trim()
            .replace(/İ/g, "i")
            .replace(/I/g, "i")
            .replace(/Ğ/g, "g")
            .replace(/Ü/g, "u")
            .replace(/Ö/g, "o")
            .replace(/Ş/g, "s")
            .replace(/Ç/g, "c")
            .toLowerCase()
            .replace(/ı/g, "i")
            .replace(/ğ/g, "g")
            .replace(/ü/g, "u")
            .replace(/ö/g, "o")
            .replace(/ş/g, "s")
            .replace(/ç/g, "c");

        const patterns = [
            'sonra gorusuruz',
            'sonra konusalim',
            'sonra goruselim',
            'sonra yazarim',
            'sonra ararsiniz',
            'daha sonra',
            'simdi bilgi paylasmak istemiyorum',
            'suan bilgi paylasmak istemiyorum',
            'musait degilim',
            'musait degil',
            'simdi musait',
            'simdilik',
            'vazgectim',
            'gorusmeyi sonlandir',
            'gorusmeyi bitir',
            'konusmayi sonlandir',
            'konusmayi bitir',
            'gorusmeye gerek yok',
            'gerek yok',
            'ihtiyac yok',
            'ihtiyacim yok',
            'tamam kapat',
            'kapat',
            'bitti',
            'cikis',
            'hoscakalin',
            'hosca kalin',
            'iyi gunler',
            'iyi aksamlar',
            'iyi geceler',
            'bay bay',
            'bye',
            'gorusmek uzere',
        ];

        return patterns.some(p => t.includes(p));
    }

    private isThankfulFarewellIntent(text: string): boolean {
        const t = String(text || '')
            .trim()
            .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/Ğ/g, 'g')
            .replace(/Ü/g, 'u').replace(/Ö/g, 'o').replace(/Ş/g, 's').replace(/Ç/g, 'c')
            .toLowerCase()
            .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
            .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ç/g, 'c');

        const patterns = [
            'tesekkur',
            'sagol',
            'sag ol',
            'eyvallah',
            'minnettarim',
            'iyi geceler',
        ];
        return patterns.some(p => t.includes(p));
    }

    private parseCustomerIncidentClosureIntent(text: string): boolean {
        const t = String(text || "")
            .trim()
            .replace(/İ/g, "i")
            .replace(/I/g, "i")
            .replace(/Ğ/g, "g")
            .replace(/Ü/g, "u")
            .replace(/Ö/g, "o")
            .replace(/Ş/g, "s")
            .replace(/Ç/g, "c")
            .toLowerCase()
            .replace(/ı/g, "i")
            .replace(/ğ/g, "g")
            .replace(/ü/g, "u")
            .replace(/ö/g, "o")
            .replace(/ş/g, "s")
            .replace(/ç/g, "c");

        return /sorunum duzeldi|problem kalmadi|yanlis ariza talebi|yanlis talep|talebi kapat|kaydi kapat|arizayi kapat|talebi iptal|kaydi iptal|ariza kaydini iptal|artik gerek kalmadi|gerek kalmadi|mudahale edilmeden kapat|\biptal\b|iptal etmek istiyorum|talep numarasi.*iptal|talep.*iptal olsun|ariza.*iptal olsun/.test(t);
    }

    private isCustomerClosureApproval(text: string): boolean {
        const t = String(text || "")
            .trim()
            .replace(/İ/g, "i")
            .replace(/Ğ/g, "g")
            .replace(/Ü/g, "u")
            .replace(/Ö/g, "o")
            .replace(/Ş/g, "s")
            .replace(/Ç/g, "c")
            .toLowerCase()
            .replace(/ı/g, "i")
            .replace(/ğ/g, "g")
            .replace(/ü/g, "u")
            .replace(/ö/g, "o")
            .replace(/ş/g, "s")
            .replace(/ç/g, "c");

        return /^(evet|evett|e|tamam|aynen|kesinlikle|kabul ediyorum|onayliyorum|onay veriyorum|iptal et|edilsin|olsun|istiyorum|onay|ok|okey)(\b|$)/.test(t);
    }

    private parseDateTimeIntent(text: string): boolean {
        const t = this.normalizeIntentTextLoose(text);
        return /(saat\s*(kac|nedir|ne)|kac\s*saat|bugun\s*(tarih|hangi\s*gun)|bugun\s*gunlerden\s*ne|tarih\s*(nedir|ne)|tarih\s*saat|simdi\s*saat\s*kac)/.test(t);
    }

    private parseIdentityIntent(text: string): boolean {
        const t = this.normalizeIntentTextLoose(text);
        return /(sen\s*kimsin|kiminle\s*konusuyorum|adin\s*ne|sen\s*nesin|kimsin\b|bot\s*musun)/.test(t);
    }

    private parseSmallTalkIntent(text: string): boolean {
        const t = this.normalizeIntentTextLoose(text);

        const patterns = [
            /^nasil(sin|siniz|din|diniz)[\s?!.]*$/,
            /^iyi\s*mi(sin|siniz)[\s?!.]*$/,
            /^naber[\s?!.]*$/,
            /^ne\s*var\s*ne\s*yok[\s?!.]*$/,
            /^ne\s*haber[\s?!.]*$/,
            /^her\s*sey\s*(nasil|iyi)[\s?!.]*$/,
            /^is(ler)?\s*nasil[\s?!.]*$/,
        ];
        return patterns.some(p => p.test(t));
    }

    private buildSmallTalkReply(text: string): string {
        const t = String(text || '')
            .trim()
            .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/Ğ/g, 'g')
            .replace(/Ü/g, 'u').replace(/Ö/g, 'o').replace(/Ş/g, 's').replace(/Ç/g, 'c')
            .toLowerCase()
            .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
            .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ç/g, 'c');

        if (t.includes('naber') || t.includes('ne var ne yok') || t.includes('ne haber')) {
            return 'İyiyiz, teşekkür ederiz! 😊 Sizlere yardımcı olabilmek için hazırız. Arıza bildirimi veya talep durumu için size nasıl yardımcı olabilirim?';
        }
        if (t.includes('is') && t.includes('nasil')) {
            return 'İşlerimiz güzel gidiyor, teşekkür ederiz! 😊 Sizlere de en iyi hizmeti sunabilmek için buradayız. Size nasıl yardımcı olabiliriz?';
        }
        // nasılsın / iyimisin ve genel sohbet
        return 'Teşekkür ederiz, iyiyiz! 😊 Umarız siz de iyisinizdir. Arıza bildirimi veya talep durumu için size nasıl yardımcı olabiliriz?';
    }

    private parseInfoRequestIntent(text: string): boolean {
        const t = this.normalizeIntentTextLoose(text);
        return /\b(bilgi\s*(almak|vermek|istiyorum|verir\s*misiniz|rica|talep)|bilgilendiri(r\s*misiniz|lir\s*misiniz)|bilgi\s*edinmek|bilgi\s*almak|bilgi\s*alabilir\s*miyim|ogrenebilir\s*miyim|ogrenmek\s*istiyorum|ogrenmek\s*istiyorum|hakkinda\s*bilgi|konusunda\s*bilgi|bir\s*sey\s*sormak|bir\s*soru(m)?\s*(var|sormak))\b/.test(t);
    }

    private async buildInfoRedirectReply(): Promise<string> {
        const fallback = [
            'Bu konuda size en doğru bilgiyi verebilmesi için sizi canlı bir temsilcimize yönlendirebiliriz. 🎧',
            '',
            'Müşteri hizmetlerimize ulaşmak için:',
            '☎️ *186*\'yı arayabilirsiniz.',
            '🕐 7/24 hizmetinizdeyiz.',
            '',
            'İsterseniz şu an *186*\'yı arayarak bir temsilcimizle görüşebilirsiniz. Sorununuz en kısa sürede çözüme kavuşturulacaktır. 🙏',
            '',
            'Elektrik arızası veya mevcut talebinizle ilgili bir işlem için ise size hemen yardımcı olabilirim.'
        ].join('\n');
        return this.getBotMessageTemplate('infoRedirectMessage', fallback);
    }

    private isUnknownQuestion(text: string): boolean {
        const t = this.normalizeIntentTextLoose(text);

        // Soru işareti veya soru kalıbı içeriyorsa ama elektrik/arıza/talep ile ilgili değilse
        const isQuestion = t.includes('?') || /\b(nedir|ne\s*zaman|nasil|neden|niye|ne\s*oluyor|ne\s*yapayim|ne\s*yapmaliyim|kim|kime|nereye|hangi|kac)\b/.test(t);
        const isElectricityRelated = /(ariza|elektrik|kesinti|sayac|tesisat|abone|fatura|talep|kayit|basvuru|durum|sorgula)/.test(t);
        return isQuestion && !isElectricityRelated;
    }

    private async buildUnknownQuestionReply(): Promise<string> {
        const fallback = [
            'Üzgünüz, bu konuda size yardımcı olamıyorum. 🙏',
            '',
            'Daha fazla bilgi için *186*\'yı arayabilirsiniz. ☎️',
            '',
            'Ancak aşağıdaki konularda size hemen yardımcı olabilirim:',
            '⚡ *1. Arıza Bildirimi* — Elektrik kesintisi veya arıza kaydı oluşturma',
            '📋 *2. Talep Durumu* — Mevcut arıza kaydınızın durumunu sorgulama',
            '❌ *3. Talep İptali* — Açık talebinizi iptal etme',
            '',
            'Bunlardan biri için yardım almak ister misiniz?'
        ].join('\n');
        return this.getBotMessageTemplate('unknownQuestionMessage', fallback);
    }

    private async getOllamaAssistantSettings(): Promise<{ enabled: boolean; outsideFlowShortReplyEnabled: boolean; maxReplyChars: number }> {
        try {
            const settings = await SettingsModel.findOne().select('ollamaAssistant').lean() as any;
            const cfg = settings?.ollamaAssistant || {};
            const maxReplyCharsRaw = Number(cfg.maxReplyChars ?? 240);
            const maxReplyChars = Number.isFinite(maxReplyCharsRaw)
                ? Math.max(80, Math.min(800, Math.round(maxReplyCharsRaw)))
                : 240;
            return {
                enabled: !!cfg.enabled,
                outsideFlowShortReplyEnabled: !!cfg.outsideFlowShortReplyEnabled,
                maxReplyChars
            };
        } catch (_) {
            return {
                enabled: false,
                outsideFlowShortReplyEnabled: false,
                maxReplyChars: 240
            };
        }
    }

    private truncateTextAtSentence(text: string, maxChars: number): string {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (!normalized) return '';
        if (normalized.length <= maxChars) return normalized;

        const candidate = normalized.slice(0, maxChars);
        const lastPunctuation = Math.max(
            candidate.lastIndexOf('.'),
            candidate.lastIndexOf('!'),
            candidate.lastIndexOf('?')
        );
        if (lastPunctuation >= 40) {
            return candidate.slice(0, lastPunctuation + 1).trim();
        }
        return `${candidate.trim()}...`;
    }

    private async tryBuildOllamaOutsideFlowShortReply(text: string): Promise<string | null> {
        const cfg = await this.getOllamaAssistantSettings();
        if (!cfg.enabled || !cfg.outsideFlowShortReplyEnabled) {
            return null;
        }

        const cleanedQuestion = String(text || '').trim();
        if (!cleanedQuestion) {
            return null;
        }

        const systemPrompt = [
            'Sen elektrik ariza destek botuna yardimci olan yerel bir AI katmanisin.',
            'Kullanici bot akisi disinda bir soru sorduysa ve cevabi biliyorsan en fazla 2 cumlelik kisa ve net bir Turkce cevap ver.',
            "Eger kesin bir bilgin yoksa sadece 'UNKNOWN' yaz.",
            'Listeleme veya uzun aciklama yapma. Teknik detayi minimum tut.'
        ].join(' ');

        const shortReplyPrompt = [
            'Kullanici sorusu:',
            cleanedQuestion,
            '',
            `Cevap en fazla ${cfg.maxReplyChars} karakter olsun.`
        ].join('\n');

        try {
            const raw = await ollamaChat(shortReplyPrompt, systemPrompt);
            const normalized = String(raw || '').trim();
            if (!normalized || /^UNKNOWN\b/i.test(normalized)) {
                return null;
            }
            return this.truncateTextAtSentence(normalized, cfg.maxReplyChars);
        } catch (err) {
            logger.warn('Ollama disi-soru kisa cevap uretimi basarisiz, normal akis devam ediyor:', err?.message || err);
            return null;
        }
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
            KAPATILDI: "Kapatildi",
            IPTAL: "Musteri tarafindan iptal edildi"
        };
        return map[String(status || "").toUpperCase()] || "Bilinmiyor";
    }

    private buildConversationEndedReply(): string {
        return [
            'Bize zaman ayırdığınız için teşekkür ederiz.',
            'Görüşmeniz sonlandırılmıştır.',
            'Herhangi bir sorun veya talebiniz olduğunda bize tekrar yazabilirsiniz.',
            'Sağlıklı günler dileriz. 🙂'
        ].join('\n');
    }

    private buildFarewellReply(originalText: string): string {
        const t = String(originalText || '')
            .trim()
            .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/Ğ/g, 'g')
            .replace(/Ü/g, 'u').replace(/Ö/g, 'o').replace(/Ş/g, 's').replace(/Ç/g, 'c')
            .toLowerCase()
            .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
            .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ç/g, 'c');

        if (t.includes('tesekkur') || t.includes('sagol') || t.includes('sag ol') ||
            t.includes('sag olun') || t.includes('eyvallah') || t.includes('minnettarim') ||
            t.includes('cok tesekkur') || t.includes('tesekkurler')) {
            return 'Rica ederiz! Yardımcı olabildiysek ne mutlu. 🙂\nHerhangi bir sorun veya talebiniz olduğunda bize tekrar yazabilirsiniz. İyi günler dileriz.';
        }

        if (t.includes('iyi geceler')) {
            return 'İyi geceler! Herhangi bir sorun veya talebiniz olduğunda bize tekrar yazabilirsiniz. 🙂';
        }

        if (t.includes('iyi aksamlar')) {
            return 'İyi akşamlar! Bize ulaştığınız için teşekkür ederiz. Herhangi bir talebiniz olduğunda tekrar yazabilirsiniz. 🙂';
        }

        if (t.includes('iyi gunler')) {
            return 'İyi günler! Bize ulaştığınız için teşekkür ederiz. Herhangi bir sorun veya talebiniz olduğunda bize tekrar yazabilirsiniz. 🙂';
        }

        if (t.includes('gorusmek uzere') || t.includes('gorusuruz') || t.includes('goruselim') ||
            t.includes('hosca kalin') || t.includes('hoscakalin') || t.includes('bay bay') || t.includes('bye')) {
            return 'Görüşmek üzere! Bize ayırdığınız zaman için teşekkür ederiz. İyi günler dileriz. 🙂';
        }

        return this.buildConversationEndedReply();
    }

    private async buildIncidentClosureNoOpenMessage(): Promise<string> {
        const fallback = 'Uzerinize kayitli kapatilabilecek acik talep bulunamadi. Dilerseniz mevcut talep numaranizi paylasabilirsiniz.';
        return this.getBotMessageTemplate('incidentClosureNoOpenMessage', fallback);
    }

    private async buildIncidentClosureSelectionMessage(records: any[]): Promise<string> {
        const items = Array.isArray(records) ? records.slice(0, 5) : [];
        if (!items.length) {
            return this.buildIncidentClosureNoOpenMessage();
        }

        const incidentList = items.map((record, index) => [
            `${index + 1}. Talep No: ${String(record?.incidentId || 'Bilinmiyor')}`,
            `Durum: ${this.incidentStatusText(String(record?.status || ''))}`,
            `Tesisat/Abone No: ${String(record?.meterNo || 'Bilinmiyor')}`,
            `Adres: ${String(record?.address || 'Bilinmiyor')}`,
        ].join('\n')).join('\n\n');

        const fallback = '*TALEP KAPATMA SECIMI*\nKapatmak istediginiz talep numarasini asagidaki listeden seciniz:\n\n{{incidentList}}\n\nLutfen kapatmak istediginiz talep numarasini yaziniz.';
        const template = await this.getBotMessageTemplate('incidentClosureSelectionMessage', fallback);
        return this.applyTemplateVariables(template, { incidentList });
    }

    private async buildIncidentClosureConfirmMessage(record: any): Promise<string> {
        const fallback = "Talep No: {{incidentId}}\nDurum: {{statusText}}\n\nBu talebi iptal etmek istediginize emin misiniz?\nOnaylamak icin *Evet* yazabilirsiniz.";
        const template = await this.getBotMessageTemplate('incidentClosureConfirmMessage', fallback);
        return this.applyTemplateVariables(template, {
            incidentId: String(record?.incidentId || 'Bilinmiyor'),
            statusText: this.incidentStatusText(String(record?.status || '')),
        });
    }

    private async buildIncidentClosureNeedApprovalMessage(): Promise<string> {
        const fallback = "Devam etmek icin lutfen sadece *Evet* yaziniz. Vazgecmek isterseniz 'sonra gorusuruz' yazabilirsiniz.";
        return this.getBotMessageTemplate('incidentClosureNeedApprovalMessage', fallback);
    }

    private async buildIncidentClosureSuccessMessage(incidentId: string): Promise<string> {
        const fallback = 'Talep No: {{incidentId}}\nSizin isteginiz uzere talebiniz mudahale edilmeden kapatilmistir.\nBizi tercih ettiginiz icin tesekkur ederiz. Gorusmek uzere.';
        const template = await this.getBotMessageTemplate('incidentClosureSuccessMessage', fallback);
        return this.applyTemplateVariables(template, { incidentId: String(incidentId || 'Bilinmiyor') });
    }

    private async findCustomerClosableIncidents(phoneNumber: string, requestedText: string): Promise<any[]> {
        const canonicalPhone = normalizeConversationPhone(phoneNumber) || this.normalizeTurkishPhone(phoneNumber) || phoneNumber;
        const inlineIncidentId = this.normalizeIncidentId(requestedText);
        const query: any = { status: { $nin: ['KAPATILDI', 'IPTAL'] } };

        if (inlineIncidentId) {
            query.incidentId = inlineIncidentId;
            query.$or = [
                { customerPhone: canonicalPhone },
                { sourcePhoneNumber: canonicalPhone },
                { customerPhone: phoneNumber },
                { sourcePhoneNumber: phoneNumber }
            ];
        } else {
            query.$or = [
                { customerPhone: canonicalPhone },
                { sourcePhoneNumber: canonicalPhone },
                { customerPhone: phoneNumber },
                { sourcePhoneNumber: phoneNumber }
            ];
        }

        return await IncidentModel.find(query)
            .sort({ updatedAt: -1, createdAt: -1 })
            .limit(5)
            .lean() as any[];
    }

    private async findIncidentsByCustomerSearch(searchText: string): Promise<any[]> {
        const text = String(searchText || '').trim();
        const closedStatuses = ['KAPATILDI', 'IPTAL'];

        // Try incident ID first
        const incidentId = this.normalizeIncidentId(text);
        if (incidentId) {
            const byId = await IncidentModel.findOne({ incidentId, status: { $nin: closedStatuses } }).lean() as any;
            if (byId) return [byId];
        }

        // Try phone number
        const phoneMatch = text.replace(/\s/g, '').match(/^(0|\+90|90)?(5\d{9})$/);
        if (phoneMatch) {
            const digits = phoneMatch[2];
            const variants = [`0${digits}`, `90${digits}`, `+90${digits}`, digits];
            const byPhone = await IncidentModel.find({
                status: { $nin: closedStatuses },
                $or: variants.flatMap((v) => [
                    { customerPhone: v },
                    { sourcePhoneNumber: v }
                ])
            }).sort({ updatedAt: -1 }).limit(5).lean() as any[];
            if (byPhone.length) return byPhone;
        }

        // Try customer name (partial match, at least 3 chars)
        if (text.length >= 3) {
            const byName = await IncidentModel.find({
                status: { $nin: closedStatuses },
                customerName: { $regex: text, $options: 'i' }
            }).sort({ updatedAt: -1 }).limit(5).lean() as any[];
            if (byName.length) return byName;
        }

        return [];
    }

    private async getIncidentEmailTargets(incident: any): Promise<string[]> {
        const settings = await SettingsModel.findOne().lean() as any;
        const configuredEmails = Array.isArray(settings?.incidentRouting?.emails)
            ? settings.incidentRouting.emails.map((v: string) => String(v || '').trim()).filter(Boolean)
            : [];
        const envEmails = String(process.env.ARIZA_TEAM_EMAILS || '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
        const adminUsers = await UserModel.find({ role: 'admin', isActive: true }).select('email').lean() as any[];
        const technicianUserId = String(incident?.assignedTechnician?.userId || '');
        const technician = technicianUserId
            ? await UserModel.findById(technicianUserId).select('email').lean() as any
            : null;

        return Array.from(new Set([
            ...configuredEmails,
            ...envEmails,
            ...adminUsers.map((user) => String(user?.email || '').trim()),
            String(technician?.email || '').trim()
        ].filter(Boolean)));
    }

    private async sendIncidentEmailWithFallback(
        subject: string,
        textBody: string,
        recipients: string | string[],
        attachment?: { filePath: string; fileName: string; contentType?: string }
    ): Promise<boolean> {
        const recipientList = Array.isArray(recipients)
            ? recipients.map((value) => String(value || '').trim()).filter(Boolean)
            : String(recipients || '').split(',').map((value) => value.trim()).filter(Boolean);
        if (!recipientList.length) return false;

        const settings = await SettingsModel.findOne().lean() as any;
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
                    to: recipientList.join(','),
                    subject,
                    text: textBody,
                    ...(attachment ? {
                        attachments: [{
                            filename: attachment.fileName,
                            path: attachment.filePath,
                            contentType: attachment.contentType || 'application/octet-stream'
                        }]
                    } : {})
                });
                return true;
            } catch (smtpErr) {
                logger.error('Ariza e-postasi SMTP ile gonderilemedi, Graph denenecek:', smtpErr);
            }
        }

        try {
            return await this.sendIncidentEmailViaGraph(subject, textBody, recipientList.join(','), attachment);
        } catch (graphErr) {
            logger.error('Ariza e-postasi Graph ile de gonderilemedi:', graphErr);
            return false;
        }
    }

    private async closeIncidentByCustomerRequest(incident: any, requestedReason: string): Promise<void> {
        const settings = await SettingsModel.findOne().lean() as any;
        const signatureName = String(settings?.botIdentity?.author || AppConfig.instance.getBotAuthor()).trim();
        const closureNote = `[Musteri Talebi] Musteri tarafindan kendi istegiyle iptal edildi. Gerekce: ${requestedReason || 'Musteri talebi uzerine iptal'}`;

        incident.status = 'IPTAL';
        incident.statusHistory = Array.isArray(incident.statusHistory) ? incident.statusHistory : [];
        incident.statusHistory.push({
            status: 'IPTAL',
            note: closureNote,
            at: new Date()
        });
        await incident.save();

        const managerMessage = [
            '*MUSTERI TALEBIYLE IPTAL EDILDI*',
            `Talep No: ${incident.incidentId}`,
            `Musteri: ${incident.customerName || 'Bilinmiyor'}`,
            `Telefon: ${incident.customerPhone || 'Bilinmiyor'}`,
            `Durum: ${this.incidentStatusText('IPTAL')}`,
            `Not: ${closureNote}`
        ].join('\n');
        await this.notifyManagersInstantly(managerMessage);

        const technicianPhone = String(incident?.assignedTechnician?.phone || '').trim();
        const technicianChatId = this.toWhatsAppChatId(technicianPhone);
        if (technicianChatId) {
            try {
                await this.client.sendMessage(technicianChatId, managerMessage);
            } catch (err) {
                logger.warn('Teknisyene musteri kapatma bildirimi gonderilemedi:', err);
            }
        }

        const emailTargets = await this.getIncidentEmailTargets(incident);
        if (emailTargets.length) {
            await this.sendIncidentEmailWithFallback(
                `[Ariza Iptal Edildi] ${incident.incidentId} - Musteri Talebi`,
                [
                    'Musteri talebi dogrultusunda ariza kaydi iptal edilmistir.',
                    '',
                    `Talep No: ${incident.incidentId}`,
                    `Musteri: ${incident.customerName || 'Bilinmiyor'}`,
                    `Telefon: ${incident.customerPhone || 'Bilinmiyor'}`,
                    `Adres: ${incident.address || 'Bilinmiyor'}`,
                    `Tesisat/Sayac No: ${incident.meterNo || 'Bilinmiyor'}`,
                    `Not: ${closureNote}`,
                    '',
                    `Yetkili: ${signatureName}`
                ].join('\n'),
                emailTargets
            );
        }

        if (this.isValidEmail(String(incident.customerEmail || ''))) {
            await this.sendIncidentEmailWithFallback(
                `Talebiniz Iptal Edilmistir - ${incident.incidentId}`,
                [
                    'Sayin Musterimiz,',
                    '',
                    `Sizin isteginiz uzere ${incident.incidentId} numarali talebiniz mudahale edilmeden iptal edilmistir.`,
                    'Anlayisiniz ve bizi tercih ettiginiz icin tesekkur ederiz.',
                    'Ihtiyaciniz olursa bizimle yeniden iletisime gecebilirsiniz.',
                    '',
                    `Yetkili: ${signatureName}`
                ].join('\n'),
                String(incident.customerEmail || '').trim()
            );
        }

        await this.sendSurveyAfterIncidentStatusUpdate(incident, 'IPTAL');

        fireEvent('incident.status.updated', {
            incidentId: String(incident.incidentId),
            status: 'IPTAL',
            statusLabel: this.incidentStatusText('IPTAL'),
            note: closureNote,
            customerName: String(incident.customerName || ''),
            customerPhone: String(incident.customerPhone || ''),
            customerEmail: String(incident.customerEmail || ''),
            address: String(incident.address || ''),
            meterNo: String(incident.meterNo || ''),
            source: 'customer-whatsapp'
        }).catch(() => {});
    }

    private normalizePhoneForMatch(value: string): string {
        let digits = String(value || '').replace(/\D/g, '');
        if (!digits) return '';
        if (digits.startsWith('00')) digits = digits.slice(2);
        if (digits.length === 11 && digits.startsWith('0')) {
            digits = `90${digits.slice(1)}`;
        } else if (digits.length === 10 && digits.startsWith('5')) {
            digits = `90${digits}`;
        }
        return digits;
    }

    private parseTechnicianStatusCode(text: string): 'INCELEMEDE' | 'ISLEME_ALINDI' | 'COZUMLENDI' | 'KAPATILDI' | '' {
        const t = String(text || '')
            .trim()
            .toUpperCase()
            .replace(/İ/g, 'I')
            .replace(/Ş/g, 'S')
            .replace(/Ğ/g, 'G')
            .replace(/Ü/g, 'U')
            .replace(/Ö/g, 'O')
            .replace(/Ç/g, 'C')
            .replace(/\s+/g, '_');

        const map: Record<string, 'INCELEMEDE' | 'ISLEME_ALINDI' | 'COZUMLENDI' | 'KAPATILDI'> = {
            INCELEMEDE: 'INCELEMEDE',
            ISLEME_ALINDI: 'ISLEME_ALINDI',
            COZUMLENDI: 'COZUMLENDI',
            KAPATILDI: 'KAPATILDI',
            KAYIT_ALINDI: 'INCELEMEDE',
            ALINDI: 'INCELEMEDE'
        };
        return map[t] || '';
    }

    private async findFieldTechnicianByPhone(rawPhone: string): Promise<any | null> {
        const normalized = this.normalizePhoneForMatch(rawPhone);
        if (!normalized) return null;

        const techs = await UserModel.find({ role: 'field_tech', isActive: true }).select('_id username displayName phone').lean() as any[];
        for (const tech of techs) {
            const candidate = this.normalizePhoneForMatch(String(tech.phone || ''));
            if (!candidate) continue;
            if (candidate === normalized) return tech;
            if (candidate.endsWith(normalized) || normalized.endsWith(candidate)) return tech;
        }
        return null;
    }

    private async getManagerWhatsAppTargets(): Promise<string[]> {
        const settings = await SettingsModel.findOne().lean() as any;
        const routingNumbers = Array.isArray(settings?.incidentRouting?.whatsappNumbers)
            ? settings.incidentRouting.whatsappNumbers
            : [];
        const admins = await UserModel.find({ role: 'admin', isActive: true }).select('phone').lean() as any[];
        return Array.from(new Set([
            ...admins.map((u) => String(u.phone || '').trim()),
            ...routingNumbers.map((v: string) => String(v || '').trim())
        ].filter(Boolean)));
    }

    private async notifyManagersInstantly(text: string): Promise<number> {
        const targets = await this.getManagerWhatsAppTargets();
        let sent = 0;
        for (const phone of targets) {
            const chatId = this.toWhatsAppChatId(phone);
            if (!chatId) continue;
            try {
                await this.client.sendMessage(chatId, text);
                sent += 1;
            } catch (_) { /* non-critical */ }
        }
        return sent;
    }

    private normalizeRoutingToken(value: string): string {
        return String(value || '')
            .toLocaleLowerCase('tr-TR')
            .replace(/ı/g, 'i')
            .replace(/ğ/g, 'g')
            .replace(/ü/g, 'u')
            .replace(/ş/g, 's')
            .replace(/ö/g, 'o')
            .replace(/ç/g, 'c')
            .trim();
    }

    private collectTechnicianRoutingTokens(technician: any): string[] {
        const routing = technician?.routing || {};
        const values = [
            routing.city,
            routing.district,
            ...(Array.isArray(routing.neighborhoods) ? routing.neighborhoods : []),
            ...(Array.isArray(routing.streets) ? routing.streets : []),
            ...(Array.isArray(routing.areaKeywords) ? routing.areaKeywords : [])
        ];

        const set = new Set<string>();
        for (const value of values) {
            const token = this.normalizeRoutingToken(String(value || ''));
            if (token && token.length >= 2) set.add(token);
        }
        return Array.from(set);
    }

    private async autoAssignIncidentByArea(incident: any): Promise<void> {
        const normalizedAddress = this.normalizeRoutingToken(String(incident?.address || ''));
        if (!normalizedAddress) return;

        const technicians = await UserModel.find({ role: 'field_tech', isActive: true })
            .select('_id username displayName phone routing')
            .lean() as any[];

        let bestMatch: any | null = null;
        let bestScore = 0;
        let bestTokens: string[] = [];
        for (const technician of technicians) {
            const tokens = this.collectTechnicianRoutingTokens(technician);
            if (!tokens.length) continue;
            const matches = tokens.filter((token) => normalizedAddress.includes(token));
            const score = matches.length;
            if (score > bestScore && technician.phone) {
                bestScore = score;
                bestMatch = technician;
                bestTokens = matches;
            }
        }

        if (!bestMatch || bestScore <= 0) return;

        incident.assignedTechnician = {
            userId: String(bestMatch._id || ''),
            username: String(bestMatch.username || ''),
            displayName: String(bestMatch.displayName || bestMatch.username || ''),
            phone: String(bestMatch.phone || ''),
            assignedAt: new Date(),
            assignedByUserId: 'system',
            assignedByName: 'Sistem Otomatik Yonlendirme'
        };
        incident.assignment = {
            method: 'auto-area',
            matchKeywords: bestTokens
        };
        incident.statusHistory = Array.isArray(incident.statusHistory) ? incident.statusHistory : [];
        incident.statusHistory.push({
            status: incident.status || 'ALINDI',
            note: `Otomatik atama: ${bestMatch.displayName || bestMatch.username}`,
            at: new Date()
        });
        await incident.save();

        const technicianChatId = this.toWhatsAppChatId(String(bestMatch.phone || ''));
        const assignmentMessage = [
            '*YENI GOREV ATAMASI*',
            '',
            `Ariza Kodu: ${incident.incidentId}`,
            `Musteri: ${incident.customerName || 'Bilinmiyor'}`,
            `Telefon: ${incident.customerPhone || 'Bilinmiyor'}`,
            `Adres: ${incident.address || 'Bilinmiyor'}`,
            `Sayac/Tesisat No: ${incident.meterNo || 'Bilinmiyor'}`,
            '',
            'Guncelleme adimi:',
            '1) Ilk mesajda sadece ariza kodunu yazin.',
            '2) Durum kodunu yazin: INCELEMEDE/ISLEME_ALINDI/COZUMLENDI/KAPATILDI',
            '3) Aciklama notunu yazin.',
            '4) Son adimda resim/video gonderebilirsiniz (KAPATILDI icin zorunlu).'
        ].join('\n');

        if (technicianChatId) {
            try {
                await this.client.sendMessage(technicianChatId, assignmentMessage);
            } catch (_) {
                // Non-critical: assignment stays on record even if message delivery fails.
            }
        }

        const managerMessage = [
            '*ANLIK ATAMA*',
            `Kayit No: ${incident.incidentId}`,
            `Teknisyen: ${bestMatch.displayName || bestMatch.username}`,
            `Telefon: ${bestMatch.phone || '-'}`,
            `Eslesen Alanlar: ${bestTokens.join(', ') || '-'}`
        ].join('\n');
        await this.notifyManagersInstantly(managerMessage);
    }

    private async safeReply(message: Message, text: string): Promise<void> {
        // Get the appropriate client for this message's session
        const sessionKey = (message as any).__sessionKey;
        let clientToUse = this.client;

        if (sessionKey) {
            const sessionClient = this.sessionClients.get(sessionKey);
            if (sessionClient) {
                clientToUse = sessionClient;
            }
        }

        try {
            if (clientToUse && typeof clientToUse.sendMessage === "function" && message?.from) {
                await clientToUse.sendMessage(message.from, text);
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

    private async getBotMessageTemplate(
        key: 'kvkkMessage' | 'welcomeMenuMessage' | 'mainMenuMessage' | 'faultCategoryMessage' | 'incidentStatusStartMessage' | 'incidentStatusResultTemplate' | 'incidentClosureNoOpenMessage' | 'incidentClosureSelectionMessage' | 'incidentClosureConfirmMessage' | 'incidentClosureNeedApprovalMessage' | 'incidentClosureSuccessMessage' | 'personalizedMenuMessage' | 'infoRedirectMessage' | 'unknownQuestionMessage' | 'noEmailFallbackMessage' | 'incidentCreatedSuccessMessage' | 'incidentCreatedDispatchFailedMessage' | 'chatMediaPreviewText',
        fallback: string
    ): Promise<string> {
        try {
            const settings = await SettingsModel.findOne().select('botMessageTemplates').lean() as any;
            const value = settings?.botMessageTemplates?.[key];
            if (typeof value === 'string' && value.trim()) {
                return value.trim();
            }
        } catch (_) {
            // Use fallback on any read error
        }
        return fallback;
    }

    private applyTemplateVariables(template: string, variables: Record<string, string>): string {
        return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
            return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : '';
        });
    }

    private async buildKvkkMessage(): Promise<string> {
        const fallback = [
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
        return this.getBotMessageTemplate('kvkkMessage', fallback);
    }

    private async buildWelcomeMenuMessage(): Promise<string> {
        const fallback = [
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
        return this.getBotMessageTemplate('welcomeMenuMessage', fallback);
    }

    private async buildPersonalizedMenuMessage(firstName: string): Promise<string> {
        const fallback = [
            `Hoş geldiniz, *${firstName}* 👋 Size hemen yardımcı olabilirim.`,
            '',
            'Size nasıl yardımcı olabileceğimi seçin:',
            '',
            '1️⃣ *Arıza veya sorun bildirmek istiyorum*',
            '2️⃣ *Mevcut talebimin durumunu öğrenmek istiyorum*',
            '',
            'Lütfen *1* veya *2* yazın.'
        ].join('\n');
        const template = await this.getBotMessageTemplate('personalizedMenuMessage', fallback);
        return this.applyTemplateVariables(template, { firstName });
    }

    private async buildMainMenuMessage(): Promise<string> {
        const fallback = [
            "Merhaba! Ben WhatsYpzck Elektrik Arıza Asistanıyım 🔧⚡",
            "",
            "Size nasıl yardımcı olabileceğimi seçin:",
            "",
            "1️⃣ *Arıza veya sorun bildirmek istiyorum*",
            "2️⃣ *Mevcut talebimin durumunu öğrenmek istiyorum*",
            "",
            "Lütfen *1* veya *2* yazın."
        ].join("\n");
        return this.getBotMessageTemplate('mainMenuMessage', fallback);
    }

    private async buildFaultCategoryMessage(): Promise<string> {
        const fallback = [
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
        return this.getBotMessageTemplate('faultCategoryMessage', fallback);
    }

    private async buildIncidentStatusStartMessage(): Promise<string> {
        const fallback = 'Ariza durumunu sorgulamak icin lutfen ariza kodu, telefon numarasi, tesisat/abone no veya ad soyad yaziniz.';
        return this.getBotMessageTemplate('incidentStatusStartMessage', fallback);
    }

    private async buildIncidentStatusResultMessage(record: any): Promise<string> {
        const fallback = [
            '*ARIZA DURUM BİLGİSİ*',
            'Kayıt No: {{incidentId}}',
            'Durum: {{statusText}}',
            'Oluşturma Zamanı: {{createdAt}}',
            'Son Güncelleme: {{updatedAt}}',
            'Adres: {{address}}',
            'Tesisat/Sayaç No: {{meterNo}}'
        ].join('\n');
        const template = await this.getBotMessageTemplate('incidentStatusResultTemplate', fallback);
        return this.applyTemplateVariables(template, {
            incidentId: String(record?.incidentId || 'Bilinmiyor'),
            statusText: this.incidentStatusText(record?.status),
            createdAt: formatTrDateTime(record?.createdAt),
            updatedAt: formatTrDateTime(record?.updatedAt),
            address: String(record?.address || 'Bilinmiyor'),
            meterNo: String(record?.meterNo || 'Bilinmiyor')
        });
    }

    private buildIncidentStatusMatchesMessage(records: any[]): string {
        const topThree = Array.isArray(records) ? records.slice(0, 3) : [];
        if (!topThree.length) {
            return 'Eslesen kayit bulunamadi.';
        }

        return [
            '*SON 3 TALEP*',
            'Birden fazla kayit bulundu. Son 3 talep asagidadir:',
            '',
            ...topThree.map((record, index) => [
                `${index + 1}. Talep No: ${String(record?.incidentId || 'Bilinmiyor')}`,
                `Tesisat/Abone No: ${String(record?.meterNo || 'Bilinmiyor')}`,
                `Durum: ${this.incidentStatusText(record?.status)}`,
                `Son Guncelleme: ${formatTrDateTime(record?.updatedAt || record?.createdAt)}`,
            ].join('\n')),
            '',
            'Detay icin talep numarasini yazarak tekrar sorgulama yapabilirsiniz.'
        ].join('\n');
    }

    private isOtherIncidentsIntent(text: string): boolean {
        const normalized = String(text || '').trim().toLocaleLowerCase('tr-TR');
        return normalized.includes('diger taleplerim')
            || normalized.includes('diğer taleplerim')
            || normalized.includes('diger talepler')
            || normalized.includes('diğer talepler')
            || normalized.includes('baska taleplerim')
            || normalized.includes('başka taleplerim');
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

    private parseSurveyTriggerStatuses(rawTriggerStatus?: string): string[] {
        const triggerStatusRaw = String(rawTriggerStatus || 'COZUMLENDI,KAPATILDI').toUpperCase();
        return Array.from(new Set(
            triggerStatusRaw
                .split(/[\s,;|]+/)
                .map((v) => String(v || '').trim())
                .filter(Boolean)
        ));
    }

    private async sendSurveyAfterIncidentStatusUpdate(incident: any, status: string): Promise<void> {
        try {
            const settings = await SettingsModel.findOne().select('survey').lean() as any;
            const surveySettings = settings?.survey;
            if (!surveySettings?.enabled || !this.client) return;

            const triggerStatuses = this.parseSurveyTriggerStatuses(surveySettings?.triggerStatus);
            const currentStatus = String(status || incident?.status || '').toUpperCase();
            const shouldTriggerSurvey = triggerStatuses.includes(currentStatus)
                || (currentStatus === 'KAPATILDI' && triggerStatuses.includes('COZUMLENDI'))
                // Customer-side closure marks incident as IPTAL. Treat it as a terminal close
                // for survey purposes unless survey trigger is explicitly narrowed down.
                || (currentStatus === 'IPTAL' && (
                    triggerStatuses.includes('KAPATILDI') || triggerStatuses.includes('COZUMLENDI')
                ));

            if (!shouldTriggerSurvey) return;

            const incidentId = String(incident?.incidentId || '').trim();
            const customerPhone = String(incident?.customerPhone || '').trim();
            if (!incidentId || !customerPhone) return;

            const alreadySent = await SurveyResponseModel.findOne({ incidentId });
            if (alreadySent) return;

            const chatId = this.toWhatsAppChatId(customerPhone);
            if (!chatId) return;

            const surveyMsgTemplate = String(surveySettings.message ||
                'Sayın {{customerName}},\n\n{{incidentId}} numaralı arıza kaydınızla ilgili kısa bir değerlendirme ricasında bulunuyoruz.\n\n✅ *Probleminiz çözüldü mü?*\n*1️⃣* - Evet, çözüldü\n*2️⃣* - Hayır, çözülmedi\n\nLütfen *1* veya *2* tuşlayınız.');
            const surveyMsg = surveyMsgTemplate
                .replace(/\{\{customerName\}\}/g, String(incident?.customerName || 'Müşteri'))
                .replace(/\{\{incidentId\}\}/g, incidentId);

            await this.client.sendMessage(chatId, surveyMsg);
            await SurveyResponseModel.create({
                incidentId,
                customerPhone,
                customerName: String(incident?.customerName || ''),
                status: 'pending',
                step: 1,
                sentAt: new Date()
            });
            logger.info(`Survey sent to ${customerPhone} for incident ${incidentId} after status ${currentStatus}`);
        } catch (surveyErr) {
            logger.error('Survey send error (technician/bot flow):', surveyErr);
        }
    }

    private async applyTechnicianIncidentUpdate(params: {
        incident: any;
        technician: any;
        status: 'INCELEMEDE' | 'ISLEME_ALINDI' | 'COZUMLENDI' | 'KAPATILDI';
        note: string;
        mediaUrl?: string;
    }): Promise<void> {
        const { incident, technician, status, note, mediaUrl } = params;
        if (status === 'KAPATILDI' && !mediaUrl) {
            throw new Error('KAPATILDI durumunda resim veya video zorunludur.');
        }

        incident.status = status;
        incident.statusHistory = Array.isArray(incident.statusHistory) ? incident.statusHistory : [];
        incident.statusHistory.push({
            status,
            note: `[Teknisyen: ${technician.displayName || technician.username}] ${note}`,
            at: new Date()
        });
        if (mediaUrl) {
            incident.images = Array.isArray(incident.images) ? incident.images : [];
            incident.images.push(mediaUrl);
        }
        await incident.save();

        const statusLabel = this.incidentStatusText(status);
        const managerMessage = [
            '*ANLIK TEKNISYEN GUNCELLEMESI*',
            `Kayit No: ${incident.incidentId}`,
            `Teknisyen: ${technician.displayName || technician.username}`,
            `Durum: ${statusLabel}`,
            `Not: ${note}`,
            mediaUrl ? `Medya: ${mediaUrl}` : ''
        ].filter(Boolean).join('\n');
        await this.notifyManagersInstantly(managerMessage);

        fireEvent('incident.status.updated', {
            incidentId: String(incident.incidentId),
            status: String(status),
            statusLabel,
            note,
            customerName: String(incident.customerName || ''),
            customerPhone: String(incident.customerPhone || ''),
            customerEmail: String(incident.customerEmail || ''),
            address: String(incident.address || ''),
            meterNo: String(incident.meterNo || ''),
            source: 'technician-whatsapp'
        }).catch(() => {});

        await this.sendSurveyAfterIncidentStatusUpdate(incident, status);
    }

    private async handleTechnicianOperationalMessage(message: Message, content: string): Promise<boolean> {
        const senderPhoneRaw = String(message.from || '').split('@')[0] || '';
        const normalizedSender = this.normalizePhoneForMatch(senderPhoneRaw);
        if (!normalizedSender) return false;

        const technician = await this.findFieldTechnicianByPhone(normalizedSender);
        if (!technician) return false;

        const state = this.technicianUpdateState.get(normalizedSender);

        if (message.type === MessageTypes.IMAGE || message.type === MessageTypes.VIDEO) {
            if (!state || state.awaiting !== 'media') {
                await this.safeReply(message, 'Lutfen once ariza kodu ile guncelleme akisina baslayin.');
                return true;
            }

            const mediaUrl = this.pendingMediaUrls.get(senderPhoneRaw) || this.pendingMediaUrls.get(normalizedSender);
            this.pendingMediaUrls.delete(senderPhoneRaw);
            this.pendingMediaUrls.delete(normalizedSender);

            if (!mediaUrl) {
                await this.safeReply(message, 'Medya dosyasi alinamadi. Lutfen tekrar gonderin.');
                return true;
            }

            const incident = await IncidentModel.findOne({ incidentId: state.incidentId });
            if (!incident) {
                this.technicianUpdateState.delete(normalizedSender);
                await this.safeReply(message, `Ariza kaydi bulunamadi: ${state.incidentId}`);
                return true;
            }

            try {
                await this.applyTechnicianIncidentUpdate({
                    incident,
                    technician,
                    status: state.status || 'INCELEMEDE',
                    note: state.note || '-',
                    mediaUrl
                });
                this.technicianUpdateState.delete(normalizedSender);
                await this.safeReply(message, `Guncelleme alindi. ${state.incidentId} kaydi basariyla islenmistir.`);
            } catch (err: any) {
                await this.safeReply(message, String(err?.message || 'Guncelleme kaydedilemedi.'));
            }
            return true;
        }

        if (message.type !== MessageTypes.TEXT) return false;

        const text = String(content || '').trim();
        if (!text) return true;

        if (!state) {
            const incidentId = this.normalizeIncidentId(text);
            if (!incidentId) {
                await this.safeReply(message, 'Teknisyen guncellemesi icin ilk mesajda sadece ariza kodunu yazin. Ornek: ARZ-1773396737967');
                return true;
            }
            const incident = await IncidentModel.findOne({ incidentId }).lean() as any;
            if (!incident) {
                await this.safeReply(message, `Kayit bulunamadi: ${incidentId}`);
                return true;
            }

            const assignedPhone = this.normalizePhoneForMatch(String(incident?.assignedTechnician?.phone || ''));
            const techPhone = this.normalizePhoneForMatch(String(technician.phone || ''));
            if (assignedPhone && techPhone && assignedPhone !== techPhone) {
                await this.safeReply(message, `Bu kayit size atanmis gorunmuyor: ${incidentId}`);
                return true;
            }

            this.technicianUpdateState.set(normalizedSender, {
                incidentId,
                awaiting: 'status'
            });
            await this.safeReply(message, 'Durum kodunu yazin: INCELEMEDE, ISLEME_ALINDI, COZUMLENDI veya KAPATILDI');
            return true;
        }

        if (state.awaiting === 'status') {
            const parsedStatus = this.parseTechnicianStatusCode(text);
            if (!parsedStatus) {
                await this.safeReply(message, 'Gecersiz durum kodu. Gecerli kodlar: INCELEMEDE, ISLEME_ALINDI, COZUMLENDI, KAPATILDI');
                return true;
            }
            state.status = parsedStatus;
            state.awaiting = 'note';
            this.technicianUpdateState.set(normalizedSender, state);
            await this.safeReply(message, 'Durum aciklamasini yazin.');
            return true;
        }

        if (state.awaiting === 'note') {
            state.note = text;
            state.awaiting = 'media';
            this.technicianUpdateState.set(normalizedSender, state);
            if (state.status === 'KAPATILDI') {
                await this.safeReply(message, 'KAPATILDI icin resim veya video zorunludur. Lutfen medya gonderin.');
            } else {
                await this.safeReply(message, 'Resim/video gonderebilirsiniz. Medya eklemek istemiyorsaniz ATLA yazin.');
            }
            return true;
        }

        if (state.awaiting === 'media') {
            if (text.toUpperCase() === 'ATLA') {
                const incident = await IncidentModel.findOne({ incidentId: state.incidentId });
                if (!incident) {
                    this.technicianUpdateState.delete(normalizedSender);
                    await this.safeReply(message, `Ariza kaydi bulunamadi: ${state.incidentId}`);
                    return true;
                }
                try {
                    await this.applyTechnicianIncidentUpdate({
                        incident,
                        technician,
                        status: state.status || 'INCELEMEDE',
                        note: state.note || '-',
                    });
                    this.technicianUpdateState.delete(normalizedSender);
                    await this.safeReply(message, `Guncelleme alindi. ${state.incidentId} kaydi basariyla guncellendi.`);
                } catch (err: any) {
                    await this.safeReply(message, String(err?.message || 'Guncelleme kaydedilemedi.'));
                }
                return true;
            }
            await this.safeReply(message, 'Lutfen resim/video gonderin veya medya eklemek istemiyorsaniz ATLA yazin.');
            return true;
        }

        return true;
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
            recentMatches?: Array<{
                incidentId: string;
                meterNo?: string;
                status?: string;
                updatedAt?: Date;
                createdAt?: Date;
            }>;
        };
    }, text: string): Promise<boolean> {
        let justStarted = false;

        if (!aiState.statusFlow?.active) {
            if (!this.parseIncidentStatusIntent(text)) {
                return false;
            }
            aiState.statusFlow = {
                active: true,
                awaiting: "incidentId",
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

        if (this.isOtherIncidentsIntent(text)) {
            if (Array.isArray(flow.recentMatches) && flow.recentMatches.length > 1) {
                await this.safeReply(message, this.buildIncidentStatusMatchesMessage(flow.recentMatches));
                return true;
            }
            await this.safeReply(message, 'Listelenecek baska talep bulunamadi. Lutfen ariza kodu, telefon numarasi, tesisat/abone no veya ad soyad yaziniz.');
            return true;
        }

        if (justStarted && flow.awaiting === "incidentId") {
            await this.safeReply(message, await this.buildIncidentStatusStartMessage());
            return true;
        }

        // Legacy sessions may still be at name/phone steps; migrate to incident code flow.
        if (flow.awaiting === "name" || flow.awaiting === "phone") {
            const inlineIncidentId = this.normalizeIncidentId(text);
            if (inlineIncidentId) {
                flow.awaiting = "incidentId";
                flow.data.incidentId = inlineIncidentId;
            } else {
                flow.awaiting = "incidentId";
                await this.safeReply(message, await this.buildIncidentStatusStartMessage());
                return true;
            }
        }

        if (flow.awaiting === "incidentId") {
            const rawQuery = String(text || '').trim();
            const incidentId = this.normalizeIncidentId(rawQuery);
            const normalizedPhone = this.normalizeTurkishPhone(rawQuery);
            const meterNo = this.sanitizeMeterNo(rawQuery);
            const hasMeterNo = this.isValidMeterNo(meterNo);
            const hasName = rawQuery.length >= 3 && /[A-Za-zÇĞİÖŞÜçğıöşü]/.test(rawQuery);

            const orFilters: any[] = [];
            if (incidentId) orFilters.push({ incidentId });
            if (normalizedPhone) orFilters.push({ customerPhone: normalizedPhone });
            if (hasMeterNo) orFilters.push({ meterNo });
            if (hasName) {
                const escapedName = rawQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                orFilters.push({ customerName: { $regex: escapedName, $options: 'i' } });
            }

            if (!orFilters.length) {
                await this.safeReply(message, "Lutfen ariza kodu, telefon numarasi, tesisat/abone no veya ad soyad giriniz.");
                return true;
            }

            const records = await IncidentModel.find({ $or: orFilters })
                .sort({ updatedAt: -1, createdAt: -1 })
                .limit(5)
                .lean() as any[];

            flow.recentMatches = records.map((record) => ({
                incidentId: String(record?.incidentId || ''),
                meterNo: String(record?.meterNo || ''),
                status: String(record?.status || ''),
                updatedAt: record?.updatedAt,
                createdAt: record?.createdAt,
            }));

            flow.active = false;

            if (!records.length) {
                await this.safeReply(message, `Kayit bulunamadi: ${rawQuery}`);
                return true;
            }

            if (records.length > 1) {
                await this.safeReply(message, this.buildIncidentStatusMatchesMessage(records));
                return true;
            }

            const record = records[0];
            await this.safeReply(message, await this.buildIncidentStatusResultMessage(record));
            return true;
        }

        return false;
    }

    private async processCustomerIncidentClosureFlow(
        message: Message,
        phoneNumber: string,
        aiState: {
            active: boolean;
            history: string[];
            infoProvided: boolean;
            dispatchDone: boolean;
            closureFlow?: {
                active: boolean;
                awaiting: "incidentId" | "confirm" | "searchCriteria";
                requestedReason?: string;
                selectedIncidentId?: string;
                candidates: Array<{
                    incidentId: string;
                    status?: string;
                    meterNo?: string;
                    address?: string;
                    customerName?: string;
                    customerPhone?: string;
                    customerEmail?: string;
                    updatedAt?: Date;
                    createdAt?: Date;
                }>;
            };
        },
        text: string
    ): Promise<boolean> {
        let justStarted = false;

        if (!aiState.closureFlow?.active) {
            if (!this.parseCustomerIncidentClosureIntent(text)) {
                return false;
            }

            const records = await this.findCustomerClosableIncidents(phoneNumber, text);
            if (!records.length) {
                // No incidents found by WhatsApp phone → ask customer for name/phone/incident number
                aiState.closureFlow = {
                    active: true,
                    awaiting: 'searchCriteria',
                    requestedReason: String(text || '').trim() || 'Musteri talebi uzerine iptal',
                    candidates: []
                };
                await this.safeReply(message, 'Uzerinize kayitli acik talep bulunamadi.\n\nAd Soyad, telefon numaraniz veya talep numaranizi paylasirsaniz sistemi sorgulayabilirim.');
                return true;
            }

            aiState.closureFlow = {
                active: true,
                awaiting: 'incidentId',
                requestedReason: String(text || '').trim() || 'Sorun cozuldu / yanlis talep',
                candidates: records.map((record) => ({
                    incidentId: String(record?.incidentId || ''),
                    status: String(record?.status || ''),
                    meterNo: String(record?.meterNo || ''),
                    address: String(record?.address || ''),
                    customerName: String(record?.customerName || ''),
                    customerPhone: String(record?.customerPhone || ''),
                    customerEmail: String(record?.customerEmail || ''),
                    updatedAt: record?.updatedAt,
                    createdAt: record?.createdAt,
                }))
            };
            justStarted = true;
        }

        const flow = aiState.closureFlow;
        if (!flow) return false;

        if (this.isConversationEndIntent(text)) {
            aiState.closureFlow = undefined;
            this.clearInactivityTimer(phoneNumber);
            await this.safeReply(message, this.buildFarewellReply(text));
            return true;
        }

        if (justStarted) {
            if (flow.candidates.length === 1) {
                // Only one open incident — go straight to confirm
                flow.selectedIncidentId = flow.candidates[0].incidentId;
                flow.awaiting = 'confirm';
                await this.safeReply(message, await this.buildIncidentClosureConfirmMessage(flow.candidates[0]));
                return true;
            }
            await this.safeReply(message, await this.buildIncidentClosureSelectionMessage(flow.candidates));
            return true;
        }

        if (flow.awaiting === 'searchCriteria') {
            const searchText = String(text || '').trim();
            if (!searchText) {
                await this.safeReply(message, 'Lutfen Ad Soyad, telefon numarasi veya talep numaranizi yaziniz.');
                return true;
            }
            const found = await this.findIncidentsByCustomerSearch(searchText);
            if (!found.length) {
                aiState.closureFlow = undefined;
                await this.safeReply(message, 'Aradiginiz kriterlere uygun acik talep bulunamadi. Talep numaranizi dogrudan yazarak tekrar deneyebilirsiniz.');
                return true;
            }
            flow.candidates = found.map((record) => ({
                incidentId: String(record?.incidentId || ''),
                status: String(record?.status || ''),
                meterNo: String(record?.meterNo || ''),
                address: String(record?.address || ''),
                customerName: String(record?.customerName || ''),
                customerPhone: String(record?.customerPhone || ''),
                customerEmail: String(record?.customerEmail || ''),
                updatedAt: record?.updatedAt,
                createdAt: record?.createdAt,
            }));
            if (flow.candidates.length === 1) {
                flow.selectedIncidentId = flow.candidates[0].incidentId;
                flow.awaiting = 'confirm';
                await this.safeReply(message, await this.buildIncidentClosureConfirmMessage(flow.candidates[0]));
                return true;
            }
            flow.awaiting = 'incidentId';
            await this.safeReply(message, await this.buildIncidentClosureSelectionMessage(flow.candidates));
            return true;
        }

        if (flow.awaiting === 'incidentId') {
            const candidateText = String(text || '').trim();
            const incidentId = this.normalizeIncidentId(candidateText);
            let selected = flow.candidates.find((item) => item.incidentId === incidentId);

            if (!selected && /^\d+$/.test(candidateText)) {
                const index = Number(candidateText) - 1;
                if (index >= 0) {
                    selected = flow.candidates[index];
                }
            }

            if (!selected) {
                await this.safeReply(message, await this.buildIncidentClosureSelectionMessage(flow.candidates));
                return true;
            }

            flow.selectedIncidentId = selected.incidentId;
            flow.awaiting = 'confirm';
            await this.safeReply(message, await this.buildIncidentClosureConfirmMessage(selected));
            return true;
        }

        if (flow.awaiting === 'confirm') {
            if (!this.isCustomerClosureApproval(text)) {
                await this.safeReply(message, await this.buildIncidentClosureNeedApprovalMessage());
                return true;
            }

            const selectedIncidentId = String(flow.selectedIncidentId || '').trim();
            const incident = await IncidentModel.findOne({ incidentId: selectedIncidentId });
            if (!incident) {
                aiState.closureFlow = undefined;
                await this.safeReply(message, `Talep bulunamadi: ${selectedIncidentId}`);
                return true;
            }

            await this.closeIncidentByCustomerRequest(incident, String(flow.requestedReason || 'Sorun cozuldu / yanlis talep'));
            aiState.closureFlow = undefined;
            await this.safeReply(message, await this.buildIncidentClosureSuccessMessage(selectedIncidentId));
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
        lastIncidentSubmittedAt?: number;
        incidentFlow?: {
            active: boolean;
            awaiting: "issue" | "name" | "phone" | "phoneConfirm" | "address" | "addressConfirm" | "askPhoto" | "photo" | "askLocation" | "location" | "meter" | "email" | "confirm" | "correctionField";
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
                    customerName: (aiState as any).knownCustomerName || "Bilinmiyor",
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
                    // İsmi biliyorsak name adımını atla
                    if (flow.data.customerName && flow.data.customerName !== 'Bilinmiyor') {
                        flow.awaiting = "phone";
                        await this.safeReply(message, "Kaydınızı oluşturuyorum. Lütfen telefon numaranizi yazın. Örnek: 05XXXXXXXXX");
                    } else {
                        flow.awaiting = "name";
                        await this.safeReply(message, "Kaydınızı oluşturuyorum. Ad soyad bilginizi alabilir miyim?");
                    }
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
                aiState.lastIncidentSubmittedAt = Date.now();
                // Ariza kaydi tamamlandiginda ek inaktif hatirlatma/sonlandirma mesaji gonderme.
                this.clearInactivityTimer(phoneNumber);
                if (dispatched) {
                    const successMessage = await this.getBotMessageTemplate(
                        'incidentCreatedSuccessMessage',
                        'Tesekkur ederiz. Kaydiniz olusturuldu ve ilgili numaraya/eposta adresine gonderildi.'
                    );
                    await this.safeReply(message, successMessage);
                } else {
                    const dispatchFailedMessage = await this.getBotMessageTemplate(
                        'incidentCreatedDispatchFailedMessage',
                        'Kaydiniz olusturuldu ancak su an yonlendirme yapilamadi. Sistem ayarlari kontrol edilmelidir.'
                    );
                    await this.safeReply(message, dispatchFailedMessage);
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
            if (!this.isLikelyHumanName(trimmed)) {
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
            flow.awaiting = "phoneConfirm";
            await this.safeReply(message, `Telefon numaranizi "${normalizedPhone}" olarak algiladim. Dogruysa 'evet', degilse 'hayir' yazin.`);
            return true;
        }

        if (flow.awaiting === "phoneConfirm") {
            if (this.isPositiveConfirmation(text)) {
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
            if (this.isNegativeConfirmation(text)) {
                flow.data.customerPhone = "Bilinmiyor";
                flow.awaiting = "phone";
                await this.safeReply(message, "Anladim. Lutfen telefon numaranizi yeniden yazin. Ornek: 05XXXXXXXXX");
                return true;
            }
            await this.safeReply(message, "Telefon numaranizi onaylamak icin lutfen sadece 'evet' veya 'hayir' yazin.");
            return true;
        }

        if (flow.awaiting === "address") {
            const addr = String(text || "").trim();
            if (!this.isLikelyAddress(addr)) {
                await this.safeReply(message, "Adres bilgisini daha acik yazmanizi rica ederiz.");
                return true;
            }
            flow.data.address = addr;
            // Adresi ContactModel'a da kaydet
            ContactModel.findOneAndUpdate(
                { phoneNumber },
                { $set: { address: addr } },
                { upsert: true }
            ).catch(() => {});
            flow.awaiting = "addressConfirm";
            await this.safeReply(message, `Adresinizi "${addr}" olarak algiladim. Dogruysa 'evet', degilse 'hayir' yazin.`);
            return true;
        }

        if (flow.awaiting === "addressConfirm") {
            if (this.isPositiveConfirmation(text)) {
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
            if (this.isNegativeConfirmation(text)) {
                flow.data.address = "Bilinmiyor";
                flow.awaiting = "address";
                await this.safeReply(message, "Anladim. Lutfen adresinizi yeniden yazin (mahalle/sokak/no bilgisiyle). ");
                return true;
            }
            await this.safeReply(message, "Adres bilgisini onaylamak icin lutfen sadece 'evet' veya 'hayir' yazin.");
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
            await this.safeReply(message, "Tesekkurler. Simdi e-posta adresinizi yazin. Ornek: ad.soyad@example.com (E-posta yoksa 'e-posta yok' yazabilirsiniz.)");
            return true;
        }

        if (flow.awaiting === "email") {
            const email = String(text || "").trim().toLowerCase();
            if (this.isNoEmailIntent(email)) {
                flow.data.customerEmail = "Bilinmiyor";
                if (flow.correctingSingleField) {
                    flow.correctingSingleField = false;
                }
                flow.awaiting = "confirm";
                aiState.infoProvided = true;
                const noEmailFallbackMessage = await this.getBotMessageTemplate(
                    'noEmailFallbackMessage',
                    'E-posta bilginizin olmadigini belirttiniz. Iletisim icin telefon numaraniz kullanilacaktir.'
                );
                await this.safeReply(message, noEmailFallbackMessage);
                await this.safeReply(message, this.buildIncidentSummaryText(flow.data));
                return true;
            }
            if (!this.isValidEmail(email)) {
                await this.safeReply(message, "E-posta adresi gecersiz gorunuyor. Lutfen gecerli bir e-posta yazin. Ornek: ad.soyad@example.com (E-posta yoksa 'e-posta yok' yazabilirsiniz.)");
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
        // Extract tenant/session context from message (injected by multi-client event handler)
        const sessionCompositeKey = (message as any).__sessionKey || 'default:primary';
        const [sessionTenantId, sessionKeyPart] = sessionCompositeKey.split(':');
        const incidentTenantId = sessionTenantId || 'default';
        const incidentSessionKey = sessionKeyPart || 'primary';
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
            tenantId: incidentTenantId,
            sessionKey: incidentSessionKey,
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

        try {
            await this.autoAssignIncidentByArea(incidentDoc);
        } catch (assignmentErr) {
            logger.error('Otomatik teknisyen atamasi basarisiz:', assignmentErr);
        }

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
            `Imza: ${String(settings?.botIdentity?.author || AppConfig.instance.getBotAuthor())}`,

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
            this.csvEscape(String(settings?.botIdentity?.author || AppConfig.instance.getBotAuthor())),
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
                notificationTemplates.institutionName || process.env.INCIDENT_MAIL_INSTITUTION || "Kurum Bilgi Sistemi"
            ).trim();
            const signatureName = String(
                notificationTemplates.signatureName || String(settings?.botIdentity?.author || AppConfig.instance.getBotAuthor())
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
        const t = this.normalizeIntentTextLoose(text);
        return /(elektrik.*(kesinti|ariza|yok|gitti|calismiyor))|(kesinti.*(var|mevcut))|(ariza.*(var|mevcut))|(mahallemde.*elektrik)|(evimde.*elektrik)|(sokakta.*elektrik)|(aydinlatma.*(calismiyor|yanmiyor|ariza))|(bulundugu yerde.*(calismiyor|yanmiyor|kesinti|ariza))/.test(t);
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
        
        // Initialize default:primary session for backwards compatibility
        this.createSession('default', 'primary');
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
        // Sync default:primary session to DB so the UI sessions dropdown shows it
        try {
            const info = await this.client.getState().catch(() => null);
            const winfo = (this.client as any).info;
            const phone = winfo?.wid?.user ? winfo.wid.user + '@c.us' : undefined;
            const pushName = winfo?.pushname || undefined;
            await TenantSessionModel.findOneAndUpdate(
                { tenantId: 'default', sessionKey: 'primary' },
                {
                    $set: {
                        sessionName: 'Ana Oturum',
                        status: 'connected',
                        botPhone: phone,
                        botPushName: pushName,
                        lastStatusUpdate: new Date(),
                    },
                    $setOnInsert: { tenantId: 'default', sessionKey: 'primary' }
                },
                { upsert: true, new: true }
            );
            logger.info('TenantSessionModel synced for default:primary');
        } catch (err) {
            logger.warn('Could not sync TenantSessionModel:', err);
        }
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
            Promise.resolve(this.client.initialize()).catch((error: any) => {
                logger.warn('Reconnect attempt failed:', error?.message || error);
            });
        }, 5000);
    }

    public initialize() {
        try {
            Promise.resolve(this.client.initialize()).catch((error: any) => {
                logger.error(`Client initialization error: ${error?.message || error}`);
            });
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
            Promise.resolve(this.client.initialize()).catch((error: any) => {
                logger.warn('Manual reconnect failed:', error?.message || error);
            });
        }, 1000);
    }

    // ============ MULTI-SESSION / MULTI-CLIENT SUPPORT ============

    /**
     * Build composite key for session lookup
     */
    private buildSessionKey(tenantId: string, sessionKey: string): string {
        return `${tenantId}:${sessionKey}`;
    }

    /**
     * Get a specific client for a tenant+session combination
     */
    public getSessionClient(tenantId: string, sessionKey: string): any {
        const compositeKey = this.buildSessionKey(tenantId, sessionKey);
        return this.sessionClients.get(compositeKey) || null;
    }

    /**
     * Get status for a specific session (or default:primary if not specified)
     */
    public getSessionStatus(tenantId?: string, sessionKey?: string): any {
        const tenant = tenantId || 'default';
        const session = sessionKey || 'primary';
        const compositeKey = this.buildSessionKey(tenant, session);

        const client = this.sessionClients.get(compositeKey);
        const qrData = this.sessionQrData.get(compositeKey);

        if (!client || !qrData) {
            return { status: 'not_initialized', uptime: process.uptime() };
        }

        const info = client?.info;
        if (info && info.wid) {
            return {
                status: 'connected',
                phone: info.wid?.user,
                pushName: info.pushname,
                uptime: process.uptime(),
                tenantId: tenant,
                sessionKey: session
            };
        }

        if (qrData.qrCodeData && !qrData.qrScanned) {
            return {
                status: 'scanning',
                qrCode: qrData.qrCodeData,
                uptime: process.uptime(),
                tenantId: tenant,
                sessionKey: session
            };
        }

        return {
            status: 'disconnected',
            uptime: process.uptime(),
            tenantId: tenant,
            sessionKey: session
        };
    }

    /**
     * Create and initialize a session with its own client instance (multi-client support)
     * Supports: default:primary (always), and any other tenantId:sessionKey combinations
     */
    public createSession(tenantId: string, sessionKey: string): void {
        const compositeKey = this.buildSessionKey(tenantId, sessionKey);

        // Prevent duplicate sessions
        if (this.sessionClients.has(compositeKey)) {
            logger.info(`Session ${compositeKey} already exists, skipping creation`);
            return;
        }

        logger.info(`Creating session ${compositeKey}`);

        // Special case: default:primary uses the singleton client (backwards compat)
        if (tenantId === 'default' && sessionKey === 'primary') {
            this.sessionClients.set(compositeKey, this.client);
            this.sessionQrData.set(compositeKey, this.qrData);
        } else {
            // Multi-client support: Create new independent client for non-primary sessions
            try {
                const scopedClientId = `tenant-${tenantId}-${sessionKey}`.replace(/[^a-zA-Z0-9_-]/g, '_');
                const sessionPuppeteerOptions: any = {
                    ...ClientConfig.puppeteer,
                };
                // whatsapp-web.js mutates options for LocalAuth on existing clients.
                // Never forward userDataDir when authStrategy is LocalAuth.
                if ('userDataDir' in sessionPuppeteerOptions) {
                    delete sessionPuppeteerOptions.userDataDir;
                }
                const newClient = new Client({
                    ...ClientConfig,
                    // Use dedicated LocalAuth clientId for each tenant/session.
                    // LocalAuth is incompatible with custom puppeteer userDataDir.
                    authStrategy: new LocalAuth({
                        clientId: scopedClientId,
                        dataPath: path.join(process.cwd(), '.wwebjs_auth'),
                        rmMaxRetries: 5,
                    }),
                    puppeteer: sessionPuppeteerOptions,
                });

                // Setup event handlers for this new client
                this.setupSessionEventHandlers(compositeKey, newClient);

                this.sessionClients.set(compositeKey, newClient);
                this.sessionQrData.set(compositeKey, {
                    qrCodeData: '',
                    qrScanned: false,
                    authenticated: false
                });

                // Initialize the new client
                Promise.resolve(newClient.initialize()).catch(async (error: any) => {
                    logger.error(`Failed to initialize session ${compositeKey}:`, error);
                    this.sessionMetadata.set(compositeKey, {
                        ...(this.sessionMetadata.get(compositeKey) || {}),
                        status: 'error',
                        lastError: String(error?.message || error || 'initialize failed'),
                        updatedAt: new Date(),
                    });
                    try {
                        const [errorTenantId, errorSessionKey] = compositeKey.split(':');
                        await TenantSessionModel.updateOne(
                            { tenantId: errorTenantId, sessionKey: errorSessionKey },
                            {
                                status: 'error',
                                errorMessage: String(error?.message || error || 'initialize failed'),
                                lastStatusUpdate: new Date(),
                            }
                        );
                    } catch (_) {
                        // best-effort DB sync for UI visibility
                    }
                });
            } catch (error) {
                logger.error(`Failed to create session ${compositeKey}:`, error);
                return;
            }
        }

        this.sessionMetadata.set(compositeKey, {
            createdAt: new Date(),
            status: 'initializing',
            clientVersion: 'wawebjs'
        });
    }

    /**
     * Setup event handlers for a session-specific client
     */
    private setupSessionEventHandlers(
        compositeKey: string,
        client: any
    ): void {
        const handleQr = (qr: string) => {
            logger.info(`[${compositeKey}] QR received`);
            const qrData = this.sessionQrData.get(compositeKey);
            if (qrData) {
                qrData.qrCodeData = qr;
                qrData.qrScanned = false;
                qrData.authenticated = false;
            }
        };

        const handleAuthenticated = () => {
            logger.info(`[${compositeKey}] Client authenticated`);
            const qrData = this.sessionQrData.get(compositeKey);
            if (qrData) {
                qrData.authenticated = true;
                qrData.qrScanned = true;
            }
        };

        const handleAuthFailure = (message: string) => {
            logger.error(`[${compositeKey}] Auth failed:`, message);
            const qrData = this.sessionQrData.get(compositeKey);
            if (qrData) {
                qrData.authenticated = false;
                qrData.qrScanned = false;
                qrData.qrCodeData = '';
            }
        };

        const handleDisconnect = (reason: string) => {
            logger.info(`[${compositeKey}] Disconnected:`, reason);
            const qrData = this.sessionQrData.get(compositeKey);
            if (qrData) {
                qrData.qrScanned = false;
                qrData.authenticated = false;
                qrData.qrCodeData = '';
            }

            // Auto-reconnect after 5 seconds
            setTimeout(() => {
                logger.info(`[${compositeKey}] Attempting to reconnect...`);
                try {
                    Promise.resolve(client.initialize()).catch((error: any) => {
                        logger.warn(`[${compositeKey}] Reconnect failed:`, error?.message || error);
                    });
                } catch (error) {
                    logger.warn(`[${compositeKey}] Reconnect failed:`, error);
                }
            }, 5000);
        };

        const handleReady = () => {
            logger.info(`[${compositeKey}] Client ready`);
        };

        // Attach handlers
        client.on('qr', handleQr);
        client.on('authenticated', handleAuthenticated);
        client.on('auth_failure', handleAuthFailure);
        client.on('disconnected', handleDisconnect);
        client.on('ready', handleReady);

        // Route incoming messages through the main handler but track session origin
        client.on('message', async (message: any) => {
            try {
                // Inject compositeKey so handleMessage knows which session this came from
                (message as any).__sessionKey = compositeKey;
                await this.handleMessage(message);
            } catch (error) {
                logger.error(`[${compositeKey}] Message handling error:`, error);
            }
        });

        client.on('message_create', async (message: any) => {
            try {
                (message as any).__sessionKey = compositeKey;
                await this.handleOutgoingMessage(message);
            } catch (error) {
                logger.error(`[${compositeKey}] Outgoing message error:`, error);
            }
        });
    }

    /**
     * Destroy a session
     */
    public async destroySession(tenantId: string, sessionKey: string): Promise<void> {
        const compositeKey = this.buildSessionKey(tenantId, sessionKey);

        try {
            const client = this.sessionClients.get(compositeKey);
            if (client) {
                await client.destroy();
                logger.info(`Session ${compositeKey} destroyed`);
            }
        } catch (error) {
            logger.warn(`Error destroying session ${compositeKey}:`, error);
        }

        this.sessionClients.delete(compositeKey);
        this.sessionQrData.delete(compositeKey);
        this.sessionMetadata.delete(compositeKey);
    }

    /**
     * List all active sessions
     */
    public listSessions(): Array<{ tenantId: string; sessionKey: string; status: any }> {
        const sessions = [];
        for (const [key, _client] of this.sessionClients) {
            const [tenantId, sessionKey] = key.split(':');
            sessions.push({
                tenantId,
                sessionKey,
                status: this.getSessionStatus(tenantId, sessionKey)
            });
        }
        return sessions;
    }

    private async trackContact(user: WAWebJS.Contact, _message: Message, userI18n: UserI18n, phoneOverride?: string) {
        try {
            const trackedPhone = normalizeConversationPhone(phoneOverride || user.number) || String(phoneOverride || user.number || "").trim();
            if (!trackedPhone) return;

            const existing = await ContactModel.findOne({ phoneNumber: trackedPhone }).lean() as any;
            const isNew = !existing;

            // Admin tarafından manuel girilmiş ad/soyad/adres varsa koruyarak güncelle
            // Sadece pushName ve iletişim istatistiklerini güncelle
            const setFields: Record<string, any> = {
                pushName: user.pushname,
                language: userI18n.getLanguage(),
                lastInteraction: new Date()
            };

            // name alanını yalnızca admin kaydetmemişse yaz (pushName != name = admin girmiş demek)
            if (!existing?.name) {
                // Yeni müşteri: önce geçmiş incident'lardan isim arayalım
                const canonicalPhone = trackedPhone.replace(/@.*$/, '');
                const pastIncident = await IncidentModel.findOne({
                    $or: [
                        { sourcePhoneNumber: trackedPhone },
                        { sourcePhoneNumber: canonicalPhone }
                    ],
                    customerName: { $nin: ['Bilinmiyor', '', null] }
                }).sort({ createdAt: -1 }).lean() as any;

                if (pastIncident?.customerName) {
                    const parts = pastIncident.customerName.trim().split(/\s+/);
                    setFields.name = parts[0] || pastIncident.customerName;
                    if (parts.length > 1) setFields.lastName = parts.slice(1).join(' ');
                } else if (user.name || user.pushname) {
                    setFields.name = user.name || user.pushname;
                }
            }

            await ContactModel.findOneAndUpdate(
                { phoneNumber: trackedPhone },
                { $set: setFields, $inc: { interactionsCount: 1 } },
                { upsert: true, new: true }
            );

            if (isNew) {
                await applyScore(trackedPhone, 'first_interaction');
                fireEvent('contact.new', { phoneNumber: trackedPhone, name: user.name || user.pushname }).catch(() => {});
            }
            await applyScore(trackedPhone, 'message_received');
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

            const canonicalUserPhone = normalizeConversationPhone(user.number) || user.number;

            await this.trackContact(user, message, userI18n, canonicalUserPhone);
            chat = await message.getChat();

            if (message.from === this.client.info.wid._serialized || message.isStatus) {
                return;
            }

            // KVKK consent check
                const userPhone = canonicalUserPhone;
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
                        await this.safeReply(message, await this.buildWelcomeMenuMessage());
                        return;
                    } else {
                        await this.safeReply(message, await this.buildKvkkMessage());
                        return;
                    }
                }
            }

            let savedMediaUrl: string | undefined;

            // Anket yanıtını kontrol et (multi-step: adım bazlı)
            if (!user.isMe) {
                try {
                    const incomingPhoneRaw = String(canonicalUserPhone || '').trim();
                    const incomingPhoneNorm = normalizeConversationPhone(incomingPhoneRaw);
                    const incomingPhoneTr = this.normalizeTurkishPhone(incomingPhoneRaw);
                    const phoneCandidates = Array.from(new Set([
                        incomingPhoneRaw,
                        incomingPhoneNorm,
                        incomingPhoneTr,
                    ].filter(Boolean)));

                    const pendingSurvey = await SurveyResponseModel.findOne({
                        customerPhone: { $in: phoneCandidates },
                        status: 'pending'
                    }).sort({ sentAt: -1 });

                    if (pendingSurvey) {
                        const trimmed = content.trim();
                        const surveySettings = await SettingsModel.findOne().select('survey').lean() as any;
                        const thankYouMsg = surveySettings?.survey?.thankYouMessage ||
                            'Değerlendirmeniz için teşekkürler! Geri bildiriminiz bizim için çok değerli. 🙏';

                        if (pendingSurvey.step === 1) {
                            // Q1: Problem çözüldü mü? 1=evet, 2=hayır
                            if (trimmed === '1' || trimmed === '2') {
                                pendingSurvey.solutionSatisfied = trimmed === '1';
                                pendingSurvey.step = 2;
                                await pendingSurvey.save();
                                await this.safeReply(message,
                                    '👨‍🔧 *Teknisyen İletişimi*\n\nTeknisyen ile iletişimden memnun kaldınız mı?\n\n*1️⃣* - Evet, memnun kaldım\n*2️⃣* - Hayır, memnun kalmadım');
                                return;
                            }
                            // Geçersiz giriş - hatırlat
                            await this.safeReply(message,
                                '⚠️ Lütfen sadece *1* veya *2* tuşlayınız.\n\n✅ Probleminiz çözüldü mü?\n*1️⃣* - Evet, çözüldü\n*2️⃣* - Hayır, çözülmedi');
                            return;
                        }

                        if (pendingSurvey.step === 2) {
                            // Q2: Teknisyen iletişimi 1=memnun, 2=değil
                            if (trimmed === '1' || trimmed === '2') {
                                pendingSurvey.techSatisfied = trimmed === '1';
                                pendingSurvey.step = 3;
                                await pendingSurvey.save();
                                await this.safeReply(message,
                                    '💬 *Ek Görüş*\n\nBelirtmek istediğiniz başka bir konu var mı?\n\nDüşüncelerinizi yazabilir ya da *"Hayır"* yazarak anketi tamamlayabilirsiniz.');
                                return;
                            }
                            await this.safeReply(message,
                                '⚠️ Lütfen sadece *1* veya *2* tuşlayınız.\n\n👨‍🔧 Teknisyen ile iletişimden memnun kaldınız mı?\n*1️⃣* - Evet, memnun kaldım\n*2️⃣* - Hayır, memnun kalmadım');
                            return;
                        }

                        if (pendingSurvey.step === 3) {
                            // Q3: Serbest yorum
                            if (trimmed.toLowerCase() !== 'hayır' && trimmed.toLowerCase() !== 'hayr' && trimmed.length > 0) {
                                pendingSurvey.freeComment = trimmed.slice(0, 1000);
                            }
                            pendingSurvey.step = 0;
                            pendingSurvey.status = 'completed';
                            pendingSurvey.completedAt = new Date();
                            await pendingSurvey.save();
                            await this.safeReply(message, thankYouMsg);
                            return;
                        }
                    }
                } catch (surveyErr) {
                    logger.error('Survey response handling error:', surveyErr);
                }
            }

            // Check maintenance mode (save flag into message, reply & stop if active)
            let _maintenanceModeActive = false;
            let _maintenanceModeData: { enabled: boolean; message?: string; endsAt?: Date | null } | null = null;
            let processedContent = content;
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
                const inboxType: 'text' | 'image' | 'other' =
                    (message.type === MessageTypes.IMAGE || message.type === MessageTypes.VIDEO) ? 'image' :
                    (message.type === MessageTypes.TEXT ? 'text' : 'other');
                const isGroup = chat?.isGroup ?? false;
                const normalizedContent = String(content || "").trim();
                const existingAiState = this.aiConversationState.get(canonicalUserPhone);
                shouldPrioritizeIncidentFlow = !!normalizedContent && (
                    this.parseIncidentIntent(normalizedContent) ||
                    this.parseIncidentStatusIntent(normalizedContent) ||
                    this.parseCustomerIncidentClosureIntent(normalizedContent) ||
                    this.isOutageComplaint(normalizedContent) ||
                    this.hasContactInfo(normalizedContent) ||
                    Boolean(existingAiState?.incidentFlow?.active) ||
                    Boolean(existingAiState?.statusFlow?.active) ||
                    Boolean(existingAiState?.closureFlow?.active) ||
                    Boolean(existingAiState?.menuStep === 'waiting') ||
                    Boolean(existingAiState?.faultCategoryStep === 'waiting')
                );
                const conversationPhone = canonicalUserPhone;
                const normalizedUserNumber = conversationPhone || canonicalUserPhone;

                // Save media to disk when image or video is received.
                if (message.type === MessageTypes.IMAGE || message.type === MessageTypes.VIDEO) {
                    try {
                        const media = await message.downloadMedia();
                        if (media?.data) {
                            const buffer = Buffer.from(media.data, 'base64');
                            const defaultExt = message.type === MessageTypes.VIDEO ? 'mp4' : 'jpg';
                            const ext = (media.mimetype?.split('/')[1]?.split(';')[0] || defaultExt).replace('jpeg', 'jpg');
                            const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'incident-images', user.number);
                            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
                            const filename = `${Date.now()}.${ext}`;
                            const filePath = path.join(uploadDir, filename);
                            fs.writeFileSync(filePath, buffer);
                            savedMediaUrl = `/public/uploads/incident-images/${user.number}/${filename}`;
                            // Keep both raw and normalized keys to avoid lookup mismatches later.
                            this.pendingMediaUrls.set(user.number, savedMediaUrl);
                            this.pendingMediaUrls.set(normalizedUserNumber, savedMediaUrl);
                            logger.info(`Medya kaydedildi: ${filePath}`);
                        }
                    } catch (imgErr) {
                        logger.warn('Medya kaydedilemedi:', imgErr);
                    }
                }

                // Sesli mesaj işleme: metne çevirme
                if (message.type === MessageTypes.VOICE && !content) {
                    logger.debug(`[VOICE] Sesli mesaj tespit edildi, indiriliyor...`);
                    try {
                        const media = await message.downloadMedia();
                        if (media?.data) {
                            logger.info(`[VOICE] Media indirildi: ${media.mimetype}`);
                            const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'voice-temp', user.number);
                            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
                            
                            // Format türünü belirle
                            const mimeType = media.mimetype || 'audio/ogg';
                            let ext = 'ogg';
                            if (mimeType.includes('wav')) ext = 'wav';
                            else if (mimeType.includes('mp4') || mimeType.includes('m4a')) ext = 'mp4';
                            else if (mimeType.includes('mpeg') || mimeType.includes('mp3')) ext = 'mp3';
                            
                            const tempFile = path.join(uploadDir, `${Date.now()}.${ext}`);
                            fs.writeFileSync(tempFile, Buffer.from(media.data, 'base64'));
                            logger.info(`[VOICE] Geçici dosya kaydedildi (${ext}): ${tempFile}`);
                            
                            logger.info(`[VOICE] STT işlemi başlıyor: ${tempFile}`);
                            const sttResult = await speechToText(tempFile);
                            processedContent = (sttResult?.text || sttResult?.result || '').trim();
                            logger.info(`[VOICE] STT sonucu: "${processedContent}"`);
                            if (!processedContent) processedContent = '[Sesli mesaj - metin dönüştürme başarısız]';
                            
                            // Temp dosyayı sil
                            try { fs.unlinkSync(tempFile); } catch (delErr) {
                                logger.warn(`[VOICE] Geçici dosya silinemedi: ${delErr}`);
                            }
                        } else {
                            logger.warn(`[VOICE] Media data boş!`);
                            processedContent = '[Sesli mesaj - data alınamadı]';
                        }
                    } catch (voiceErr) {
                        logger.error(`[VOICE] İşleme hatası:`, voiceErr);
                        processedContent = '[Sesli mesaj - işleme hatası]';
                    }
                }

                const msgDoc = await MessageModel.create({
                    phoneNumber: conversationPhone || user.number,
                    body: processedContent || inboxBody,
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
                fireEvent('message.received', { phoneNumber: conversationPhone || canonicalUserPhone, body: inboxBody }).catch(() => {});

                // Track campaign reply (mark first unacknowledged delivery for this phone)
                const updated = await CampaignModel.updateOne(
                    {
                        'deliveryReport.phone': canonicalUserPhone,
                        'deliveryReport.status': 'sent',
                        'deliveryReport.repliedAt': { $exists: false }
                    },
                    { $set: { 'deliveryReport.$.repliedAt': new Date() } }
                );
                if (updated.modifiedCount > 0) {
                    await applyScore(canonicalUserPhone, 'campaign_reply');
                }

                if (!shouldPrioritizeIncidentFlow) {
                    // Check auto-reply rules
                    const replied = await this.checkAutoReply(canonicalUserPhone, processedContent || content, chat);
                    logger.debug(`[FLOW] checkAutoReply result: ${replied}`);
                    if (replied) return;

                    // Check active flows
                    const flowHandled = await this.executeFlow(canonicalUserPhone, processedContent || content, chat);
                    logger.debug(`[FLOW] executeFlow result: ${flowHandled}`);
                    if (flowHandled) return;
                }
            }

            logger.debug(`[FLOW] shouldPrioritizeIncidentFlow: ${shouldPrioritizeIncidentFlow}, processedContent: "${processedContent}"`);

            if (shouldPrioritizeIncidentFlow) {
                await this.runInPhoneQueue(canonicalUserPhone, async () => {
                    await this.processMessageContent(message, processedContent || content, userI18n, chat, savedMediaUrl, canonicalUserPhone);
                });
                return;
            }

            const results = await Promise.allSettled([
                onboard(message, userI18n),
                this.runInPhoneQueue(canonicalUserPhone, async () => {
                    logger.debug(`[FLOW] processMessageContent çağrılıyor: "${processedContent || content}"`);
                    await this.processMessageContent(message, processedContent || content, userI18n, chat, savedMediaUrl, canonicalUserPhone);
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

    private async processMessageContent(message: Message, content: string, userI18n: UserI18n, chat: any, incomingMediaUrl?: string, phoneKey?: string) {
        const phoneNumber = normalizeConversationPhone(phoneKey || message.from.split('@')[0]) || String(phoneKey || message.from.split('@')[0] || "").trim();
        const normalizedPhoneNumber = normalizeConversationPhone(phoneNumber) || phoneNumber;

        // Handle location messages
        if ((message as any).type === 'location') {
            const loc = (message as any).location;
            if (loc?.latitude != null && loc?.longitude != null) {
                const lat = Number(loc.latitude);
                const lng = Number(loc.longitude);
                const fallbackAddress = String(loc?.description || loc?.address || "").trim();
                const resolvedAddress = await this.resolveLocationAddress(lat, lng);
                const addressText = fallbackAddress || resolvedAddress || "Adres tespit edilemedi";

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
                    aiState.locationCoords = { lat, lng };
                    if (aiState.incidentFlow?.active) {
                        aiState.incidentFlow.locationCoords = { lat, lng };
                        if ((!aiState.incidentFlow.data.address || aiState.incidentFlow.data.address === "Bilinmiyor") && addressText !== "Adres tespit edilemedi") {
                            aiState.incidentFlow.data.address = addressText;
                        }
                    }
                    this.aiConversationState.set(phoneNumber, aiState);
                }
                if (aiState?.incidentFlow?.active && aiState.incidentFlow.awaiting === 'location') {
                    aiState.incidentFlow.awaiting = 'meter';
                    this.aiConversationState.set(phoneNumber, aiState);
                    await this.safeReply(
                        message,
                        [
                            "Konumunuz iletildi. Tesekkur ederiz.",
                            `Adres: ${addressText}`,
                            `Koordinatlar: ${lat.toFixed(6)}, ${lng.toFixed(6)}`,
                            "Simdi tesisat no veya sayac no veya abone no bilginizi yazin."
                        ].join("\n")
                    );
                    return;
                }
                await this.safeReply(
                    message,
                    [
                        "Konum alindi.",
                        `Adres: ${addressText}`,
                        `Koordinatlar: ${lat.toFixed(6)}, ${lng.toFixed(6)}`,
                        "Tesekkurler."
                    ].join("\n")
                );
            }
            return;
        }

        const technicianFlowHandled = await this.handleTechnicianOperationalMessage(message, content);
        if (technicianFlowHandled) {
            return;
        }

        // Handle image messages - extract EXIF coords and save reference in incident flow
        if ((message as any).type === 'image') {
            const mediaUrl = incomingMediaUrl
                || this.pendingMediaUrls.get(phoneNumber)
                || this.pendingMediaUrls.get(normalizedPhoneNumber);
            this.pendingMediaUrls.delete(phoneNumber);
            this.pendingMediaUrls.delete(normalizedPhoneNumber);

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

        const normalizedContent = String(content || '').trim();
        const hasProcessableContent = normalizedContent.length > 0
            && !normalizedContent.startsWith('[Sesli mesaj');

        if (hasProcessableContent) {
            logger.debug(`[FLOW] handleTextMessage tetikleniyor. type=${message.type}, content="${normalizedContent}"`);
            await this.handleTextMessage(message, normalizedContent, userI18n, chat, phoneNumber);
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

    private async handleTextMessage(message: Message, content: string, userI18n: UserI18n, chat: any, phoneKey?: string) {
        const phoneNumber = normalizeConversationPhone(phoneKey || message.from.split('@')[0]) || String(phoneKey || message.from.split('@')[0] || "").trim();
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
                // Müşterinin geçmiş kaydı var mı? Varsa ismiyle hitap edelim
                const canonicalPhone = phoneNumber.replace(/@.*$/, '');
                // Önce ContactModel'dan bak (admin rehberinden kayıtlı isim)
                const contactRecord = await ContactModel.findOne({
                    phoneNumber: { $in: [phoneNumber, canonicalPhone] }
                }).lean() as any;
                const contactFullName: string | null = contactRecord
                    ? [contactRecord.name, contactRecord.lastName].filter(Boolean).join(' ') || contactRecord.pushName || null
                    : null;
                // Yoksa incident geçmişinden
                const pastIncident = contactFullName ? null : await IncidentModel.findOne({
                    $or: [
                        { sourcePhoneNumber: phoneNumber },
                        { sourcePhoneNumber: canonicalPhone }
                    ],
                    customerName: { $nin: ['Bilinmiyor', '', null] }
                }).sort({ createdAt: -1 }).lean() as any;
                const knownName: string | null = contactFullName || pastIncident?.customerName || null;
                const baseState = {
                    active: true as const,
                    history: existingState?.history || [],
                    infoProvided: false,
                    dispatchDone: false,
                    locationCoords: existingState?.locationCoords || null,
                    pendingPhotoUrls: Array.isArray(existingState?.pendingPhotoUrls) ? existingState.pendingPhotoUrls : [],
                    incidentFlow: {
                        active: false as const,
                        awaiting: "issue" as const,
                        photoUrls: Array.isArray(existingState?.pendingPhotoUrls) ? [ ...existingState.pendingPhotoUrls ] : [],
                        data: {
                            issueDescription: "Bilinmiyor",
                            customerName: knownName || "Bilinmiyor",
                            customerPhone: "Bilinmiyor",
                            address: "Bilinmiyor",
                            meterNo: "Bilinmiyor",
                            customerEmail: "Bilinmiyor"
                        }
                    },
                    statusFlow: {
                        active: false as const,
                        awaiting: "incidentId" as const,
                        data: {
                            customerName: "Bilinmiyor",
                            customerPhone: "Bilinmiyor",
                            incidentId: "Bilinmiyor"
                        },
                        recentMatches: [] as any[]
                    },
                    closureFlow: {
                        active: false as const,
                        awaiting: 'incidentId' as const,
                        candidates: [] as any[]
                    }
                };
                if (knownName) {
                    const firstName = knownName.trim().split(/\s+/)[0];
                    this.aiConversationState.set(phoneNumber, {
                        ...baseState,
                        menuStep: 'waiting' as const,
                        knownCustomerName: knownName
                    });
                    await this.safeReply(message, await this.buildPersonalizedMenuMessage(firstName));
                } else {
                    this.aiConversationState.set(phoneNumber, {
                        ...baseState,
                        greetingStep: 'askName' as const
                    });
                    await this.safeReply(message, [
                        'Merhaba! 👋 Ben WhatsYpzck Elektrik Arıza Asistanıyım 🔧⚡',
                        '',
                        'Sizi sistemimizde bulamadık. Size daha iyi hizmet verebilmek için adınızı ve soyadınızı öğrenebilir miyim?'
                    ].join('\n'));
                }
                this.startInactivityTimer(phoneNumber, message.from);
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
                        awaiting: "incidentId",
                        data: {
                            customerName: "Bilinmiyor",
                            customerPhone: "Bilinmiyor",
                            incidentId: "Bilinmiyor"
                        },
                        recentMatches: []
                    },
                    closureFlow: {
                        active: false,
                        awaiting: 'incidentId',
                        candidates: []
                    }
                };
                this.aiConversationState.set(phoneNumber, aiState);
            }
            if (aiState?.active) {
                if (chat) await chat.sendStateTyping();
                this.startInactivityTimer(phoneNumber, message.from);

                // Closure flow önce kontrol edilmeli — iptal/vazgeçtim gibi kelimeler
                // hem closure intent hem de end intent olarak match edebilir.
                // Closure flow kendi içinde isConversationEndIntent kontrolü yapar.
                try {
                    const closureFlowHandled = await this.processCustomerIncidentClosureFlow(message, phoneNumber, aiState, text);
                    this.aiConversationState.set(phoneNumber, aiState);
                    if (closureFlowHandled) {
                        return;
                    }
                } catch (closureFlowErr) {
                    logger.error('Musteri talep kapatma akisi hatasi:', closureFlowErr);
                }

                if (this.isConversationEndIntent(text)) {
                    this.clearInactivityTimer(phoneNumber);
                    aiState.menuStep = undefined;
                    aiState.faultCategoryStep = undefined;
                    aiState.incidentFlow = undefined;
                    aiState.statusFlow = undefined;
                    aiState.closureFlow = undefined;
                    aiState.pendingPhotoUrls = [];
                    this.aiConversationState.set(phoneNumber, aiState);
                    await this.safeReply(message, this.buildFarewellReply(text));
                    return;
                }

                // Teşekkür / sağol / iyi geceler gibi vedalar — sadece bilgi toplama dışında algıla
                const incidentDataCollecting = aiState.incidentFlow?.active &&
                    aiState.incidentFlow.awaiting !== 'confirm';
                if (!incidentDataCollecting && this.isThankfulFarewellIntent(text)) {
                    this.clearInactivityTimer(phoneNumber);
                    aiState.menuStep = undefined;
                    aiState.faultCategoryStep = undefined;
                    aiState.incidentFlow = undefined;
                    aiState.statusFlow = undefined;
                    aiState.closureFlow = undefined;
                    aiState.pendingPhotoUrls = [];
                    this.aiConversationState.set(phoneNumber, aiState);
                    await this.safeReply(message, this.buildFarewellReply(text));
                    return;
                }

                // Müşteri ismi sorusu cevabı bekleniyor
                if (aiState.greetingStep === 'askName') {
                    const name = text.trim();
                    if (name.length < 2 || /^\d+$/.test(name)) {
                        await this.safeReply(message, 'Lütfen adınızı ve soyadınızı yazınız. 😊');
                        return;
                    }
                    const parts = name.split(/\s+/);
                    const firstName = parts[0];
                    aiState.greetingStep = undefined;
                    aiState.knownCustomerName = name;
                    aiState.menuStep = 'waiting';
                    if (aiState.incidentFlow) {
                        aiState.incidentFlow.data.customerName = name;
                    }
                    this.aiConversationState.set(phoneNumber, aiState);
                    // ContactModel'a adı kaydet (admin sonradan düzenleyebilir)
                    ContactModel.findOneAndUpdate(
                        { phoneNumber },
                        { $set: { name: firstName, ...(parts.length > 1 ? { lastName: parts.slice(1).join(' ') } : {}) } },
                        { upsert: true }
                    ).catch(() => {});
                    await this.safeReply(message, await this.buildPersonalizedMenuMessage(firstName));
                    return;
                }

                // Handle main menu selection step
                if (aiState.menuStep === 'waiting') {
                    const choice = this.resolveMainMenuChoice(text) || text.trim();

                    // Müşteri doğrudan arıza/kesinti niyetiyle yazdıysa menüyü atla, akışa gir
                    if (this.parseIncidentIntent(text) || this.isOutageComplaint(text)) {
                        aiState.menuStep = undefined;
                        aiState.faultCategoryStep = undefined;
                        const pendingLocation = aiState.locationCoords || null;
                        const pendingPhotoUrls = Array.isArray(aiState.pendingPhotoUrls) ? [...aiState.pendingPhotoUrls] : [];
                        const knownNameForFlow = aiState.knownCustomerName || 'Bilinmiyor';
                        aiState.incidentFlow = {
                            active: true,
                            awaiting: 'issue',
                            correctingSingleField: false,
                            locationCoords: pendingLocation,
                            photoUrls: pendingPhotoUrls,
                            data: {
                                issueDescription: 'Bilinmiyor',
                                customerName: knownNameForFlow,
                                customerPhone: 'Bilinmiyor',
                                address: 'Bilinmiyor',
                                meterNo: 'Bilinmiyor',
                                customerEmail: 'Bilinmiyor'
                            }
                        };
                        aiState.pendingPhotoUrls = [];
                        this.aiConversationState.set(phoneNumber, aiState);
                        const firstName = aiState.knownCustomerName ? aiState.knownCustomerName.trim().split(/\s+/)[0] : null;
                        await this.safeReply(message, [
                            firstName
                                ? `Size hızlı bir şekilde yardımcı olacağım, *${firstName}*! ⚡`
                                : 'Size hızlı bir şekilde yardımcı olacağım! ⚡',
                            '',
                            'Yaşadığınız sorunu kısaca tarif edebilir misiniz?'
                        ].join('\n'));
                        return;
                    }

                    if (choice === '1') {
                        aiState.menuStep = undefined;
                        aiState.faultCategoryStep = 'waiting';
                        this.aiConversationState.set(phoneNumber, aiState);
                        await this.safeReply(message, await this.buildFaultCategoryMessage());
                        return;
                    } else if (choice === '2') {
                        aiState.menuStep = undefined;
                        aiState.statusFlow = {
                            active: true,
                            awaiting: 'incidentId',
                            data: { customerName: 'Bilinmiyor', customerPhone: 'Bilinmiyor', incidentId: 'Bilinmiyor' },
                            recentMatches: []
                        };
                        this.aiConversationState.set(phoneNumber, aiState);
                        await this.safeReply(message, await this.buildIncidentStatusStartMessage());
                        return;
                    } else if (this.parseSmallTalkIntent(text)) {
                        // Menü beklerken nasılsın / naber gibi sohbet sorusu
                        const stReply = this.buildSmallTalkReply(text);
                        await this.safeReply(message, stReply);
                        return;
                    } else if (this.parseIdentityIntent(text)) {
                        // Menü beklerken kimsin sorusu
                        await this.safeReply(message, this.buildIdentityReply());
                        return;
                    } else if (this.parseDateTimeIntent(text)) {
                        // Menü beklerken saat/tarih sorusu
                        await this.safeReply(message, this.buildCurrentDateTimeReply());
                        return;
                    } else if (this.parseInfoRequestIntent(text)) {
                        // Bilgi almak / temsilci isteği → 186 yönlendirme
                        await this.safeReply(message, await this.buildInfoRedirectReply());
                        return;
                    } else {
                        // Tanımsız / anlamsız / kapsam dışı her şey
                        const ollamaShortReply = await this.tryBuildOllamaOutsideFlowShortReply(text);
                        if (ollamaShortReply) {
                            await this.safeReply(message, ollamaShortReply);
                            return;
                        }
                        await this.safeReply(message, await this.buildUnknownQuestionReply());
                        return;
                    }
                }

                // Handle fault category selection step
                if (aiState.faultCategoryStep === 'waiting') {
                    const choice = this.resolveFaultCategoryChoice(text) || text.trim();
                    if (choice === '1') {
                        aiState.faultCategoryStep = undefined;
                        const pendingLocation = aiState.locationCoords || null;
                        const pendingPhotoUrls = Array.isArray(aiState.pendingPhotoUrls) ? [...aiState.pendingPhotoUrls] : [];
                        aiState.incidentFlow = {
                            active: true,
                            awaiting: 'issue',
                            correctingSingleField: false,
                            locationCoords: pendingLocation,
                            photoUrls: pendingPhotoUrls,
                            data: {
                                issueDescription: 'Bilinmiyor',
                                customerName: aiState.knownCustomerName || 'Bilinmiyor',
                                customerPhone: 'Bilinmiyor',
                                address: 'Bilinmiyor',
                                meterNo: 'Bilinmiyor',
                                customerEmail: 'Bilinmiyor'
                            }
                        };
                        aiState.pendingPhotoUrls = [];
                        this.aiConversationState.set(phoneNumber, aiState);
                        await this.safeReply(message, 'Yaşadığınız sorunu kısaca tarif edebilir misiniz?');
                        return;
                    } else if (choice === '2') {
                        aiState.faultCategoryStep = undefined;
                        const pendingLocation = aiState.locationCoords || null;
                        const pendingPhotoUrls = Array.isArray(aiState.pendingPhotoUrls) ? [...aiState.pendingPhotoUrls] : [];
                        aiState.incidentFlow = {
                            active: true,
                            awaiting: 'issue',
                            correctingSingleField: false,
                            requestCategory: 'billing',
                            locationCoords: pendingLocation,
                            photoUrls: pendingPhotoUrls,
                            data: {
                                issueDescription: 'Bilinmiyor',
                                customerName: aiState.knownCustomerName || 'Bilinmiyor',
                                customerPhone: 'Bilinmiyor',
                                address: 'Bilinmiyor',
                                meterNo: 'Bilinmiyor',
                                customerEmail: 'Bilinmiyor'
                            }
                        };
                        aiState.pendingPhotoUrls = [];
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
                            await this.buildMainMenuMessage()
                        ].join('\n'));
                        return;
                    } else if (this.parseSmallTalkIntent(text)) {
                        await this.safeReply(message, this.buildSmallTalkReply(text));
                        return;
                    } else if (this.parseIdentityIntent(text)) {
                        await this.safeReply(message, this.buildIdentityReply());
                        return;
                    } else if (this.parseInfoRequestIntent(text)) {
                        // Bilgi almak / temsilci isteği → 186 yönlendirme
                        await this.safeReply(message, await this.buildInfoRedirectReply());
                        return;
                    } else {
                        // Tanımsız / anlamsız / kapsam dışı her şey
                        const ollamaShortReply = await this.tryBuildOllamaOutsideFlowShortReply(text);
                        if (ollamaShortReply) {
                            await this.safeReply(message, ollamaShortReply);
                            return;
                        }
                        await this.safeReply(message, await this.buildUnknownQuestionReply());
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

                if (this.parseSmallTalkIntent(text)) {
                    const smallTalkReply = this.buildSmallTalkReply(text);
                    await this.safeReply(message, smallTalkReply);
                    aiState.history.push(`Kullanici: ${text.slice(0, 180)}`);
                    aiState.history.push(`Temsilci: ${smallTalkReply.slice(0, 220)}`);
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
                    const pendingPhotoUrls = Array.isArray(aiState.pendingPhotoUrls) ? [...aiState.pendingPhotoUrls] : [];
                    aiState.incidentFlow = {
                        active: true,
                        awaiting: "issue",
                        photoUrls: pendingPhotoUrls,
                        data: {
                            issueDescription: String(text || "").trim() || "Bilinmiyor",
                            customerName: "Bilinmiyor",
                            customerPhone: "Bilinmiyor",
                            address: "Bilinmiyor",
                            meterNo: "Bilinmiyor",
                            customerEmail: "Bilinmiyor"
                        }
                    };
                    aiState.pendingPhotoUrls = [];
                    this.aiConversationState.set(phoneNumber, aiState);
                    await this.safeReply(message, stableReply);
                    return;
                }

                // Tanımlanamayan soru → kibarca bilgilendirme
                if (this.isUnknownQuestion(text)) {
                    const ollamaShortReply = await this.tryBuildOllamaOutsideFlowShortReply(text);
                    const unknownReply = ollamaShortReply || await this.buildUnknownQuestionReply();
                    await this.safeReply(message, unknownReply);
                    aiState.history.push(`Kullanici: ${text.slice(0, 180)}`);
                    aiState.history.push(`Temsilci: ${unknownReply.slice(0, 220)}`);
                    if (aiState.history.length > 8) {
                        aiState.history = aiState.history.slice(-8);
                    }
                    this.aiConversationState.set(phoneNumber, aiState);
                    return;
                }

                aiState.menuStep = 'waiting';
                this.aiConversationState.set(phoneNumber, aiState);
                await this.safeReply(message, await this.buildMainMenuMessage());
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

