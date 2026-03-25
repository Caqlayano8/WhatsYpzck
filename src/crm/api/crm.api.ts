import express from 'express';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { BotManager } from '../../bot.manager';
import logger from '../../configs/logger.config';
import { authenticate, authorizeAdmin, authorizePermission } from '../middlewares/auth.middleware';
import { CampaignModel } from '../models/campaign.model';
import { ContactModel } from '../models/contact.model';
import { AuthService, normalizeUserRole } from '../utils/auth.util';
import { TemplateModel } from '../models/template.model';
import { SettingsModel } from '../models/settings.model';
import { PhoneDetectionUtil } from '../../utils/location/phone-detection.util';
import { AuditLogModel } from '../models/audit-log.model';
import { UserModel } from '../models/user.model';
import { LogBuffer, LogEntry } from '../../utils/system/log-buffer.util';
import { sendCampaignMessages } from '../../crons/campaign.cron';
import commands from '../../commands';
import { MessageModel } from '../models/message.model';
import { ScoreRuleModel } from '../models/score-rule.model';
import { TemplateRevisionModel } from '../models/template-revision.model';
import { ScheduledMessageModel } from '../models/scheduled-message.model';
import { ContactGroupModel } from '../models/contact-group.model';
import { messageEmitter } from '../../utils/events/message-emitter.util';
import { IntegrationModel, INTEGRATION_EVENTS } from '../models/integration.model';
import { AutoReplyModel } from '../models/auto-reply.model';
import { IncidentModel } from '../models/incident.model';
import { fireEvent } from '../../utils/events/fire-event.util';
import { encryptValue, decryptValue } from '../../utils/system/crypto.util';
import { WidgetSettingsModel } from '../models/widget-settings.model';
import { FlowModel } from '../models/flow.model';
import { FlowSessionModel } from '../models/flow-session.model';
import { geminiCompletion } from '../../utils/ai/gemini.util';
import { claudeCompletion } from '../../utils/ai/claude.util';
import { chatGptCompletion } from '../../utils/ai/chat-gpt.util';
import { formatTrDateTime } from '../../utils/system/datetime.util';
import { isLidConversationPhone, normalizeConversationPhone } from '../../utils/whatsapp/conversation-phone.util';
import crypto from 'crypto';
import ExcelJS from 'exceljs';

export const router = express.Router();

function parseCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        const next = line[i + 1];
        if (ch === '"') {
            if (inQuotes && next === '"') {
                cur += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (ch === ',' && !inQuotes) {
            out.push(cur);
            cur = '';
            continue;
        }
        cur += ch;
    }
    out.push(cur);
    return out.map((v) => String(v || '').trim());
}

function toWhatsAppChatId(raw: string): string | null {
    const value = String(raw || '').trim();
    if (!value) return null;
    if (/@c\.us$|@g\.us$/i.test(value)) return value;

    let digits = value.replace(/\D/g, '');
    if (!digits) return null;

    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith('0')) {
        digits = `90${digits.slice(1)}`;
    } else if (digits.length === 10 && digits.startsWith('5')) {
        digits = `90${digits}`;
    }
    return `${digits}@c.us`;
}

const conversationPhoneCache = new Map<string, string>();

async function resolveConversationPhone(raw: string, botManager: BotManager): Promise<string> {
    const value = String(raw || '').trim();
    if (!value) return '';

    const cached = conversationPhoneCache.get(value);
    if (cached) return cached;

    let resolved = normalizeConversationPhone(value);

    if (isLidConversationPhone(value) && typeof (botManager.client as any)?.getContactLidAndPhone === 'function') {
        try {
            const match = await (botManager.client as any).getContactLidAndPhone([value]);
            const mappedPhone = match?.[0]?.pn;
            if (mappedPhone) {
                resolved = normalizeConversationPhone(String(mappedPhone));
            }
        } catch (_) {
            // fall back to normalized raw lid id
        }
    }

    conversationPhoneCache.set(value, resolved);
    if (resolved) {
        conversationPhoneCache.set(resolved, resolved);
    }
    return resolved;
}

async function buildConversationResolutionMap(rawPhones: string[], botManager: BotManager): Promise<Map<string, string>> {
    const entries = await Promise.all(
        Array.from(new Set((rawPhones || []).map((phone) => String(phone || '').trim()).filter(Boolean))).map(async (phone) => {
            const canonical = await resolveConversationPhone(phone, botManager);
            return [phone, canonical || normalizeConversationPhone(phone)] as const;
        })
    );

    return new Map(entries);
}

function pickConversationContact(contacts: any[], canonicalPhone: string): any | null {
    const match = (contacts || []).find((contact) => normalizeConversationPhone(contact.phoneNumber) === canonicalPhone);
    return match || null;
}

function getBotOwnConversationPhone(botManager: BotManager): string {
    return normalizeConversationPhone(String((botManager.client as any)?.info?.wid?._serialized || (botManager.client as any)?.info?.wid?.user || ''));
}

function incidentStatusLabel(status: string): string {
    const map: Record<string, string> = {
        ALINDI: 'Kayit alindi',
        INCELEMEDE: 'Incelemede',
        ISLEME_ALINDI: 'Isleme alindi',
        COZUMLENDI: 'Cozumlendi',
        KAPATILDI: 'Kapatildi'
    };
    return map[String(status || '').toUpperCase()] || 'Bilinmiyor';
}

function slugifyGroupName(value: string): string {
    return String(value || '')
        .toLocaleLowerCase('tr-TR')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function parseGroupList(value: any): string[] {
    if (Array.isArray(value)) {
        return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)));
    }

    return Array.from(new Set(
        String(value || '')
            .split(/[\n,;]/)
            .map((item) => String(item || '').trim())
            .filter(Boolean)
    ));
}

async function persistOutboundAdminMessage(phoneNumber: string, message: string, sentMessage: any) {
    const canonicalPhone = normalizeConversationPhone(phoneNumber);
    const msgDoc = await MessageModel.create({
        phoneNumber: canonicalPhone,
        body: message,
        type: 'text',
        direction: 'out',
        whatsappMessageId: sentMessage?.id?._serialized,
        sentVia: 'admin',
        read: true,
        timestamp: new Date()
    });
    messageEmitter.emit('message', msgDoc.toObject());
    return msgDoc;
}

function isValidEmail(value: string): boolean {
    const email = String(value || '').trim().toLowerCase();
    if (!email || email.length > 254) return false;
    return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email);
}

function renderTemplate(template: string, variables: Record<string, string>): string {
    return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => variables[key] || '');
}

function readIncidentCsvRecords() {
    const dir = path.join(process.cwd(), 'public', 'reports', 'incidents');
    if (!fs.existsSync(dir)) {
        return [];
    }

    const files = fs.readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.csv'))
        .map((name) => path.join(dir, name));

    return files.map((filePath) => {
        const stat = fs.statSync(filePath);
        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.split(/\r?\n/).filter(Boolean);
        if (lines.length < 2) {
            return null;
        }
        const header = parseCsvLine(lines[0]);
        const row = parseCsvLine(lines[1]);
        const rec: Record<string, string> = {};
        header.forEach((k, idx) => {
            rec[k] = row[idx] || '';
        });
        return {
            id: rec.KayitNo || path.basename(filePath, '.csv'),
            createdAt: rec.Tarih || stat.mtime.toISOString(),
            customerName: rec.MusteriIsmi || 'Bilinmiyor',
            phone: rec.Telefon || 'Bilinmiyor',
            address: rec.Adres || 'Bilinmiyor',
            meterNo: rec.TesisatSayacNo || 'Bilinmiyor',
            issue: rec.Talep || 'Bilinmiyor',
            sourceNumber: rec.KaynakNumara || 'Bilinmiyor',
            fileName: path.basename(filePath),
            filePath
        };
    }).filter(Boolean).sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

// Audit Log Helper
async function addAuditLog(
    userId: string, username: string,
    action: string, resource: string,
    resourceId?: string, details?: any
) {
    try {
        await AuditLogModel.create({ userId, username, action, resource, resourceId, details });
    } catch (err) {
        logger.error('Failed to write audit log:', err);
    }
}

// CSV Helpers
function parseCSV(csv: string): Array<{ phoneNumber: string; name?: string }> {
    const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    let startIdx = 0;
    const firstLine = lines[0].toLowerCase();
    if (firstLine.includes('phone') || firstLine.includes('name')) startIdx = 1;
    return lines.slice(startIdx).map(line => {
        const parts = line.split(',').map(p => p.trim().replace(/^["']|["']$/g, ''));
        const phoneNumber = parts[0]?.replace(/\s/g, '');
        const name = parts[1] || undefined;
        return phoneNumber ? { phoneNumber, name } : null;
    }).filter(Boolean) as Array<{ phoneNumber: string; name?: string }>;
}

function contactsToCSV(contacts: any[]): string {
    const header = 'phoneNumber,name,pushName,language,country,region,lastInteraction,tags,blocked,archived';
    const rows = contacts.map(c => [
        c.phoneNumber, c.name || '', c.pushName || '',
        c.detectedLanguage || '', c.detectedCountry || '', c.detectedRegion || '',
        c.lastInteraction ? new Date(c.lastInteraction).toISOString() : '',
        (c.tags || []).join(';'),
        c.blocked ? '1' : '0', c.archived ? '1' : '0'
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    return '\uFEFF' + [header, ...rows].join('\n');
}

export default function (botManager: BotManager) {

    // Contacts
    router.get('/contacts', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const { page = 1, limit = 20, search = '', sort = '-lastInteraction', language = '' } = req.query;
            const skip = (Number(page) - 1) * Number(limit);

            const query: any = {};
            if (req.query.showBlocked !== 'true') query.blocked = { $ne: true };
            if (req.query.showArchived === 'true') query.archived = true;
            else query.archived = { $ne: true };

            if (search) {
                query.$or = [
                    { phoneNumber: { $regex: search, $options: 'i' } },
                    { name: { $regex: search, $options: 'i' } },
                    { pushName: { $regex: search, $options: 'i' } }
                ];
            }
            if (language === 'en' || language === 'fr' || language === 'other') {
                query.detectedLanguage = language;
            }

            const contacts = await ContactModel.find(query)
                .sort(sort as string).skip(skip).limit(Number(limit));

            for (const contact of contacts) {
                if (!contact.detectedLanguage && contact.phoneNumber) {
                    try {
                        const detection = PhoneDetectionUtil.detectLanguageFromPhone(contact.phoneNumber);
                        contact.detectedLanguage = detection.primaryLanguage;
                        contact.detectedCountry = detection.countryCode;
                        contact.detectedRegion = detection.region;
                        await contact.save();
                    } catch { /* non-critical, skip */ }
                }
            }

            const total = await ContactModel.countDocuments(query);
            const stats = {
                total: await ContactModel.countDocuments({ blocked: { $ne: true }, archived: { $ne: true } }),
                english: await ContactModel.countDocuments({ detectedLanguage: 'en', blocked: { $ne: true } }),
                french: await ContactModel.countDocuments({ detectedLanguage: 'fr', blocked: { $ne: true } }),
                other: await ContactModel.countDocuments({ detectedLanguage: 'other', blocked: { $ne: true } }),
                blocked: await ContactModel.countDocuments({ blocked: true }),
                archived: await ContactModel.countDocuments({ archived: true }),
            };

            res.json({
                data: contacts,
                meta: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
                stats
            });
        } catch (error) {
            logger.error('Failed to fetch contacts:', error);
            res.status(500).json({ error: 'Failed to fetch contacts' });
        }
    });

    router.post('/contacts/import', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const { csv } = req.body;
            if (!csv) return res.status(400).json({ error: 'csv field required' });
            const records = parseCSV(csv);
            if (!records.length) return res.status(400).json({ error: 'No valid records found' });

            const ops = records.map(r => ({
                updateOne: {
                    filter: { phoneNumber: r.phoneNumber },
                    update: { $set: { phoneNumber: r.phoneNumber, ...(r.name ? { name: r.name } : {}) } },
                    upsert: true
                }
            }));
            const result = await ContactModel.bulkWrite(ops);
            await addAuditLog(req.user.userId, req.user.username || '', 'contacts.import', 'contact', undefined, { count: records.length });
            res.json({ imported: records.length, upserted: result.upsertedCount, modified: result.modifiedCount });
        } catch (error) {
            logger.error('Failed to import contacts:', error);
            res.status(500).json({ error: 'Failed to import contacts' });
        }
    });

    router.get('/contacts/export', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const contacts = await ContactModel.find({ blocked: { $ne: true } }).sort('-lastInteraction');

            const workbook = new ExcelJS.Workbook();
            workbook.creator = 'WhatsYpzck CRM';
            const sheet = workbook.addWorksheet('Kişiler');
            sheet.columns = [
                { header: 'Telefon',        key: 'phoneNumber',     width: 20 },
                { header: 'Ad',             key: 'name',            width: 25 },
                { header: 'WhatsApp Adı',   key: 'pushName',        width: 25 },
                { header: 'Dil',            key: 'language',        width: 12 },
                { header: 'Ülke',           key: 'country',         width: 12 },
                { header: 'Bölge',          key: 'region',          width: 20 },
                { header: 'Son Etkileşim',  key: 'lastInteraction', width: 22 },
                { header: 'Etiketler',      key: 'tags',            width: 30 },
                { header: 'Engelli',        key: 'blocked',         width: 10 },
                { header: 'Arşivlendi',     key: 'archived',        width: 12 },
            ];
            const headerRow = sheet.getRow(1);
            headerRow.eachCell(cell => {
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
                cell.alignment = { vertical: 'middle', horizontal: 'center' };
            });
            headerRow.height = 20;

            contacts.forEach((c: any) => {
                sheet.addRow({
                    phoneNumber:     c.phoneNumber || '',
                    name:            c.name || '',
                    pushName:        c.pushName || '',
                    language:        c.detectedLanguage || '',
                    country:         c.detectedCountry || '',
                    region:          c.detectedRegion || '',
                    lastInteraction: c.lastInteraction ? new Date(c.lastInteraction).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }) : '',
                    tags:            (c.tags || []).join('; '),
                    blocked:         c.blocked ? 'Evet' : 'Hayır',
                    archived:        c.archived ? 'Evet' : 'Hayır',
                });
            });

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('kisiler.xlsx')}`);
            await workbook.xlsx.write(res);
            res.end();
        } catch (error) {
            logger.error('Failed to export contacts:', error);
            res.status(500).json({ error: 'Failed to export contacts' });
        }
    });

    router.patch('/contacts/:id/tags', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const { tags } = req.body;
            const contact = await ContactModel.findByIdAndUpdate(req.params.id, { tags }, { new: true });
            if (!contact) return res.status(404).json({ error: 'Contact not found' });
            await addAuditLog(req.user.userId, req.user.username || '', 'contacts.tag', 'contact', req.params.id, { tags });
            res.json(contact);
        } catch (error) {
            logger.error('Failed to update tags:', error);
            res.status(500).json({ error: 'Failed to update tags' });
        }
    });

    router.patch('/contacts/:id/block', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const contact = await ContactModel.findById(req.params.id);
            if (!contact) return res.status(404).json({ error: 'Contact not found' });
            contact.blocked = !contact.blocked;
            await contact.save();
            await addAuditLog(req.user.userId, req.user.username || '', contact.blocked ? 'contacts.block' : 'contacts.unblock', 'contact', req.params.id);
            res.json(contact);
        } catch (error) {
            logger.error('Failed to toggle block:', error);
            res.status(500).json({ error: 'Failed to toggle block' });
        }
    });

    router.patch('/contacts/:id/archive', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const contact = await ContactModel.findById(req.params.id);
            if (!contact) return res.status(404).json({ error: 'Contact not found' });
            contact.archived = !contact.archived;
            await contact.save();
            await addAuditLog(req.user.userId, req.user.username || '', contact.archived ? 'contacts.archive' : 'contacts.unarchive', 'contact', req.params.id);
            res.json(contact);
        } catch (error) {
            logger.error('Failed to toggle archive:', error);
            res.status(500).json({ error: 'Failed to toggle archive' });
        }
    });

    // Campaigns
    router.post('/campaigns', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const {
                name, message, scheduledAt, contacts,
                recurringType, recurringDay,
                notes, throttleRate, expiresAt,
                excludeTags, abVariantB, messages, mediaUrl
            } = req.body;
            const campaign = new CampaignModel({
                name, message,
                scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
                contacts,
                createdBy: req.user.userId,
                recurringType: recurringType || 'none',
                recurringDay: recurringDay || null,
                status: scheduledAt ? 'scheduled' : 'draft',
                notes: notes || '',
                throttleRate: throttleRate || 60,
                expiresAt: expiresAt ? new Date(expiresAt) : undefined,
                excludeTags: excludeTags || [],
                abVariantB: abVariantB || '',
                messages: messages || [],
                mediaUrl: mediaUrl || ''
            });
            await campaign.save();
            await addAuditLog(req.user.userId, req.user.username || '', 'campaign.create', 'campaign', String(campaign._id), { name });
            if (!scheduledAt) await sendCampaignMessages(botManager, campaign);
            res.status(201).json(campaign);
        } catch (error) {
            logger.error('Failed to create campaign:', error);
            res.status(500).json({ error: 'Failed to create campaign' });
        }
    });

    router.get('/campaigns', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const campaigns = await CampaignModel.find().sort({ createdAt: -1 }).populate('createdBy', 'username');
            res.json(campaigns);
        } catch (error) {
            logger.error('Failed to fetch campaigns:', error);
            res.status(500).json({ error: 'Failed to fetch campaigns' });
        }
    });

    router.delete('/campaigns/:id', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const campaign = await CampaignModel.findByIdAndDelete(req.params.id);
            if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
            await addAuditLog(req.user.userId, req.user.username || '', 'campaign.delete', 'campaign', req.params.id);
            res.json({ success: true });
        } catch (error) {
            logger.error('Failed to delete campaign:', error);
            res.status(500).json({ error: 'Failed to delete campaign' });
        }
    });

    router.get('/campaigns/:id/delivery-report', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const campaign = await CampaignModel.findById(req.params.id).select('name deliveryReport sentCount failedCount');
            if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
            res.json(campaign);
        } catch (error) {
            logger.error('Failed to fetch delivery report:', error);
            res.status(500).json({ error: 'Failed to fetch delivery report' });
        }
    });

    router.post('/campaigns/:id/retry', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const campaign = await CampaignModel.findById(req.params.id);
            if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
            const failedPhones = campaign.deliveryReport.filter(r => r.status === 'failed').map(r => r.phone);
            if (!failedPhones.length) return res.json({ message: 'No failed contacts to retry' });

            const tempCampaign = { ...campaign.toObject(), contacts: failedPhones, deliveryReport: [] };
            await sendCampaignMessages(botManager, tempCampaign);

            campaign.deliveryReport.push(...tempCampaign.deliveryReport);
            campaign.sentCount = (campaign.sentCount || 0) + (tempCampaign.sentCount || 0);
            campaign.failedCount = tempCampaign.failedCount || 0;
            if (campaign.failedCount === 0) campaign.status = 'sent';
            await campaign.save();

            await addAuditLog(req.user.userId, req.user.username || '', 'campaign.retry', 'campaign', req.params.id);
            res.json(campaign);
        } catch (error) {
            logger.error('Failed to retry campaign:', error);
            res.status(500).json({ error: 'Failed to retry campaign' });
        }
    });

    // Templates
    router.get('/templates', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const templates = await TemplateModel.find().sort({ createdAt: -1 });
            res.json(templates);
        } catch (error) {
            logger.error('Failed to fetch templates:', error);
            res.status(500).json({ error: 'Failed to fetch templates' });
        }
    });

    router.post('/templates', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const { name, content, category } = req.body;
            const template = new TemplateModel({ name, content, category: category || 'general', createdBy: req.user.userId });
            await template.save();
            await addAuditLog(req.user.userId, req.user.username || '', 'template.create', 'template', String(template._id), { name });
            res.status(201).json(template);
        } catch (error) {
            logger.error('Failed to create template:', error);
            res.status(500).json({ error: 'Failed to create template' });
        }
    });

    router.put('/templates/:id', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const { name, content, category } = req.body;
            const existing = await TemplateModel.findById(req.params.id);
            if (!existing) return res.status(404).json({ error: 'Template not found' });

            // Save revision snapshot before overwriting
            const currentRev = (existing as any).revision || 0;
            await TemplateRevisionModel.create({
                templateId: existing._id,
                revision: currentRev,
                name: (existing as any).name,
                content: (existing as any).content,
                category: (existing as any).category || 'general',
                savedBy: req.user.username || 'admin',
                savedAt: new Date()
            });

            const template = await TemplateModel.findByIdAndUpdate(
                req.params.id,
                { name, content, category, revision: currentRev + 1 },
                { new: true }
            );
            await addAuditLog(req.user.userId, req.user.username || '', 'template.update', 'template', req.params.id, { name });
            res.json(template);
        } catch (error) {
            logger.error('Failed to update template:', error);
            res.status(500).json({ error: 'Failed to update template' });
        }
    });

    router.delete('/templates/:id', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const template = await TemplateModel.findByIdAndDelete(req.params.id);
            if (!template) return res.status(404).json({ error: 'Template not found' });
            await addAuditLog(req.user.userId, req.user.username || '', 'template.delete', 'template', req.params.id);
            res.json({ success: true });
        } catch (error) {
            logger.error('Failed to delete template:', error);
            res.status(500).json({ error: 'Failed to delete template' });
        }
    });

    // Auth
    router.post('/auth/register', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const { username, password, role, displayName, phone } = req.body;
            const user = await AuthService.register(username, password, normalizeUserRole(role), displayName, phone);
            res.status(201).json(user);
        } catch (error) {
            logger.error('Registration failed:', error);
            res.status(400).json({ error: error.message });
        }
    });

    const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 dakika
        max: 10, // 15 dakikada en fazla 10 deneme
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Çok fazla giriş denemesi. Lütfen 15 dakika sonra tekrar deneyin.' },
    });
    router.post('/auth/login', loginLimiter, async (req, res) => {
        try {
            const { username, password } = req.body;
            const { token, user } = await AuthService.login(username, password);
            res.json({ token, user });
        } catch (error) {
            logger.error('Login failed:', error);
            res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
        }
    });

    router.get('/auth/check', authenticate, (req, res) => {
        res.json({ user: req.user });
    });

    // Settings
    router.get('/settings', authenticate, authorizeAdmin, async (req, res) => {
        try {
            let settings = await SettingsModel.findOne();
            if (!settings) settings = await SettingsModel.create({});

            const apiKeysMap: Map<string, string> = settings.get('apiKeys') || new Map();
            const maskedKeys: Record<string, string> = {};
            const displayKeys: Record<string, string> = {};
            const sensitiveKeys = new Set([
                'GEMINI_API_KEY',
                'CHAT_GPT_PROJECT_ID',
                'CHAT_GPT_ORG_ID',
                'CHAT_GPT_API_KEY',
                'ANTHROPIC_API_KEY',
                'OPENWEATHERMAP_API_KEY',
            ]);
            const sherpaPathKeys = new Set([
                'SHERPA_ONNX_ASR_ENCODER_PATH',
                'SHERPA_ONNX_ASR_DECODER_PATH',
                'SHERPA_ONNX_ASR_TOKENS_PATH',
                'SHERPA_ONNX_TTS_MODEL_PATH',
                'SHERPA_ONNX_TTS_TOKENS_PATH',
                'SHERPA_ONNX_TTS_LEXICON_PATH',
                'SHERPA_ONNX_TTS_DATA_DIR',
            ]);
            const toRelPath = (absPath: string) => path.isAbsolute(absPath) ? (path.relative(process.cwd(), absPath) || absPath) : absPath;
            apiKeysMap.forEach((rawVal, key) => {
                const val    = decryptValue(String(rawVal || ''));
                const masked = val.length > 8 ? val.slice(0, 4) + '…' + val.slice(-4) : val ? '****' : '';
                maskedKeys[key]    = masked;
                displayKeys[key]   = sensitiveKeys.has(key) ? masked : (sherpaPathKeys.has(key) ? toRelPath(val) : val);
            });

            sherpaPathKeys.forEach((key) => {
                if (!displayKeys[key] && process.env[key]) {
                    displayKeys[key] = toRelPath(String(process.env[key]));
                }
            });

            const hasRuntimeKey = (key: string) => !!(process.env[key] || apiKeysMap.get(key));

            res.json({
                ...settings.toObject(),
                apiKeysMasked: maskedKeys,
                apiKeysDisplay: displayKeys,
                env: {
                    GEMINI_API_KEY: hasRuntimeKey('GEMINI_API_KEY'),
                    OPENWEATHERMAP_API_KEY: hasRuntimeKey('OPENWEATHERMAP_API_KEY'),
                    SHERPA_ONNX_ASR_ENCODER_PATH: hasRuntimeKey('SHERPA_ONNX_ASR_ENCODER_PATH'),
                    SHERPA_ONNX_ASR_DECODER_PATH: hasRuntimeKey('SHERPA_ONNX_ASR_DECODER_PATH'),
                    SHERPA_ONNX_ASR_TOKENS_PATH: hasRuntimeKey('SHERPA_ONNX_ASR_TOKENS_PATH'),
                    SHERPA_ONNX_TTS_MODEL_PATH: hasRuntimeKey('SHERPA_ONNX_TTS_MODEL_PATH'),
                    SHERPA_ONNX_TTS_TOKENS_PATH: hasRuntimeKey('SHERPA_ONNX_TTS_TOKENS_PATH'),
                    SHERPA_ONNX_TTS_LEXICON_PATH: hasRuntimeKey('SHERPA_ONNX_TTS_LEXICON_PATH'),
                    CHAT_GPT_API_KEY: hasRuntimeKey('CHAT_GPT_API_KEY'),
                    ANTHROPIC_API_KEY: hasRuntimeKey('ANTHROPIC_API_KEY'),
                    ENV: process.env.ENV || 'unknown',
                    PORT: process.env.PORT || '3000',
                }
            });
        } catch (error) {
            logger.error('Failed to fetch settings:', error);
            res.status(500).json({ error: 'Failed to fetch settings' });
        }
    });

    router.put('/settings', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const { maxFileSizeMb, autoDownloadEnabled, defaultAudioAiCommand, apiKeys, incidentRouting, notificationTemplates } = req.body;
            const update: any = {};
            if (maxFileSizeMb !== undefined) {
                const mb = Number(maxFileSizeMb);
                if (isNaN(mb) || mb < 1 || mb > 500) {
                    return res.status(400).json({ error: 'maxFileSizeMb must be between 1 and 500' });
                }
                update.maxFileSizeMb = mb;
            }
            if (autoDownloadEnabled !== undefined) update.autoDownloadEnabled = autoDownloadEnabled;
            if (defaultAudioAiCommand !== undefined) update.defaultAudioAiCommand = defaultAudioAiCommand;
            const sherpaPathKeysSet = new Set([
                'SHERPA_ONNX_ASR_ENCODER_PATH', 'SHERPA_ONNX_ASR_DECODER_PATH', 'SHERPA_ONNX_ASR_TOKENS_PATH',
                'SHERPA_ONNX_TTS_MODEL_PATH', 'SHERPA_ONNX_TTS_TOKENS_PATH', 'SHERPA_ONNX_TTS_LEXICON_PATH', 'SHERPA_ONNX_TTS_DATA_DIR',
            ]);
            if (apiKeys && typeof apiKeys === 'object') {
                for (const [key, value] of Object.entries(apiKeys)) {
                    if (value) {
                        let finalValue = String(value);
                        if (sherpaPathKeysSet.has(key) && !path.isAbsolute(finalValue)) {
                            finalValue = path.resolve(process.cwd(), finalValue);
                        }
                        update[`apiKeys.${key}`] = encryptValue(finalValue);
                        process.env[key] = finalValue; // plaintext in memory
                    }
                }
            }
            if (incidentRouting && typeof incidentRouting === 'object') {
                const phoneList = Array.isArray((incidentRouting as any).whatsappNumbers)
                    ? (incidentRouting as any).whatsappNumbers
                    : [];
                const emailList = Array.isArray((incidentRouting as any).emails)
                    ? (incidentRouting as any).emails
                    : [];

                update['incidentRouting.whatsappNumbers'] = phoneList
                    .map((v: string) => String(v || '').replace(/\s+/g, '').trim())
                    .filter(Boolean);
                update['incidentRouting.emails'] = emailList
                    .map((v: string) => String(v || '').trim().toLowerCase())
                    .filter(Boolean);
            }
            if (notificationTemplates && typeof notificationTemplates === 'object') {
                const tpl = notificationTemplates as any;
                if (tpl.institutionName !== undefined) {
                    update['notificationTemplates.institutionName'] = String(tpl.institutionName || '').trim();
                }
                if (tpl.signatureName !== undefined) {
                    update['notificationTemplates.signatureName'] = String(tpl.signatureName || '').trim();
                }
                if (tpl.closingLine !== undefined) {
                    update['notificationTemplates.closingLine'] = String(tpl.closingLine || '').trim();
                }
                if (tpl.statusWhatsappTemplate !== undefined) {
                    update['notificationTemplates.statusWhatsappTemplate'] = String(tpl.statusWhatsappTemplate || '').trim();
                }
                if (tpl.statusEmailTemplate !== undefined) {
                    update['notificationTemplates.statusEmailTemplate'] = String(tpl.statusEmailTemplate || '').trim();
                }
                if (tpl.createdEmailTemplate !== undefined) {
                    update['notificationTemplates.createdEmailTemplate'] = String(tpl.createdEmailTemplate || '').trim();
                }
            }
            const settings = await SettingsModel.findOneAndUpdate({}, update, { upsert: true, new: true });
            await addAuditLog(req.user.userId, req.user.username || '', 'settings.update', 'settings', undefined, { keys: Object.keys(req.body) });
            res.json(settings);
        } catch (error) {
            logger.error('Failed to update settings:', error);
            res.status(500).json({ error: 'Failed to update settings' });
        }
    });


    // Maintenance Mode routes
    router.get('/settings/maintenance', authenticate, authorizeAdmin, async (req, res) => {
        try {
            let settings = await SettingsModel.findOne().lean() as any;
            if (!settings) settings = await SettingsModel.create({});
            const mm = (settings as any).maintenanceMode || {};
            res.json({
                enabled: mm.enabled || false,
                message: mm.message || '',
                endsAt:  mm.endsAt  || null,
            });
        } catch (err) {
            logger.error('Bakim modu durumu alinamadi:', err);
            res.status(500).json({ error: 'Bakim modu durumu alinamadi' });
        }
    });

    router.post('/settings/maintenance', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const { enabled, message, endsAt } = req.body as { enabled: boolean; message?: string; endsAt?: string };
            const update: any = {
                'maintenanceMode.enabled': !!enabled,
                'maintenanceMode.message': message || '',
                'maintenanceMode.endsAt':  endsAt ? new Date(endsAt) : null,
            };
            await SettingsModel.findOneAndUpdate({}, { $set: update }, { upsert: true, new: true });
            res.json({ success: true, enabled: !!enabled });
        } catch (err) {
            logger.error('Bakim modu guncellenemedi:', err);
            res.status(500).json({ error: 'Bakim modu guncellenemedi' });
        }
    });

    // Messages received during maintenance
    router.get('/messages/maintenance', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const msgs = await MessageModel.find({
                direction: 'in',
                receivedDuringMaintenance: true,
            })
                .sort({ timestamp: -1 })
                .limit(100)
                .lean();
            res.json(msgs);
        } catch (err) {
            logger.error('Bakim mesajlari alinamadi:', err);
            res.status(500).json({ error: 'Mesajlar alinamadi' });
        }
    });

    const serializeIncident = (record: any) => ({
        _id: record?._id ? String(record._id) : undefined,
        id: String(record?.incidentId || record?._id || ''),
        incidentId: String(record?.incidentId || record?._id || ''),
        createdAt: record?.createdAt,
        customerName: record?.customerName || 'Bilinmiyor',
        phone: record?.customerPhone || '',
        customerPhone: record?.customerPhone || '',
        customerEmail: record?.customerEmail || '',
        address: record?.address || '',
        meterNo: record?.meterNo || '',
        issue: record?.issueSummary || 'Elektrik arizasi bildirimi',
        issueSummary: record?.issueSummary || 'Elektrik arizasi bildirimi',
        sourceNumber: record?.sourcePhoneNumber || '',
        sourcePhoneNumber: record?.sourcePhoneNumber || '',
        status: record?.status || 'ALINDI',
        statusHistory: Array.isArray(record?.statusHistory) ? record.statusHistory : [],
        images: Array.isArray(record?.images) ? record.images : [],
        photoCoords: record?.photoCoords || null,
        locationCoords: record?.locationCoords || null,
        techNote: Array.isArray(record?.statusHistory)
            ? (record.statusHistory.slice().reverse().find((entry: any) => entry?.note)?.note || '')
            : '',
        updatedAt: record?.updatedAt,
    });

    router.get('/incidents', authenticate, authorizePermission('canViewIncidents'), async (req, res) => {
        try {
            const { q = '', dateFrom = '', dateTo = '', sortOrder = 'desc' } = req.query as any;
            const query = String(q || '').trim().toLowerCase();
            const mongoQuery: any = {};
            if (query) {
                mongoQuery.$or = [
                    { incidentId: { $regex: query, $options: 'i' } },
                    { customerName: { $regex: query, $options: 'i' } },
                    { customerPhone: { $regex: query, $options: 'i' } },
                    { customerEmail: { $regex: query, $options: 'i' } },
                    { address: { $regex: query, $options: 'i' } },
                    { meterNo: { $regex: query, $options: 'i' } },
                    { issueSummary: { $regex: query, $options: 'i' } }
                ];
            }
            if (dateFrom || dateTo) {
                mongoQuery.createdAt = {};
                if (dateFrom) mongoQuery.createdAt.$gte = new Date(String(dateFrom));
                if (dateTo) {
                    const end = new Date(String(dateTo));
                    end.setHours(23, 59, 59, 999);
                    mongoQuery.createdAt.$lte = end;
                }
            }

            const sortDir = String(sortOrder) === 'asc' ? 1 : -1;
            const dbRows = await IncidentModel.find(mongoQuery)
                .sort({ createdAt: sortDir })
                .lean();

            let filtered: any[] = dbRows.map((r: any) => serializeIncident(r));

            // Backward compatibility: if DB has no incident rows yet, keep reading historical CSV files.
            if (!filtered.length) {
                const incidents = readIncidentCsvRecords();
                let csv = query
                    ? incidents.filter((r: any) => [r.id, r.customerName, r.phone, r.address, r.meterNo, r.issue].join(' ').toLowerCase().includes(query))
                    : incidents;
                if (dateFrom) {
                    const from = new Date(String(dateFrom));
                    csv = csv.filter((r: any) => r.createdAt && new Date(r.createdAt) >= from);
                }
                if (dateTo) {
                    const to = new Date(String(dateTo)); to.setHours(23, 59, 59, 999);
                    csv = csv.filter((r: any) => r.createdAt && new Date(r.createdAt) <= to);
                }
                if (sortDir === 1) csv.reverse();
                filtered = csv;
            }

            res.json({ data: filtered, total: filtered.length });
        } catch (error) {
            logger.error('Failed to fetch incidents:', error);
            res.status(500).json({ error: 'Failed to fetch incidents' });
        }
    });

    // Excel export for incidents with images and GPS address lookup
    router.get('/incidents/export', authenticate, authorizePermission('canViewIncidents'), async (req, res) => {
        try {
            const { dateFrom = '', dateTo = '', status = '' } = req.query as any;
            const mongoQuery: any = {};
            if (status) mongoQuery.status = String(status).toUpperCase();
            if (dateFrom || dateTo) {
                mongoQuery.createdAt = {};
                if (dateFrom) mongoQuery.createdAt.$gte = new Date(String(dateFrom));
                if (dateTo) {
                    const end = new Date(String(dateTo)); end.setHours(23, 59, 59, 999);
                    mongoQuery.createdAt.$lte = end;
                }
            }
            const rows = await IncidentModel.find(mongoQuery).sort({ createdAt: -1 }).lean();

            // Nominatim reverse geocoding helper (free, no API key needed)
            const getAddress = async (lat?: number, lng?: number): Promise<string> => {
                if (!lat || !lng) return '';
                try {
                    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=tr`;
                    const resp = await fetch(url, { headers: { 'User-Agent': 'WhatsYpzck/1.0' } });
                    if (!resp.ok) return `${lat},${lng}`;
                    const data = await resp.json() as any;
                    return data?.display_name || `${lat},${lng}`;
                } catch { return `${lat},${lng}`; }
            };

            const STATUS_LABELS: Record<string, string> = {
                ALINDI: 'Bekliyor', INCELEMEDE: 'İncelemede', ISLEME_ALINDI: 'İşlemde',
                COZUMLENDI: 'Tamamlandı', KAPATILDI: 'Kapatıldı',
            };

            const workbook = new ExcelJS.Workbook();
            workbook.creator = 'WhatsYpzck';
            const ws = workbook.addWorksheet('Arıza Kayıtları');
            ws.columns = [
                { header: 'Kayıt No', key: 'kayitNo', width: 16 },
                { header: 'Tarih', key: 'tarih', width: 20 },
                { header: 'Müşteri', key: 'musteri', width: 22 },
                { header: 'Telefon', key: 'telefon', width: 16 },
                { header: 'E-posta', key: 'eposta', width: 24 },
                { header: 'Adres', key: 'adres', width: 32 },
                { header: 'Sayaç / Tesisat', key: 'sayac', width: 18 },
                { header: 'Arıza Özeti', key: 'ozet', width: 36 },
                { header: 'Durum', key: 'durum', width: 14 },
                { header: 'Teknisyen Notu', key: 'techNote', width: 30 },
                { header: 'Resim URLleri', key: 'resimler', width: 50 },
                { header: 'Fotoğraf GPS', key: 'fotoGps', width: 26 },
                { header: 'Fotoğraf Adresi (Nominatim)', key: 'fotoAdres', width: 50 },
                { header: 'Konum GPS', key: 'konumGps', width: 26 },
                { header: 'Konum Adresi (Nominatim)', key: 'konumAdres', width: 50 },
                { header: 'Google Maps (Konum)', key: 'googleMaps', width: 50 },
            ];
            // Header style
            ws.getRow(1).eachCell((cell) => {
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a5276' } };
                cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            });

            for (const r of rows as any[]) {
                const fotoAdres = await getAddress(r.photoCoords?.lat, r.photoCoords?.lng);
                const konumAdres = await getAddress(r.locationCoords?.lat, r.locationCoords?.lng);
                const lat = r.locationCoords?.lat || r.photoCoords?.lat;
                const lng = r.locationCoords?.lng || r.photoCoords?.lng;
                const googleMapsUrl = lat && lng ? `https://maps.google.com/?q=${lat},${lng}` : '';
                ws.addRow({
                    kayitNo: r.incidentId || String(r._id),
                    tarih: r.createdAt ? new Date(r.createdAt).toLocaleString('tr-TR') : '',
                    musteri: r.customerName || '',
                    telefon: r.customerPhone || '',
                    eposta: r.customerEmail || '',
                    adres: r.address || '',
                    sayac: r.meterNo || '',
                    ozet: r.issueSummary || '',
                    durum: STATUS_LABELS[r.status] || r.status || '',
                    techNote: r.techNote || '',
                    resimler: (r.images || []).join('\n'),
                    fotoGps: r.photoCoords ? `${r.photoCoords.lat}, ${r.photoCoords.lng}` : '',
                    fotoAdres,
                    konumGps: r.locationCoords ? `${r.locationCoords.lat}, ${r.locationCoords.lng}` : '',
                    konumAdres,
                    googleMaps: googleMapsUrl,
                });
            }

            // Auto-height for data rows
            ws.eachRow((row, rowNum) => {
                if (rowNum > 1) row.alignment = { wrapText: true, vertical: 'top' };
            });

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            const filename = encodeURIComponent(`Ariza_Kayitlari_${new Date().toISOString().slice(0,10)}.xlsx`);
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
            await workbook.xlsx.write(res);
            res.end();
        } catch (error) {
            logger.error('Incidents export failed:', error);
            res.status(500).json({ error: 'Excel export failed' });
        }
    });

    router.get('/incidents/:id', authenticate, authorizePermission('canViewIncidents'), async (req, res) => {
        try {
            const id = String(req.params.id || '').trim();
            const dbQuery: any = { $or: [{ incidentId: id }] };
            if (/^[a-f\d]{24}$/i.test(id)) {
                dbQuery.$or.push({ _id: id });
            }

            const foundDb = await IncidentModel.findOne(dbQuery).lean() as any;

            if (foundDb) {
                return res.json(serializeIncident(foundDb));
            }

            const incidents = readIncidentCsvRecords();
            const found = incidents.find((r: any) => r.id === id || r.fileName === id);
            if (!found) {
                return res.status(404).json({ error: 'Incident not found' });
            }
            res.json(found);
        } catch (error) {
            logger.error('Failed to fetch incident detail:', error);
            res.status(500).json({ error: 'Failed to fetch incident detail' });
        }
    });

    router.patch('/incidents/:id/status', authenticate, authorizePermission('canUpdateIncidents'), async (req, res) => {
        try {
            const id = String(req.params.id || '').trim();
            const requestedStatus = String(req.body?.status || '').trim().toUpperCase();
            const note = String(req.body?.note ?? req.body?.techNote ?? '').trim();

            const allowed = ['ALINDI', 'INCELEMEDE', 'ISLEME_ALINDI', 'COZUMLENDI', 'KAPATILDI'];
            const dbQuery: any = { $or: [{ incidentId: id }] };
            if (/^[a-f\d]{24}$/i.test(id)) {
                dbQuery.$or.push({ _id: id });
            }

            let incident = await IncidentModel.findOne(dbQuery);
            if (!incident) {
                // Backward compatibility: promote legacy CSV-only incident into DB on first update.
                const legacy = readIncidentCsvRecords().find((r: any) => r.id === id || r.fileName === id);
                if (!legacy) {
                    return res.status(404).json({ error: 'Incident not found in database' });
                }
                const createdAt = legacy.createdAt ? new Date(legacy.createdAt) : new Date();
                incident = await IncidentModel.create({
                    incidentId: String(legacy.id || id),
                    customerName: String(legacy.customerName || 'Bilinmiyor'),
                    customerPhone: String(legacy.phone || ''),
                    customerEmail: '',
                    address: String(legacy.address || ''),
                    meterNo: String(legacy.meterNo || ''),
                    issueSummary: String(legacy.issue || 'Elektrik arizasi bildirimi'),
                    sourcePhoneNumber: String(legacy.sourceNumber || ''),
                    status: 'ALINDI',
                    statusHistory: [{
                        status: 'ALINDI',
                        note: 'Legacy CSV kaydindan aktarildi',
                        at: createdAt
                    }],
                    notifications: {
                        teamWhatsAppSent: false,
                        teamEmailSent: false,
                        customerEmailSent: false,
                        lastError: ''
                    },
                    createdAt
                });
            }

            const status = requestedStatus || incident.status || 'ALINDI';
            if (!allowed.includes(status)) {
                return res.status(400).json({ error: 'Invalid status value' });
            }
            if (!requestedStatus && !note) {
                return res.status(400).json({ error: 'Status veya not gerekli' });
            }

            incident.status = status as any;
            incident.statusHistory = incident.statusHistory || [];
            incident.statusHistory.push({
                status: status as any,
                note,
                at: new Date()
            });

            await incident.save();

            const settings = await SettingsModel.findOne().lean() as any;
            const tpl = settings?.notificationTemplates || {};

            const institutionName = String(tpl.institutionName || 'Coruh EDAS Artvin Il Mudurlugu');
            const signatureName = String(tpl.signatureName || 'C. Kurtoglu');
            const closingLine = String(tpl.closingLine || 'Bilgilerinize sunariz.');
            const statusWhatsappTemplate = String(
                tpl.statusWhatsappTemplate ||
                'Sayin Musterimiz,\n\nAriza kaydinizin durumu guncellenmistir.\nKayit No: {{incidentId}}\nGuncel Durum: {{statusLabel}}\nGuncelleme Zamani: {{updatedAt}}\n{{noteLine}}\n\n{{closingLine}}\n{{institutionName}}\nYetkili: {{signatureName}}'
            );
            const statusEmailTemplate = String(
                tpl.statusEmailTemplate ||
                'Sayin Musterimiz,\n\nAriza kaydinizin durumu guncellenmistir.\nKayit No: {{incidentId}}\nGuncel Durum: {{statusLabel}}\nGuncelleme Zamani: {{updatedAt}}\n{{noteLine}}\n\n{{closingLine}}\n{{institutionName}}\nYetkili: {{signatureName}}'
            );

            const statusText = incidentStatusLabel(status);
            const updatedAtText = formatTrDateTime(new Date());
            const noteLine = note ? `Aciklama: ${note}` : '';
            const templateVars = {
                incidentId: String(incident.incidentId),
                status: String(status),
                statusLabel: statusText,
                updatedAt: updatedAtText,
                note: String(note || ''),
                noteLine,
                customerName: String(incident.customerName || ''),
                customerPhone: String(incident.customerPhone || ''),
                customerEmail: String(incident.customerEmail || ''),
                address: String(incident.address || ''),
                meterNo: String(incident.meterNo || ''),
                institutionName,
                signatureName,
                closingLine
            };

            const whatsappMessageText = renderTemplate(statusWhatsappTemplate, templateVars)
                .split('\n')
                .map((line) => line.trimEnd())
                .join('\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            const statusEmailBodyText = renderTemplate(statusEmailTemplate, templateVars)
                .split('\n')
                .map((line) => line.trimEnd())
                .join('\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();

            let customerNotified = false;
            let customerEmailNotified = false;
            try {
                const chatId = toWhatsAppChatId(incident.customerPhone);
                if (chatId && botManager?.client) {
                    await botManager.client.sendMessage(chatId, whatsappMessageText);
                    customerNotified = true;
                }
            } catch (notifyErr) {
                logger.error('Failed to notify customer for incident status update:', notifyErr);
            }

            try {
                if (isValidEmail(incident.customerEmail)) {
                    const smtp = settings?.smtp;
                    if (smtp?.host && smtp?.user && smtp?.pass) {
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
                            to: incident.customerEmail,
                            subject: `Ariza Durum Guncellemesi - ${incident.incidentId}`,
                            text: statusEmailBodyText
                        });

                        customerEmailNotified = true;
                    }
                }
            } catch (mailErr) {
                logger.error('Failed to send customer status email update:', mailErr);
            }

            await addAuditLog(
                req.user.userId,
                req.user.username || '',
                'incident.status.update',
                'incident',
                incident.incidentId,
                { status, note, customerNotified, customerEmailNotified }
            );
            fireEvent('incident.status.updated', {
                incidentId: String(incident.incidentId),
                status: String(status),
                statusLabel: statusText,
                note,
                customerName: String(incident.customerName || ''),
                customerPhone: String(incident.customerPhone || ''),
                customerEmail: String(incident.customerEmail || ''),
                address: String(incident.address || ''),
                meterNo: String(incident.meterNo || ''),
                source: 'crm'
            }).catch(() => {});

            res.json(serializeIncident(incident.toObject()));
        } catch (error) {
            logger.error('Failed to update incident status:', error);
            res.status(500).json({ error: 'Failed to update incident status' });
        }
    });

    // Commands
    router.get('/commands', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const settings = await SettingsModel.findOne().lean() as any;
            const disabled: string[] = settings?.disabledCommands || [];
            const stats = settings?.commandStats || {};
            const list = Object.keys(commands).map(name => ({
                name, disabled: disabled.includes(name), usageCount: stats[name] || 0
            }));
            res.json(list);
        } catch (error) {
            logger.error('Failed to fetch commands:', error);
            res.status(500).json({ error: 'Failed to fetch commands' });
        }
    });

    router.get('/commands/stats', authenticate, authorizeAdmin, async (_req, res) => {
        try {
            const settings = await SettingsModel.findOne().lean() as any;
            res.json(settings?.commandStats || {});
        } catch (error) {
            logger.error('Failed to fetch command stats:', error);
            res.status(500).json({ error: 'Failed to fetch command stats' });
        }
    });

    router.patch('/commands/:name', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const { name } = req.params;
            if (!(name in commands)) return res.status(404).json({ error: 'Command not found' });
            const settings = await SettingsModel.findOne().lean() as any;
            const disabled: string[] = settings?.disabledCommands || [];
            const isDisabled = disabled.includes(name);
            const update = isDisabled ? { $pull: { disabledCommands: name } } : { $addToSet: { disabledCommands: name } };
            await SettingsModel.findOneAndUpdate({}, update, { upsert: true });
            await addAuditLog(req.user.userId, req.user.username || '', isDisabled ? 'command.enable' : 'command.disable', 'command', name);
            res.json({ name, disabled: !isDisabled });
        } catch (error) {
            logger.error('Failed to toggle command:', error);
            res.status(500).json({ error: 'Failed to toggle command' });
        }
    });

    // Users
    router.get('/users', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const users = await UserModel.find().select('-password').sort({ createdAt: -1 });
            res.json(users);
        } catch (error) {
            logger.error('Failed to fetch users:', error);
            res.status(500).json({ error: 'Kullanıcılar alınamadı' });
        }
    });

    router.put('/users/:id', authenticate, authorizeAdmin, async (req, res) => {
        try {
            if (req.params.id === req.user.userId) return res.status(400).json({ error: 'Kendi rolünüzü değiştiremezsiniz' });
            const { role, permissions, displayName, phone, isActive } = req.body;
            const update: Record<string, any> = {};
            if (role !== undefined) {
                update.role = normalizeUserRole(role);
            }
            if (permissions !== undefined) update.permissions = permissions;
            if (displayName !== undefined) update.displayName = displayName;
            if (phone !== undefined) update.phone = phone;
            if (isActive !== undefined) update.isActive = isActive;
            const user = await UserModel.findByIdAndUpdate(req.params.id, update, { new: true }).select('-password');
            if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
            await addAuditLog(req.user.userId, req.user.username || '', 'user.update', 'user', req.params.id, update);
            res.json(user);
        } catch (error) {
            logger.error('Failed to update user:', error);
            res.status(400).json({ error: error.message || 'Kullanıcı güncellenemedi' });
        }
    });

    router.put('/users/:id/permissions', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const { permissions } = req.body;
            if (!permissions || typeof permissions !== 'object') return res.status(400).json({ error: 'Geçersiz izin verisi' });
            const user = await UserModel.findByIdAndUpdate(req.params.id, { permissions }, { new: true }).select('-password');
            if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
            await addAuditLog(req.user.userId, req.user.username || '', 'user.permissions', 'user', req.params.id, { permissions });
            res.json(user);
        } catch (error) {
            logger.error('Failed to update permissions:', error);
            res.status(500).json({ error: 'İzinler güncellenemedi' });
        }
    });

    router.delete('/users/:id', authenticate, authorizeAdmin, async (req, res) => {
        try {
            if (req.params.id === req.user.userId) return res.status(400).json({ error: 'Kendi hesabınızı silemezsiniz' });
            const user = await UserModel.findByIdAndDelete(req.params.id);
            if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
            await addAuditLog(req.user.userId, req.user.username || '', 'user.delete', 'user', req.params.id, { username: user.username });
            res.json({ success: true });
        } catch (error) {
            logger.error('Failed to delete user:', error);
            res.status(500).json({ error: 'Kullanıcı silinemedi' });
        }
    });

    // Audit Logs
    router.get('/audit-logs', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const { page = 1, limit = 30, action = '', resource = '' } = req.query;
            const skip = (Number(page) - 1) * Number(limit);
            const query: any = {};
            if (action) {
                // ReDoS koruması: özel regex karakterlerini escape et
                const safeAction = String(action).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 50);
                query.action = { $regex: safeAction, $options: 'i' };
            }
            if (resource) query.resource = resource;
            const [logs, total] = await Promise.all([
                AuditLogModel.find(query).sort({ timestamp: -1 }).skip(skip).limit(Number(limit)),
                AuditLogModel.countDocuments(query)
            ]);
            res.json({ data: logs, meta: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) } });
        } catch (error) {
            logger.error('Failed to fetch audit logs:', error);
            res.status(500).json({ error: 'Failed to fetch audit logs' });
        }
    });

    // Analytics
    router.get('/analytics', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
            const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
            const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
            const yesterdayEnd = new Date(todayStart);

            const [
                contactsOverTime, campaigns, langStats,
                contactsToday, contactsYesterday,
                messagesToday, messagesYesterday,
                failedCampaigns, recentAudit, settings
            ] = await Promise.all([
                ContactModel.aggregate([
                    { $match: { createdAt: { $gte: thirtyDaysAgo } } },
                    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
                    { $sort: { _id: 1 } }
                ]),
                CampaignModel.find().sort({ createdAt: -1 }).limit(20).select('name sentCount failedCount status'),
                Promise.all([
                    ContactModel.countDocuments({ detectedLanguage: 'en', blocked: { $ne: true } }),
                    ContactModel.countDocuments({ detectedLanguage: 'fr', blocked: { $ne: true } }),
                    ContactModel.countDocuments({ detectedLanguage: 'other', blocked: { $ne: true } }),
                ]),
                ContactModel.countDocuments({ createdAt: { $gte: todayStart, $lte: todayEnd } }),
                ContactModel.countDocuments({ createdAt: { $gte: yesterdayStart, $lt: yesterdayEnd } }),
                MessageModel.countDocuments({ direction: 'in', timestamp: { $gte: todayStart, $lte: todayEnd } }),
                MessageModel.countDocuments({ direction: 'in', timestamp: { $gte: yesterdayStart, $lt: yesterdayEnd } }),
                CampaignModel.find({ status: 'failed', updatedAt: { $gte: sevenDaysAgo } }).select('name createdAt').limit(10),
                AuditLogModel.find().sort({ timestamp: -1 }).limit(5).select('username action resource timestamp'),
                SettingsModel.findOne().lean()
            ]);

            const commandStats: Record<string, number> = (settings as any)?.commandStats || {};
            const topCommands = Object.entries(commandStats)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([name, count]) => ({ name, count }));

            res.json({
                contactsOverTime: contactsOverTime.map((d: any) => ({ date: d._id, count: d.count })),
                campaignDelivery: campaigns.map(c => ({ name: c.name, sentCount: c.sentCount || 0, failedCount: c.failedCount || 0, status: c.status })),
                languageDistribution: { en: langStats[0], fr: langStats[1], other: langStats[2] },
                contactsDelta: { today: contactsToday, yesterday: contactsYesterday },
                messagesDelta: { today: messagesToday, yesterday: messagesYesterday },
                failedCampaigns: failedCampaigns.map(c => ({ name: c.name, id: c._id })),
                topCommands,
                recentAudit
            });
        } catch (error) {
            logger.error('Failed to fetch analytics:', error);
            res.status(500).json({ error: 'Failed to fetch analytics' });
        }
    });

    // Bot Status
    router.get('/bot/status', authenticate, authorizeAdmin, (req, res) => {
        res.json(botManager.getStatus());
    });

    router.post('/bot/reconnect', authenticate, authorizeAdmin, async (req, res) => {
        try {
            await botManager.reconnect();
            await addAuditLog(req.user.userId, req.user.username || '', 'bot.reconnect', 'bot');
            res.json({ success: true });
        } catch (error) {
            logger.error('Failed to reconnect bot:', error);
            res.status(500).json({ error: 'Failed to reconnect' });
        }
    });

    // Log Streaming (SSE)
    router.get('/logs/stream', async (req, res) => {
        const token = req.query.token as string;
        if (!token) return res.status(401).end();
        const decoded = await AuthService.verifyToken(token) as any;
        if (!decoded || decoded.role !== 'admin') return res.status(401).end();

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.flushHeaders();

        const buffer = LogBuffer.getInstance();
        buffer.entries.forEach((entry: LogEntry) => {
            res.write(`data: ${JSON.stringify(entry)}\n\n`);
        });

        const onLog = (entry: LogEntry) => {
            try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (_) {}
        };
        buffer.emitter.on('log', onLog);
        req.on('close', () => buffer.emitter.off('log', onLog));
    });

    // Inbox
    router.get('/inbox', authenticate, authorizePermission('canViewConversations'), async (req, res) => {
        try {
            // Get all distinct phone numbers first to build the full conversation list
            const allPhones = await MessageModel.distinct('phoneNumber');
            const resolutionMap = await buildConversationResolutionMap(allPhones, botManager);
            const botOwnPhone = getBotOwnConversationPhone(botManager);

            // Aggregate per conversation: last message + unread count
            const aggResult = await MessageModel.aggregate([
                { $sort: { timestamp: -1 } },
                {
                    $group: {
                        _id: '$phoneNumber',
                        lastMessage: { $first: '$body' },
                        lastTimestamp: { $first: '$timestamp' },
                        unread: {
                            $sum: {
                                $cond: [{ $and: [{ $eq: ['$direction', 'in'] }, { $eq: ['$read', false] }] }, 1, 0]
                            }
                        }
                    }
                },
                { $sort: { lastTimestamp: -1 } }
            ]);

            const conversationMap = new Map<string, any>();
            aggResult.forEach((entry: any) => {
                const canonicalPhone = resolutionMap.get(entry._id) || normalizeConversationPhone(entry._id);
                if (!canonicalPhone) return;
                if (botOwnPhone && canonicalPhone === botOwnPhone) return;

                const existing = conversationMap.get(canonicalPhone);
                if (!existing || new Date(entry.lastTimestamp || 0).getTime() > new Date(existing.lastTimestamp || 0).getTime()) {
                    conversationMap.set(canonicalPhone, {
                        phoneNumber: canonicalPhone,
                        lastMessage: entry.lastMessage,
                        lastTimestamp: entry.lastTimestamp,
                        unread: (existing?.unread || 0) + entry.unread,
                    });
                } else {
                    existing.unread += entry.unread;
                }
            });

            const canonicalPhones = Array.from(conversationMap.keys());
            const contacts = await ContactModel.find({}).lean();
            const result = canonicalPhones
                .map((phoneNumber) => ({
                    ...conversationMap.get(phoneNumber),
                    contact: pickConversationContact(contacts, phoneNumber)
                }))
                .sort((a, b) => new Date(b.lastTimestamp || 0).getTime() - new Date(a.lastTimestamp || 0).getTime());
            res.json(result);
        } catch (error) {
            logger.error('Failed to fetch inbox:', error);
            res.status(500).json({ error: 'Failed to fetch inbox' });
        }
    });

    router.get('/inbox/stream', async (req, res) => {
        const token = req.query.token as string;
        if (!token) return res.status(401).end();
        const decoded = await AuthService.verifyToken(token) as any;
        if (!decoded || decoded.role !== 'admin') return res.status(401).end();

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.flushHeaders();

        const onMsg = (msg: any) => {
            try { res.write(`data: ${JSON.stringify(msg)}\n\n`); } catch (_) {}
        };
        messageEmitter.on('message', onMsg);
        req.on('close', () => messageEmitter.off('message', onMsg));
    });

    router.get('/inbox/:phone', authenticate, authorizePermission('canViewConversations'), async (req, res) => {
        try {
            const { phone } = req.params;
            const canonicalPhone = normalizeConversationPhone(phone);
            const botOwnPhone = getBotOwnConversationPhone(botManager);
            if (botOwnPhone && canonicalPhone === botOwnPhone) {
                return res.json({ messages: [], contact: null });
            }
            const rawPhones = await MessageModel.distinct('phoneNumber');
            const resolutionMap = await buildConversationResolutionMap(rawPhones, botManager);
            const aliases = rawPhones.filter((rawPhone) => (resolutionMap.get(rawPhone) || normalizeConversationPhone(rawPhone)) === canonicalPhone);
            const messagePhones = Array.from(new Set([canonicalPhone, ...aliases].filter(Boolean)));

            const messages = await MessageModel.find({ phoneNumber: { $in: messagePhones } })
                .sort({ timestamp: 1 })
                .limit(1000)
                .lean();
            await MessageModel.updateMany(
                { phoneNumber: { $in: messagePhones }, direction: 'in', read: false },
                { $set: { read: true } }
            );
            const contacts = await ContactModel.find({}).lean();
            const contact = pickConversationContact(contacts, canonicalPhone);
            res.json({
                messages: messages.map((message: any) => ({ ...message, phoneNumber: canonicalPhone })),
                contact
            });
        } catch (error) {
            logger.error('Failed to fetch conversation:', error);
            res.status(500).json({ error: 'Failed to fetch conversation' });
        }
    });

    router.post('/inbox/:phone/reply', authenticate, authorizePermission('canSendMessages'), async (req, res) => {
        try {
            const { phone } = req.params;
            const { message } = req.body;
            if (!message) return res.status(400).json({ error: 'message required' });

            const canonicalPhone = normalizeConversationPhone(phone);
            const formattedNumber = toWhatsAppChatId(canonicalPhone);
            if (!formattedNumber) {
                return res.status(400).json({ error: 'invalid phone number' });
            }
            const sentMessage = await botManager.client.sendMessage(formattedNumber, message);

            const msgDoc = await MessageModel.create({
                phoneNumber: canonicalPhone,
                body: message,
                type: 'text',
                direction: 'out',
                whatsappMessageId: sentMessage?.id?._serialized,
                sentVia: 'admin',
                read: true,
                timestamp: new Date()
            });
            messageEmitter.emit('message', msgDoc.toObject());
            res.json(msgDoc);
        } catch (error) {
            logger.error('Failed to send reply:', error);
            res.status(500).json({ error: 'Failed to send reply' });
        }
    });

    // Contact Scoring
    router.get('/contacts/leaderboard', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const limit = Number(req.query.limit) || 10;
            const contacts = await ContactModel.find().sort({ score: -1 }).limit(limit).lean();
            res.json(contacts);
        } catch (error) {
            logger.error('Failed to fetch leaderboard:', error);
            res.status(500).json({ error: 'Failed to fetch leaderboard' });
        }
    });

    router.get('/scoring/rules', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const rules = await ScoreRuleModel.find().sort({ action: 1 });
            res.json(rules);
        } catch (error) {
            logger.error('Failed to fetch score rules:', error);
            res.status(500).json({ error: 'Failed to fetch score rules' });
        }
    });

    router.post('/scoring/rules', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const { action, label, points, enabled } = req.body;
            const rule = new ScoreRuleModel({ action, label, points: Number(points), enabled: enabled !== false });
            await rule.save();
            await addAuditLog(req.user.userId, req.user.username || '', 'scoring.create', 'score-rule', String(rule._id), { action });
            res.status(201).json(rule);
        } catch (error) {
            logger.error('Failed to create score rule:', error);
            res.status(500).json({ error: 'Failed to create score rule' });
        }
    });

    router.put('/scoring/rules/:id', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const { points, enabled, label } = req.body;
            const update: any = {};
            if (points !== undefined) update.points = Number(points);
            if (enabled !== undefined) update.enabled = enabled;
            if (label !== undefined) update.label = label;
            const rule = await ScoreRuleModel.findByIdAndUpdate(req.params.id, update, { new: true });
            if (!rule) return res.status(404).json({ error: 'Rule not found' });
            await addAuditLog(req.user.userId, req.user.username || '', 'scoring.update', 'score-rule', req.params.id);
            res.json(rule);
        } catch (error) {
            logger.error('Failed to update score rule:', error);
            res.status(500).json({ error: 'Failed to update score rule' });
        }
    });

    router.delete('/scoring/rules/:id', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const rule = await ScoreRuleModel.findByIdAndDelete(req.params.id);
            if (!rule) return res.status(404).json({ error: 'Rule not found' });
            await addAuditLog(req.user.userId, req.user.username || '', 'scoring.delete', 'score-rule', req.params.id);
            res.json({ success: true });
        } catch (error) {
            logger.error('Failed to delete score rule:', error);
            res.status(500).json({ error: 'Failed to delete score rule' });
        }
    });

    // Campaign Extra Actions
    router.patch('/campaigns/:id/pause', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const campaign = await CampaignModel.findByIdAndUpdate(req.params.id, { status: 'paused' }, { new: true });
            if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
            await addAuditLog(req.user.userId, req.user.username || '', 'campaign.pause', 'campaign', req.params.id);
            res.json(campaign);
        } catch (error) {
            logger.error('Failed to pause campaign:', error);
            res.status(500).json({ error: 'Failed to pause campaign' });
        }
    });

    router.patch('/campaigns/:id/resume', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const campaign = await CampaignModel.findByIdAndUpdate(req.params.id, { status: 'scheduled' }, { new: true });
            if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
            await addAuditLog(req.user.userId, req.user.username || '', 'campaign.resume', 'campaign', req.params.id);
            res.json(campaign);
        } catch (error) {
            logger.error('Failed to resume campaign:', error);
            res.status(500).json({ error: 'Failed to resume campaign' });
        }
    });

    router.patch('/campaigns/:id/cancel', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const campaign = await CampaignModel.findByIdAndUpdate(req.params.id, { status: 'cancelled' }, { new: true });
            if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
            await addAuditLog(req.user.userId, req.user.username || '', 'campaign.cancel', 'campaign', req.params.id);
            res.json(campaign);
        } catch (error) {
            logger.error('Failed to cancel campaign:', error);
            res.status(500).json({ error: 'Failed to cancel campaign' });
        }
    });

    router.patch('/campaigns/:id/archive', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const campaign = await CampaignModel.findByIdAndUpdate(req.params.id, { status: 'archived' }, { new: true });
            if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
            await addAuditLog(req.user.userId, req.user.username || '', 'campaign.archive', 'campaign', req.params.id);
            res.json(campaign);
        } catch (error) {
            logger.error('Failed to archive campaign:', error);
            res.status(500).json({ error: 'Failed to archive campaign' });
        }
    });

    router.patch('/campaigns/:id/notes', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const { notes } = req.body;
            const campaign = await CampaignModel.findByIdAndUpdate(req.params.id, { notes }, { new: true });
            if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
            res.json(campaign);
        } catch (error) {
            logger.error('Failed to update notes:', error);
            res.status(500).json({ error: 'Failed to update notes' });
        }
    });

    router.get('/campaigns/:id/preview', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const campaign = await CampaignModel.findById(req.params.id).lean();
            if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
            const phone = String(req.query.phone || '');
            const contact = await ContactModel.findOne({ phoneNumber: phone }).lean();
            const vars = {
                name: contact?.name || contact?.pushName || phone || 'Friend',
                phone: phone || '0000000000',
                date: new Date().toLocaleDateString()
            };
            const preview = campaign.message.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}|\{(\w+)\}/g, (_: any, k1: string, fallback: string, k2: string) => {
                const key = k1 || k2;
                return (vars as any)[key] || fallback || '';
            });
            res.json({ preview });
        } catch (error) {
            logger.error('Failed to preview campaign:', error);
            res.status(500).json({ error: 'Failed to preview campaign' });
        }
    });

    router.post('/campaigns/:id/test-send', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const campaign = await CampaignModel.findById(req.params.id).lean();
            if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
            const phone = String(req.query.phone || req.body.phone || '');
            if (!phone) return res.status(400).json({ error: 'phone required' });
            const contact = await ContactModel.findOne({ phoneNumber: phone }).lean();
            const vars = {
                name: contact?.name || contact?.pushName || phone,
                phone,
                date: new Date().toLocaleDateString()
            };
            const body = campaign.message.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}|\{(\w+)\}/g, (_: any, k1: string, fallback: string, k2: string) => {
                const key = k1 || k2;
                return (vars as any)[key] || fallback || '';
            });
            const formattedNumber = phone.includes('@') ? phone : `${phone}@c.us`;
            await botManager.client.sendMessage(formattedNumber, body);
            res.json({ success: true });
        } catch (error) {
            logger.error('Failed to send test message:', error);
            res.status(500).json({ error: 'Failed to send test message' });
        }
    });

    router.get('/campaigns/:id/delivery-report/export', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const campaign = await CampaignModel.findById(req.params.id).select('name deliveryReport');
            if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

            const workbook = new ExcelJS.Workbook();
            workbook.creator = 'WhatsYpzck CRM';
            const sheet = workbook.addWorksheet('Teslimat Raporu');
            sheet.columns = [
                { header: 'Telefon',         key: 'phone',     width: 20 },
                { header: 'Durum',           key: 'status',    width: 15 },
                { header: 'Hata',            key: 'error',     width: 35 },
                { header: 'Gönderilme',      key: 'sentAt',    width: 22 },
                { header: 'Yanıtlanma',      key: 'repliedAt', width: 22 },
            ];
            const headerRow = sheet.getRow(1);
            headerRow.eachCell(cell => {
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
                cell.alignment = { vertical: 'middle', horizontal: 'center' };
            });
            headerRow.height = 20;

            campaign.deliveryReport.forEach((r: any) => {
                sheet.addRow({
                    phone:     r.phone || '',
                    status:    r.status || '',
                    error:     r.error || '',
                    sentAt:    r.sentAt ? new Date(r.sentAt).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }) : '',
                    repliedAt: r.repliedAt ? new Date(r.repliedAt).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }) : '',
                });
            });

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="delivery-report-${req.params.id}.xlsx"`);
            await workbook.xlsx.write(res);
            res.end();
        } catch (error) {
            logger.error('Failed to export delivery report:', error);
            res.status(500).json({ error: 'Failed to export delivery report' });
        }
    });

    // Template Extra Actions
    router.post('/templates/:id/duplicate', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const original = await TemplateModel.findById(req.params.id).lean();
            if (!original) return res.status(404).json({ error: 'Template not found' });
            const copy = new TemplateModel({
                name: `Copy of ${(original as any).name}`,
                content: (original as any).content,
                category: (original as any).category || 'general',
                createdBy: req.user.userId,
                pinned: false,
                usageCount: 0,
                revision: 0,
                approvalStatus: 'draft'
            });
            await copy.save();
            await addAuditLog(req.user.userId, req.user.username || '', 'template.duplicate', 'template', String(copy._id), { from: req.params.id });
            res.status(201).json(copy);
        } catch (error) {
            logger.error('Failed to duplicate template:', error);
            res.status(500).json({ error: 'Failed to duplicate template' });
        }
    });

    router.patch('/templates/:id/pin', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const template = await TemplateModel.findById(req.params.id);
            if (!template) return res.status(404).json({ error: 'Template not found' });
            (template as any).pinned = !(template as any).pinned;
            await template.save();
            await addAuditLog(req.user.userId, req.user.username || '', (template as any).pinned ? 'template.pin' : 'template.unpin', 'template', req.params.id);
            res.json(template);
        } catch (error) {
            logger.error('Failed to toggle pin:', error);
            res.status(500).json({ error: 'Failed to toggle pin' });
        }
    });

    router.patch('/templates/:id/approval', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const { approvalStatus } = req.body;
            const template = await TemplateModel.findByIdAndUpdate(req.params.id, { approvalStatus }, { new: true });
            if (!template) return res.status(404).json({ error: 'Template not found' });
            await addAuditLog(req.user.userId, req.user.username || '', 'template.approval', 'template', req.params.id, { approvalStatus });
            res.json(template);
        } catch (error) {
            logger.error('Failed to update approval:', error);
            res.status(500).json({ error: 'Failed to update approval' });
        }
    });

    router.get('/templates/:id/revisions', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const revisions = await TemplateRevisionModel.find({ templateId: req.params.id }).sort({ revision: -1 });
            res.json(revisions);
        } catch (error) {
            logger.error('Failed to fetch revisions:', error);
            res.status(500).json({ error: 'Failed to fetch revisions' });
        }
    });

    router.post('/templates/:id/revisions/:rev/restore', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const revision = await TemplateRevisionModel.findOne({ templateId: req.params.id, revision: Number(req.params.rev) });
            if (!revision) return res.status(404).json({ error: 'Revision not found' });
            const template = await TemplateModel.findById(req.params.id);
            if (!template) return res.status(404).json({ error: 'Template not found' });

            // Save current state as new revision before restoring
            const currentRev = (template as any).revision || 0;
            await TemplateRevisionModel.create({
                templateId: template._id,
                revision: currentRev,
                name: (template as any).name,
                content: (template as any).content,
                category: (template as any).category || 'general',
                savedBy: req.user.username || 'admin',
                savedAt: new Date()
            });

            (template as any).name = revision.name;
            (template as any).content = revision.content;
            (template as any).category = revision.category;
            (template as any).revision = currentRev + 1;
            await template.save();

            await addAuditLog(req.user.userId, req.user.username || '', 'template.restore', 'template', req.params.id, { revision: req.params.rev });
            res.json(template);
        } catch (error) {
            logger.error('Failed to restore revision:', error);
            res.status(500).json({ error: 'Failed to restore revision' });
        }
    });

    // Scheduled Messages
    router.get('/scheduled-messages', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const msgs = await ScheduledMessageModel.find().sort({ scheduledAt: 1 });
            res.json(msgs);
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch scheduled messages' });
        }
    });

    router.post('/scheduled-messages', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const {
                phoneNumber,
                message,
                scheduledAt,
                contactName,
                recipientType = 'single',
                groupId,
                groupName,
                recipientPhones = []
            } = req.body;

            if (!message || !scheduledAt) {
                return res.status(400).json({ error: 'message and scheduledAt are required' });
            }

            const normalizedSinglePhone = normalizeConversationPhone(phoneNumber || '');
            const normalizedGroupPhones = Array.from(new Set(
                (Array.isArray(recipientPhones) ? recipientPhones : [])
                    .map((value: string) => normalizeConversationPhone(value))
                    .filter(Boolean)
            ));

            if (recipientType === 'group') {
                if (!groupId || !groupName || !normalizedGroupPhones.length) {
                    return res.status(400).json({ error: 'groupId, groupName and recipientPhones are required for group messages' });
                }
            } else if (!normalizedSinglePhone) {
                return res.status(400).json({ error: 'phoneNumber is required' });
            }

            const doc = await ScheduledMessageModel.create({
                recipientType,
                phoneNumber: normalizedSinglePhone,
                groupId: recipientType === 'group' ? String(groupId) : undefined,
                groupName: recipientType === 'group' ? String(groupName) : undefined,
                recipientPhones: recipientType === 'group' ? normalizedGroupPhones : [],
                recipientCount: recipientType === 'group' ? normalizedGroupPhones.length : 1,
                message,
                scheduledAt: new Date(scheduledAt),
                contactName: contactName || '',
                createdBy: req.user.userId
            });
            await addAuditLog(req.user.userId, req.user.username || '', 'scheduled_message.create', 'scheduled_message', String(doc._id), {
                phoneNumber: normalizedSinglePhone,
                groupId,
                groupName,
                scheduledAt,
                recipientType
            });
            res.status(201).json(doc);
        } catch (error) {
            res.status(500).json({ error: 'Failed to create scheduled message' });
        }
    });

    router.get('/contact-groups', authenticate, authorizeAdmin, async (_req, res) => {
        try {
            const groups = await ContactGroupModel.find().sort({ name: 1 }).lean();
            res.json(groups.map((group) => ({
                ...group,
                memberCount: Array.isArray(group.memberPhones) ? group.memberPhones.length : 0
            })));
        } catch (error) {
            logger.error('GET /contact-groups error:', error);
            res.status(500).json({ error: 'Failed to fetch contact groups' });
        }
    });

    router.post('/contact-groups', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const name = String(req.body?.name || '').trim();
            if (!name) return res.status(400).json({ error: 'Group name is required' });

            const slug = slugifyGroupName(req.body?.slug || name);
            const addressKeywords = parseGroupList(req.body?.addressKeywords).map((item) => item.toLocaleLowerCase('tr-TR'));
            const memberPhones = parseGroupList(req.body?.memberPhones).map((item) => normalizeConversationPhone(item)).filter(Boolean);
            const doc = await ContactGroupModel.create({
                name,
                slug,
                description: String(req.body?.description || '').trim(),
                addressKeywords,
                memberPhones: Array.from(new Set(memberPhones)),
                enabled: req.body?.enabled !== false
            });

            await addAuditLog(req.user.userId, req.user.username || '', 'contact_group.create', 'contact_group', String(doc._id), {
                name,
                slug,
                memberCount: memberPhones.length
            });
            res.status(201).json(doc);
        } catch (error: any) {
            logger.error('POST /contact-groups error:', error);
            if (error?.code === 11000) return res.status(409).json({ error: 'Bu grup adi veya kisaltmasi zaten kullaniliyor' });
            res.status(500).json({ error: 'Failed to create contact group' });
        }
    });

    router.put('/contact-groups/:id', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const existing = await ContactGroupModel.findById(req.params.id);
            if (!existing) return res.status(404).json({ error: 'Group not found' });

            const name = String(req.body?.name || existing.name).trim();
            const slug = slugifyGroupName(req.body?.slug || name);
            existing.name = name;
            existing.slug = slug;
            existing.description = String(req.body?.description ?? existing.description ?? '').trim();
            existing.addressKeywords = parseGroupList(req.body?.addressKeywords ?? existing.addressKeywords)
                .map((item) => item.toLocaleLowerCase('tr-TR'));
            existing.memberPhones = Array.from(new Set(
                parseGroupList(req.body?.memberPhones ?? existing.memberPhones)
                    .map((item) => normalizeConversationPhone(item))
                    .filter(Boolean)
            ));
            existing.enabled = req.body?.enabled !== undefined ? Boolean(req.body.enabled) : existing.enabled;
            await existing.save();

            await addAuditLog(req.user.userId, req.user.username || '', 'contact_group.update', 'contact_group', String(existing._id), {
                name: existing.name,
                slug: existing.slug,
                memberCount: existing.memberPhones.length
            });
            res.json(existing);
        } catch (error: any) {
            logger.error('PUT /contact-groups/:id error:', error);
            if (error?.code === 11000) return res.status(409).json({ error: 'Bu grup adi veya kisaltmasi zaten kullaniliyor' });
            res.status(500).json({ error: 'Failed to update contact group' });
        }
    });

    router.delete('/contact-groups/:id', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const doc = await ContactGroupModel.findByIdAndDelete(req.params.id);
            if (!doc) return res.status(404).json({ error: 'Group not found' });
            await addAuditLog(req.user.userId, req.user.username || '', 'contact_group.delete', 'contact_group', req.params.id, { name: doc.name });
            res.json({ success: true });
        } catch (error) {
            logger.error('DELETE /contact-groups/:id error:', error);
            res.status(500).json({ error: 'Failed to delete contact group' });
        }
    });

    router.post('/contact-groups/:id/send-message', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const message = String(req.body?.message || '').trim();
            if (!message) return res.status(400).json({ error: 'Message is required' });

            const group = await ContactGroupModel.findById(req.params.id);
            if (!group) return res.status(404).json({ error: 'Group not found' });

            const recipients = Array.from(new Set((group.memberPhones || []).map((item) => normalizeConversationPhone(item)).filter(Boolean)));
            if (!recipients.length) {
                return res.status(400).json({ error: 'Group has no members yet' });
            }

            let sentCount = 0;
            let failedCount = 0;
            for (const phone of recipients) {
                try {
                    const sentMessage = await botManager.client.sendMessage(toWhatsAppChatId(phone) as string, message);
                    await persistOutboundAdminMessage(phone, message, sentMessage);
                    sentCount++;
                } catch (error) {
                    failedCount++;
                    logger.error(`Failed to send group message to ${phone}:`, error);
                }
            }

            await addAuditLog(req.user.userId, req.user.username || '', 'contact_group.send_message', 'contact_group', req.params.id, {
                name: group.name,
                sentCount,
                failedCount
            });

            res.json({ success: true, sentCount, failedCount, groupName: group.name });
        } catch (error) {
            logger.error('POST /contact-groups/:id/send-message error:', error);
            res.status(500).json({ error: 'Failed to send group message' });
        }
    });

    router.post('/contact-groups/:id/schedule-message', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const message = String(req.body?.message || '').trim();
            const scheduledAt = req.body?.scheduledAt;
            if (!message || !scheduledAt) {
                return res.status(400).json({ error: 'Message and scheduledAt are required' });
            }

            const group = await ContactGroupModel.findById(req.params.id);
            if (!group) return res.status(404).json({ error: 'Group not found' });

            const recipients = Array.from(new Set((group.memberPhones || []).map((item) => normalizeConversationPhone(item)).filter(Boolean)));
            if (!recipients.length) {
                return res.status(400).json({ error: 'Group has no members yet' });
            }

            const doc = await ScheduledMessageModel.create({
                recipientType: 'group',
                groupId: String(group._id),
                groupName: group.name,
                recipientPhones: recipients,
                recipientCount: recipients.length,
                message,
                scheduledAt: new Date(scheduledAt),
                createdBy: req.user.userId
            });

            await addAuditLog(req.user.userId, req.user.username || '', 'contact_group.schedule_message', 'contact_group', req.params.id, {
                groupName: group.name,
                scheduledAt,
                recipientCount: recipients.length
            });
            res.status(201).json(doc);
        } catch (error) {
            logger.error('POST /contact-groups/:id/schedule-message error:', error);
            res.status(500).json({ error: 'Failed to schedule group message' });
        }
    });

    router.delete('/scheduled-messages/:id', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const doc = await ScheduledMessageModel.findById(req.params.id);
            if (!doc) return res.status(404).json({ error: 'Not found' });
            if (doc.status === 'sent') return res.status(400).json({ error: 'Cannot delete a sent message' });
            await doc.deleteOne();
            await addAuditLog(req.user.userId, req.user.username || '', 'scheduled_message.delete', 'scheduled_message', req.params.id, {});
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Failed to delete scheduled message' });
        }
    });

    // Conversations Search
    router.get('/conversations/search', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const q = (req.query.q as string || '').trim();
            const phone = (req.query.phone as string || '').trim();
            const filter: any = {};
            if (q) filter.body = { $regex: q, $options: 'i' };

            const messages = await MessageModel.find(filter)
                .sort({ timestamp: -1 })
                .limit(400)
                .lean();

            const resolutionMap = await buildConversationResolutionMap(messages.map((message: any) => message.phoneNumber), botManager);
            const normalizedPhoneSearch = normalizeConversationPhone(phone);
            const botOwnPhone = getBotOwnConversationPhone(botManager);

            const threadMap: Record<string, any[]> = {};
            messages.forEach((message: any) => {
                const canonicalPhone = resolutionMap.get(message.phoneNumber) || normalizeConversationPhone(message.phoneNumber);
                if (!canonicalPhone) return;
                if (botOwnPhone && canonicalPhone === botOwnPhone) return;
                if (phone && canonicalPhone !== normalizedPhoneSearch && !canonicalPhone.includes(normalizedPhoneSearch)) {
                    return;
                }
                if (!threadMap[canonicalPhone]) threadMap[canonicalPhone] = [];
                threadMap[canonicalPhone].push({ ...message, phoneNumber: canonicalPhone });
            });

            const phones = Object.keys(threadMap);
            const contacts = await ContactModel.find({}).lean();

            const threads = phones.map(pn => ({
                phoneNumber: pn,
                contact: pickConversationContact(contacts, pn),
                matchCount: threadMap[pn].length,
                lastMessage: threadMap[pn][0]?.body || '',
                lastTimestamp: threadMap[pn][0]?.timestamp || null,
                messages: threadMap[pn].reverse() // chronological order
            }));

            res.json(threads);
        } catch (error) {
            res.status(500).json({ error: 'Failed to search conversations' });
        }
    });

    // Direct Message
    router.post('/send-message', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const { phoneNumber, message } = req.body;
            const formattedNumber = phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@c.us`;
            await botManager.client.sendMessage(formattedNumber, message);
            res.json({ success: true });
        } catch (error) {
            logger.error('Failed to send message:', error);
            res.status(500).json({ error: 'Failed to send message' });
        }
    });

    // Integrations (Webhooks / Slack / Discord)
    router.get('/integrations', authenticate, authorizeAdmin, async (_req, res) => {
        try {
            const items = await IntegrationModel.find().sort({ createdAt: -1 }).lean();
            res.json(items);
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch integrations' });
        }
    });

    router.get('/integrations/events', authenticate, authorizeAdmin, (_req, res) => {
        res.json(INTEGRATION_EVENTS);
    });

    router.post('/integrations', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            const { name, type, url, events, secret, enabled } = req.body;
            if (!name || !type || !url) return res.status(400).json({ error: 'name, type, url are required' });
            const integration = await IntegrationModel.create({
                name, type, url,
                events: events || [],
                secret: secret || '',
                enabled: enabled !== false,
                createdBy: req.user?.id
            });
            await addAuditLog(req.user?.id, req.user?.username, 'create', 'integration', String(integration._id), { name, type });
            res.status(201).json(integration);
        } catch (error) {
            res.status(500).json({ error: 'Failed to create integration' });
        }
    });

    // SMTP Settings
    // Keep these above /integrations/:id so "smtp" is not treated as an id.
    router.get('/integrations/smtp', authenticate, authorizeAdmin, async (_req, res) => {
        try {
            const settings = await SettingsModel.findOne().lean() as any;
            res.json(settings?.smtp || {});
        } catch (error) {
            logger.error('Failed to fetch SMTP settings:', error);
            res.status(500).json({ error: 'Failed to fetch SMTP settings' });
        }
    });

    router.put('/integrations/smtp', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            const { host, port, secure, user, pass, fromName, fromEmail } = req.body;
            await SettingsModel.findOneAndUpdate(
                {},
                { $set: { 'smtp.host': host, 'smtp.port': port, 'smtp.secure': secure, 'smtp.user': user, 'smtp.pass': pass, 'smtp.fromName': fromName, 'smtp.fromEmail': fromEmail } },
                { upsert: true }
            );
            await addAuditLog(req.user?.userId, req.user?.username, 'update', 'smtp-settings');
            res.json({ success: true });
        } catch (error) {
            logger.error('Failed to save SMTP settings:', error);
            res.status(500).json({ error: 'Failed to save SMTP settings' });
        }
    });

    router.post('/integrations/smtp/test', authenticate, authorizeAdmin, async (_req, res) => {
        try {
            const settings = await SettingsModel.findOne().lean() as any;
            const smtp = settings?.smtp;
            if (!smtp?.host || !smtp?.user || !smtp?.pass) {
                return res.status(400).json({ error: 'SMTP not fully configured' });
            }
            const nodemailer = await import('nodemailer');
            const transporter = nodemailer.default.createTransport({
                host: smtp.host, port: smtp.port || 587,
                secure: smtp.secure || false,
                auth: { user: smtp.user, pass: smtp.pass }
            });
            await transporter.verify();
            res.json({ success: true, message: 'SMTP connection verified successfully' });
        } catch (error: any) {
            logger.error('SMTP connection test failed:', error);
            res.status(400).json({ error: error.message || 'SMTP connection failed' });
        }
    });

    router.put('/integrations/:id', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            const { name, type, url, events, secret, enabled } = req.body;
            const integration = await IntegrationModel.findByIdAndUpdate(
                req.params.id,
                { name, type, url, events, secret, enabled },
                { new: true }
            );
            if (!integration) return res.status(404).json({ error: 'Not found' });
            await addAuditLog(req.user?.id, req.user?.username, 'update', 'integration', req.params.id, { name });
            res.json(integration);
        } catch (error) {
            res.status(500).json({ error: 'Failed to update integration' });
        }
    });

    router.delete('/integrations/:id', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            await IntegrationModel.findByIdAndDelete(req.params.id);
            await addAuditLog(req.user?.id, req.user?.username, 'delete', 'integration', req.params.id);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Failed to delete integration' });
        }
    });

    // Test-fire an integration manually
    router.post('/integrations/:id/test', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const integration = await IntegrationModel.findById(req.params.id).lean();
            if (!integration) return res.status(404).json({ error: 'Not found' });
            const testPayload = { phoneNumber: 'test-number', body: 'Test event fired from admin panel', name: 'Test Campaign', sentCount: 10, failedCount: 2 };
            await fireEvent(integration.events[0] as any || 'message.received', testPayload);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Test failed' });
        }
    });

    // Auto-Reply Rules
    router.get('/auto-reply', authenticate, authorizeAdmin, async (_req, res) => {
        try {
            const rules = await AutoReplyModel.find().sort({ priority: -1, createdAt: 1 }).lean();
            res.json(rules);
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch auto-reply rules' });
        }
    });

    router.post('/auto-reply', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            const { name, matchType, trigger, response, useAI, aiProvider, aiPrompt, cooldownMinutes, priority, enabled } = req.body;
            if (!name || !trigger) return res.status(400).json({ error: 'name and trigger are required' });
            const rule = await AutoReplyModel.create({
                name, matchType: matchType || 'contains', trigger,
                response: response || '',
                useAI: useAI || false,
                aiProvider: aiProvider || 'none',
                aiPrompt: aiPrompt || '',
                cooldownMinutes: cooldownMinutes ?? 60,
                priority: priority ?? 0,
                enabled: enabled !== false,
                createdBy: req.user?.id
            });
            await addAuditLog(req.user?.id, req.user?.username, 'create', 'auto-reply', String(rule._id), { name });
            res.status(201).json(rule);
        } catch (error) {
            res.status(500).json({ error: 'Failed to create auto-reply rule' });
        }
    });

    router.put('/auto-reply/:id', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            const rule = await AutoReplyModel.findByIdAndUpdate(req.params.id, req.body, { new: true });
            if (!rule) return res.status(404).json({ error: 'Not found' });
            await addAuditLog(req.user?.id, req.user?.username, 'update', 'auto-reply', req.params.id, { name: rule.name });
            res.json(rule);
        } catch (error) {
            res.status(500).json({ error: 'Failed to update auto-reply rule' });
        }
    });

    router.delete('/auto-reply/:id', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            await AutoReplyModel.findByIdAndDelete(req.params.id);
            await addAuditLog(req.user?.id, req.user?.username, 'delete', 'auto-reply', req.params.id);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Failed to delete auto-reply rule' });
        }
    });

    // Inbound API
    // External systems can POST here to send a WhatsApp message, no login needed — API key required
    router.post('/inbound/send', async (req, res) => {
        try {
            const apiKey = req.headers['x-api-key'] as string || req.body.apiKey;
            if (!apiKey) return res.status(401).json({ error: 'API key required' });

            const settings = await SettingsModel.findOne().lean() as any;
            if (!settings?.inboundApiKey || settings.inboundApiKey !== apiKey) {
                return res.status(403).json({ error: 'Invalid API key' });
            }

            const { phoneNumber, message } = req.body;
            if (!phoneNumber || !message) return res.status(400).json({ error: 'phoneNumber and message required' });

            const formattedNumber = phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@c.us`;
            await botManager.client.sendMessage(formattedNumber, message);
            res.json({ success: true });
        } catch (error) {
            logger.error('Inbound API send failed:', error);
            res.status(500).json({ error: 'Failed to send message' });
        }
    });

    // Groups / Recap

    // GET /crm/groups — distinct groups known from persisted messages
    router.get('/groups', authenticate, authorizeAdmin, async (_req, res) => {
        try {
            const groups = await MessageModel.aggregate([
                { $match: { isGroup: true, groupId: { $exists: true, $ne: null } } },
                { $group: { _id: '$groupId', count: { $sum: 1 }, lastMessage: { $max: '$timestamp' } } },
                { $sort: { lastMessage: -1 } },
            ]);

            // Resolve group names from the live WhatsApp client where possible
            const result = await Promise.all(groups.map(async (g) => {
                let name = g._id;
                try {
                    const waChat = await botManager.client.getChatById(g._id);
                    if (waChat?.name) name = waChat.name;
                } catch (_) { /* client may not be connected */ }
                return { id: g._id, name, count: g.count, lastMessage: g.lastMessage };
            }));

            res.json(result);
        } catch (error) {
            logger.error('GET /groups error:', error);
            res.status(500).json({ error: 'Failed to fetch groups' });
        }
    });

    // POST /crm/groups/:groupId/recap — AI summary of group messages for a period
    router.post('/groups/:groupId/recap', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            const { groupId } = req.params;
            const { period = '24h' } = req.body;

            // Parse period string (e.g. "6h", "2d", "1w")
            const match = (period as string).match(/^(\d+)(h|d|w)$/);
            let ms = 24 * 3600 * 1000;
            let label = 'last 24 hours';
            if (match) {
                const n = parseInt(match[1], 10);
                const unit = match[2];
                if (unit === 'h') { ms = n * 3600 * 1000; label = `last ${n} hour${n === 1 ? '' : 's'}`; }
                else if (unit === 'd') { ms = n * 24 * 3600 * 1000; label = `last ${n} day${n === 1 ? '' : 's'}`; }
                else { ms = n * 7 * 24 * 3600 * 1000; label = `last ${n} week${n === 1 ? '' : 's'}`; }
            }
            const cutoff = new Date(Date.now() - ms);

            const messages = await MessageModel.find({
                groupId,
                isGroup: true,
                timestamp: { $gte: cutoff },
            }).sort({ timestamp: 1 }).lean();

            if (!messages.length) {
                return res.json({ summary: null, count: 0, label });
            }

            // Build transcript
            const transcript = messages.map(m => {
                const t = new Date(m.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                return `[${t}] ${m.senderName || m.phoneNumber}: ${m.body}`;
            }).join('\n');

            // Resolve group name
            let groupName = groupId;
            try {
                const waChat = await botManager.client.getChatById(groupId);
                if (waChat?.name) groupName = waChat.name;
            } catch (_) { /* ignore */ }

            // Pick AI provider from settings (same setting as audio AI command)
            const settings = await SettingsModel.findOne().lean() as any;
            const provider: string = settings?.defaultAudioAiCommand || 'chat';

            const prompt = `You are summarising the WhatsApp group "${groupName}".
Below is a transcript of the conversation from the ${label} (${messages.length} messages).
Each line is formatted as: [HH:MM] Name: message

Provide a structured summary using **bold** section headers. When attributing a topic, decision, or statement to someone, always mention them by name (e.g. "Alice raised...", "Bob and Carol agreed on..."). Only use names that appear in the transcript — do not invent or assume names.

**Participants**
List every person who sent at least one message.

**Main topics discussed**
For each topic, note who raised or drove it.

**Key decisions or conclusions**
Attribute decisions to the people who made them.

**Important announcements**
Note who announced what.

**Notable exchanges**
Highlight any significant back-and-forth between specific people.

Skip any section with nothing to report. Keep the total under 500 words. Be concise and factual.

Transcript:
${transcript}`;

            let summary = '';
            if (provider === 'gpt') {
                const result = await chatGptCompletion(prompt);
                summary = result.choices[0]?.message?.content || '';
            } else if (provider === 'claude') {
                const result = await claudeCompletion(
                    prompt,
                    'You are a helpful assistant that summarises group conversations.'
                );
                summary = result?.content?.find((c: any) => c.type === 'text')?.text || '';
            } else {
                const result = await geminiCompletion(prompt);
                summary = result.response.text() || '';
            }

            res.json({ summary: summary.trim(), count: messages.length, label, groupName, provider });
        } catch (error) {
            logger.error('POST /groups/:groupId/recap error:', error);
            res.status(500).json({ error: 'Failed to generate recap' });
        }
    });

    // ── Widget Settings ────────────────────────────────────────────
    router.get('/widget-settings', authenticate, authorizeAdmin, async (_req, res) => {
        try {
            let settings = await WidgetSettingsModel.findOne();
            if (!settings) settings = await WidgetSettingsModel.create({});
            res.json(settings);
        } catch (error) {
            logger.error('GET /widget-settings error:', error);
            res.status(500).json({ error: 'Failed to fetch widget settings' });
        }
    });

    router.put('/widget-settings', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            const allowed = [
                'enabled', 'buttonStyle', 'displayPosition', 'primaryColor', 'secondaryColor',
                'headerText', 'operatorName', 'welcomeMessage', 'onlineMessage', 'offlineMessage',
                'placeholderText', 'logoUrl', 'trackVisitorIp', 'allowedDomains',
                'whatsappMode', 'whatsappNumber',
            ];
            const update: Record<string, any> = {};
            for (const f of allowed) { if (f in req.body) update[f] = req.body[f]; }
            const settings = await WidgetSettingsModel.findOneAndUpdate({}, update, { upsert: true, new: true });
            await addAuditLog(req.user?.id, req.user?.username, 'update', 'widget-settings');
            res.json(settings);
        } catch (error) {
            logger.error('PUT /widget-settings error:', error);
            res.status(500).json({ error: 'Failed to update widget settings' });
        }
    });

    router.post('/widget-settings/rotate-id', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            const newId = crypto.randomBytes(12).toString('hex');
            const settings = await WidgetSettingsModel.findOneAndUpdate({}, { widgetId: newId }, { upsert: true, new: true });
            await addAuditLog(req.user?.id, req.user?.username, 'rotate', 'widget-id');
            res.json({ widgetId: settings!.widgetId });
        } catch (error) {
            res.status(500).json({ error: 'Failed to rotate widget ID' });
        }
    });

    // ── Widget CORS helper ─────────────────────────────────────────
    // Returns false and sends 403 only when allowedDomains is set and origin doesn't match.
    function applyWidgetCors(req: any, res: any, allowedDomains: string[] = []): boolean {
        const origin: string = req.headers.origin || '';
        let allowOrigin = '*';

        if (allowedDomains.length > 0) {
            const matched = allowedDomains.some(d => {
                const domain = d.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
                return origin.replace(/^https?:\/\//, '').replace(/\/$/, '') === domain
                    || origin.endsWith('.' + domain);
            });
            if (!matched && origin) {
                res.status(403).json({ error: 'Origin not allowed' });
                return false;
            }
            allowOrigin = origin || '*';
        }

        res.setHeader('Access-Control-Allow-Origin', allowOrigin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (allowOrigin !== '*') res.setHeader('Vary', 'Origin');
        return true;
    }

    // Preflight for POST /widget/chat (browser sends OPTIONS before POST with JSON)
    router.options('/widget/chat', (req, res) => {
        applyWidgetCors(req, res);
        res.sendStatus(204);
    });

    // Public: get safe widget config (called by the embeddable snippet)
    router.get('/widget/config/:widgetId', async (req, res) => {
        try {
            const s = await WidgetSettingsModel.findOne({ widgetId: req.params.widgetId }).lean() as any;
            if (!s || !s.enabled) return res.status(404).json({ error: 'Widget not found or disabled' });
            if (!applyWidgetCors(req, res, s.allowedDomains)) return;
            const { primaryColor, secondaryColor, headerText, operatorName, welcomeMessage,
                    onlineMessage, offlineMessage, placeholderText, logoUrl,
                    buttonStyle, displayPosition, whatsappMode, whatsappNumber } = s;
            res.json({ primaryColor, secondaryColor, headerText, operatorName, welcomeMessage,
                       onlineMessage, offlineMessage, placeholderText, logoUrl,
                       buttonStyle, displayPosition, whatsappMode, whatsappNumber });
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch widget config' });
        }
    });

    // Public: submit message from widget visitor
    const widgetChatLimiter = rateLimit({
        windowMs: 60 * 1000, // 1 dakika
        max: 10,
        message: { error: 'Çok fazla mesaj gönderdiniz. Lütfen bekleyin.' },
    });
    router.post('/widget/chat', widgetChatLimiter, async (req, res) => {
        try {
            const { widgetId, visitorName, visitorSessionId, message, pageUrl } = req.body;
            if (!widgetId || !message?.trim()) {
                return res.status(400).json({ error: 'widgetId and message are required' });
            }
            const s = await WidgetSettingsModel.findOne({ widgetId }).lean() as any;
            if (!s || !s.enabled) return res.status(404).json({ error: 'Widget not found or disabled' });
            if (!applyWidgetCors(req, res, s.allowedDomains)) return;

            const visitorIp = s.trackVisitorIp
                ? ((req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown').split(',')[0].trim()
                : undefined;

            const sessionKey = visitorSessionId ? visitorSessionId.slice(0, 20).replace(/[^a-z0-9]/gi, '') : 'anon';
            const phoneNumber = `widget_${widgetId.slice(0, 8)}_${sessionKey}`;

            const saved = await MessageModel.create({
                phoneNumber,
                body: message.trim(),
                type: 'text',
                direction: 'in',
                sentVia: 'widget',
                read: false,
                senderName: visitorName || 'Website Visitor',
                visitorIp,
                pageUrl: pageUrl || '',
                timestamp: new Date(),
            });

            messageEmitter.emit('message', saved.toObject());
            res.json({ success: true, messageId: saved._id, phoneNumber });
        } catch (error) {
            logger.error('POST /widget/chat error:', error);
            res.status(500).json({ error: 'Failed to send message' });
        }
    });

    // Public: poll for replies (widget uses this to show admin replies)
    router.get('/widget/replies/:phoneNumber', async (req, res) => {
        try {
            // Fetch widget settings via widgetId query param so we can apply CORS correctly
            const widgetId = req.query.widgetId as string | undefined;
            let allowedDomains: string[] = [];
            if (widgetId) {
                const s = await WidgetSettingsModel.findOne({ widgetId }).lean() as any;
                if (s) allowedDomains = s.allowedDomains || [];
            }
            if (!applyWidgetCors(req, res, allowedDomains)) return;

            const { phoneNumber } = req.params;
            const since = req.query.since ? new Date(req.query.since as string) : new Date(0);
            const msgs = await MessageModel.find({
                phoneNumber,
                direction: 'out',
                timestamp: { $gt: since },
            }).sort({ timestamp: 1 }).lean();
            res.json(msgs);
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch replies' });
        }
    });

    // Get / rotate inbound API key (admin only)
    router.get('/inbound/api-key', authenticate, authorizeAdmin, async (_req, res) => {
        try {
            const settings = await SettingsModel.findOne().lean() as any;
            res.json({ inboundApiKey: settings?.inboundApiKey || '' });
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch API key' });
        }
    });

    router.post('/inbound/api-key/rotate', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            const newKey = crypto.randomBytes(24).toString('hex');
            await SettingsModel.findOneAndUpdate({}, { inboundApiKey: newKey }, { upsert: true });
            await addAuditLog(req.user?.id, req.user?.username, 'rotate', 'inbound-api-key');
            res.json({ inboundApiKey: newKey });
        } catch (error) {
            res.status(500).json({ error: 'Failed to rotate API key' });
        }
    });

    // ─── Flows ────────────────────────────────────────────────────────────────

    router.get('/flows', authenticate, authorizeAdmin, async (_req, res) => {
        try {
            const flows = await FlowModel.find().sort({ createdAt: -1 }).lean();
            res.json(flows);
        } catch { res.status(500).json({ error: 'Failed to load flows' }); }
    });

    router.post('/flows', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            const { name, description, trigger, nodes, edges, status } = req.body;
            const flow = await FlowModel.create({ name, description, trigger, nodes: nodes || [], edges: edges || [], status: status || 'draft' });
            await addAuditLog(req.user?.id, req.user?.username, 'create', 'flow', String(flow._id), { name });
            res.status(201).json(flow);
        } catch { res.status(500).json({ error: 'Failed to create flow' }); }
    });

    // Static sub-routes MUST come before /:id to avoid Express treating them as IDs
    router.get('/flows/active-sessions', authenticate, authorizeAdmin, async (_req, res) => {
        try {
            const sessions = await FlowSessionModel.find({ status: 'active' })
                .populate('flowId', 'name')
                .sort({ lastActivityAt: -1 })
                .limit(100)
                .lean();
            res.json(sessions);
        } catch { res.status(500).json({ error: 'Failed to load sessions' }); }
    });

    router.delete('/flows/active-sessions/:sessionId', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            await FlowSessionModel.findByIdAndUpdate(req.params.sessionId, { status: 'cancelled' });
            res.json({ success: true });
        } catch { res.status(500).json({ error: 'Failed to cancel session' }); }
    });

    router.get('/flows/:id', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const flow = await FlowModel.findById(req.params.id).lean();
            if (!flow) return res.status(404).json({ error: 'Not found' });
            res.json(flow);
        } catch { res.status(500).json({ error: 'Failed to load flow' }); }
    });

    router.put('/flows/:id', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            const { name, description, trigger, nodes, edges, status } = req.body;
            const flow = await FlowModel.findByIdAndUpdate(
                req.params.id,
                { name, description, trigger, nodes, edges, status },
                { new: true }
            );
            if (!flow) return res.status(404).json({ error: 'Not found' });
            await addAuditLog(req.user?.id, req.user?.username, 'update', 'flow', req.params.id, { name });
            res.json(flow);
        } catch { res.status(500).json({ error: 'Failed to update flow' }); }
    });

    router.delete('/flows/:id', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            await FlowModel.findByIdAndDelete(req.params.id);
            await FlowSessionModel.updateMany({ flowId: req.params.id, status: 'active' }, { status: 'cancelled' });
            await addAuditLog(req.user?.id, req.user?.username, 'delete', 'flow', req.params.id);
            res.json({ success: true });
        } catch { res.status(500).json({ error: 'Failed to delete flow' }); }
    });

    router.patch('/flows/:id/publish', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            const flow = await FlowModel.findById(req.params.id);
            if (!flow) return res.status(404).json({ error: 'Not found' });
            flow.status = flow.status === 'published' ? 'draft' : 'published';
            await flow.save();
            await addAuditLog(req.user?.id, req.user?.username, flow.status === 'published' ? 'publish' : 'unpublish', 'flow', req.params.id);
            res.json(flow);
        } catch { res.status(500).json({ error: 'Failed to toggle flow status' }); }
    });

    router.get('/flows/:id/analytics', authenticate, authorizeAdmin, async (req, res) => {
        try {
            const flow = await FlowModel.findById(req.params.id).lean();
            if (!flow) return res.status(404).json({ error: 'Not found' });
            // Per-node drop-off: count sessions that last stopped at each nodeId
            const dropoffs = await FlowSessionModel.aggregate([
                { $match: { flowId: flow._id, status: { $in: ['completed', 'timed_out', 'cancelled'] } } },
                { $group: { _id: '$currentNodeId', count: { $sum: 1 } } },
            ]);
            const activeSessions = await FlowSessionModel.countDocuments({ flowId: flow._id, status: 'active' });
            res.json({ stats: flow.stats, activeSessions, dropoffs });
        } catch { res.status(500).json({ error: 'Failed to load analytics' }); }
    });

    router.post('/flows/:id/test-send', authenticate, authorizeAdmin, async (req: any, res) => {
        try {
            const flow = await FlowModel.findById(req.params.id).lean();
            if (!flow) return res.status(404).json({ error: 'Not found' });
            const phone = req.body.phone?.replace(/\D/g, '');
            if (!phone) return res.status(400).json({ error: 'phone required' });
            // Cancel any existing test session for this phone+flow
            await FlowSessionModel.updateMany({ phoneNumber: phone, flowId: flow._id, status: 'active' }, { status: 'cancelled' });
            const triggerNode = flow.nodes.find(n => n.type === 'trigger');
            if (!triggerNode) return res.status(400).json({ error: 'Flow has no trigger node' });
            await FlowSessionModel.create({
                phoneNumber: phone, flowId: flow._id, currentNodeId: triggerNode.id,
                variables: {}, waitingForReply: false, pendingVariable: '', status: 'active',
                startedAt: new Date(), lastActivityAt: new Date(),
            });
            res.json({ success: true, message: 'Test session created — send a message from that phone to activate it' });
        } catch { res.status(500).json({ error: 'Failed to create test session' }); }
    });


    return router;
}
