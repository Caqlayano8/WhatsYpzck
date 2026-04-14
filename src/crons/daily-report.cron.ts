import path from 'path';
import fs from 'fs';
import ExcelJS from 'exceljs';
import { IncidentModel } from '../crm/models/incident.model';
import { BotManager } from '../bot.manager';
import { sendMailWithAttachment } from '../utils/email/mailer.util';
import logger from '../configs/logger.config';

const STATUS_LABELS: Record<string, string> = {
    ALINDI:       'Alındı',
    INCELEMEDE:   'İncelemede',
    ISLEME_ALINDI:'İşleme Alındı',
    COZUMLENDI:   'Çözümlendi',
    KAPATILDI:    'Kapatıldı',
};

export async function sendDailyReport(botManager: BotManager): Promise<void> {
    try {
        const now = new Date();
        // Istanbul is UTC+3
        const trOffset = 3 * 60 * 60 * 1000;
        const trNow = new Date(now.getTime() + trOffset);

        const year  = trNow.getUTCFullYear();
        const month = trNow.getUTCMonth();
        const day   = trNow.getUTCDate();

        // Day boundaries in UTC representing 00:00–23:59 Istanbul time
        const dayStartUTC = new Date(Date.UTC(year, month, day, 0,  0,  0) - trOffset);
        const dayEndUTC   = new Date(Date.UTC(year, month, day, 23, 59, 59) - trOffset);

        const incidents = await IncidentModel.find({
            createdAt: { $gte: dayStartUTC, $lte: dayEndUTC },
        }).lean();

        const dateStr = `${String(day).padStart(2, '0')}.${String(month + 1).padStart(2, '0')}.${year}`;
        const count   = incidents.length;

        // Prepare reports directory
        const reportsDir = path.join(process.cwd(), 'public', 'reports', 'incidents');
        if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

        const fileName = `gunluk-rapor-${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}.xlsx`;
        const filePath = path.join(reportsDir, fileName);

        // Build Excel workbook
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'WhatsYpzck CRM';
        workbook.created = new Date();

        const sheet = workbook.addWorksheet('Günlük Arıza Raporu', {
            properties: { defaultColWidth: 20 },
        });

        sheet.columns = [
            { header: 'Talep No',         key: 'incidentId',    width: 22 },
            { header: 'Ad Soyad',         key: 'customerName',  width: 22 },
            { header: 'Telefon',          key: 'customerPhone', width: 18 },
            { header: 'Adres',            key: 'address',       width: 35 },
            { header: 'Abone No',         key: 'meterNo',       width: 18 },
            { header: 'Mail',             key: 'customerEmail', width: 28 },
            { header: 'Arıza Türü',       key: 'issueSummary',  width: 30 },
            { header: 'Durum',            key: 'status',        width: 18 },
            { header: 'Oluşturma Tarihi', key: 'createdAt',     width: 22 },
            { header: 'Koordinatlar',     key: 'coords',        width: 25 },
            { header: 'Fotoğraflar',      key: 'images',        width: 40 },
        ];

        const headerRow = sheet.getRow(1);
        headerRow.eachCell(cell => {
            cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
            cell.border    = {
                top:    { style: 'thin' },
                left:   { style: 'thin' },
                bottom: { style: 'thin' },
                right:  { style: 'thin' },
            };
        });
        headerRow.height = 22;

        incidents.forEach((inc, i) => {
            const coords = inc.locationCoords
                ? `${inc.locationCoords.lat}, ${inc.locationCoords.lng}`
                : (inc.photoCoords ? `${inc.photoCoords.lat}, ${inc.photoCoords.lng}` : '');

            const row = sheet.addRow({
                incidentId:    inc.incidentId,
                customerName:  inc.customerName,
                customerPhone: inc.customerPhone,
                address:       inc.address,
                meterNo:       inc.meterNo,
                customerEmail: inc.customerEmail || '',
                issueSummary:  inc.issueSummary  || 'Elektrik arızası bildirimi',
                status:        STATUS_LABELS[inc.status] || inc.status,
                createdAt:     inc.createdAt
                    ? new Date(inc.createdAt).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })
                    : '',
                coords,
                images: Array.isArray((inc as any).images) && (inc as any).images.length
                    ? (inc as any).images.map((u: string) => path.basename(u)).join('\n')
                    : '',
            });

            row.eachCell(cell => {
                cell.border = {
                    top:    { style: 'thin', color: { argb: 'FFE2E8F0' } },
                    left:   { style: 'thin', color: { argb: 'FFE2E8F0' } },
                    bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                    right:  { style: 'thin', color: { argb: 'FFE2E8F0' } },
                };
                if (i % 2 === 1) {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
                }
            });
        });

        await workbook.xlsx.writeFile(filePath);
        logger.info(`Gunluk rapor Excel olusturuldu: ${filePath}`);

        const managerPhone = (process.env.ARIZA_TEAM_WHATSAPP || '').replace(/\D/g, '').replace(/^0/, '90');
        const managerEmail = process.env.ARIZA_TEAM_EMAILS || '';

        const whatsappMsg = count > 0
            ? `📊 *Günlük Arıza Raporu* - ${dateStr}\n\nBugün toplam *${count}* arıza talebi alındı. Detaylar ekte.`
            : `📊 *Günlük Arıza Raporu* - ${dateStr}\n\nBugün arıza talebi alınmadı.`;

        // Send WhatsApp
        if (managerPhone && (botManager as any)?.client?.sendMessage) {
            try {
                if (count > 0) {
                    const { MessageMedia } = await import('whatsapp-web.js');
                    const fileBuffer = fs.readFileSync(filePath);
                    const media = new MessageMedia(
                        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                        fileBuffer.toString('base64'),
                        fileName,
                    );
                    await (botManager as any).client.sendMessage(`${managerPhone}@c.us`, media, { caption: whatsappMsg });
                } else {
                    await (botManager as any).client.sendMessage(`${managerPhone}@c.us`, whatsappMsg);
                }
                logger.info(`Gunluk rapor WhatsApp gonderildi: ${managerPhone}`);
            } catch (waErr) {
                logger.error('Gunluk rapor WhatsApp gonderilemedi:', waErr);
            }
        }

        // Send Email
        if (managerEmail) {
            const emailSubject = `Günlük Arıza Raporu - ${dateStr}`;
            const emailBody    = count > 0
                ? `Merhaba,\n\nBugün (${dateStr}) toplam ${count} arıza talebi alındı.\n\nDetaylı rapor ekte yer almaktadır.\n\nSaygılarımızla.`
                : `Merhaba,\n\nBugün (${dateStr}) herhangi bir arıza talebi alınmadı.\n\nSaygılarımızla.`;

            await sendMailWithAttachment({
                subject:    emailSubject,
                textBody:   emailBody,
                recipients: managerEmail,
                ...(count > 0 ? {
                    attachment: {
                        filePath,
                        fileName,
                        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    },
                } : {}),
            });
            logger.info(`Gunluk rapor e-posta gonderildi: ${managerEmail}`);
        }

        // Cleanup: remove Excel files older than 30 days
        try {
            const files = fs.readdirSync(reportsDir);
            const now2  = Date.now();
            files.forEach((f: string) => {
                if (!f.endsWith('.xlsx')) return;
                const fp   = path.join(reportsDir, f);
                const stat = fs.statSync(fp);
                if (now2 - stat.mtimeMs > 30 * 24 * 60 * 60 * 1000) {
                    fs.unlinkSync(fp);
                }
            });
        } catch (_) { /* non-critical */ }

    } catch (err) {
        logger.error('Gunluk rapor olusturulamadi:', err);
    }
}
