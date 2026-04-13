import { SettingsModel } from '../../crm/models/settings.model';
import EnvConfig from '../../configs/env.config';
import logger from '../../configs/logger.config';

export async function sendMailWithAttachment(opts: {
    subject: string;
    textBody: string;
    recipients: string;
    attachment?: { filePath: string; fileName: string; contentType?: string };
}): Promise<boolean> {
    const { subject, textBody, recipients, attachment } = opts;
    if (!recipients.trim()) return false;

    const settingsDoc = await SettingsModel.findOne().lean() as any;
    const smtpDb = settingsDoc?.smtp || {};

    const smtp = {
        host:      smtpDb.host      || EnvConfig.SMTP_HOST      || '',
        port:      Number(smtpDb.port || EnvConfig.SMTP_PORT    || 587),
        secure:    smtpDb.secure !== undefined ? smtpDb.secure : (EnvConfig.SMTP_SECURE === 'true'),
        user:      smtpDb.user      || EnvConfig.SMTP_USER      || '',
        pass:      smtpDb.pass      || EnvConfig.SMTP_PASS      || '',
        fromName:  smtpDb.fromName  || EnvConfig.SMTP_FROM_NAME  || 'WhatsYpzck',
        fromEmail: smtpDb.fromEmail || EnvConfig.SMTP_FROM_EMAIL || '',
    };

    if (smtp.host && smtp.user && smtp.pass) {
        try {
            const nodemailer = await import('nodemailer');
            const transporter = nodemailer.default.createTransport({
                host:   smtp.host,
                port:   smtp.port,
                secure: smtp.secure,
                auth:   { user: smtp.user, pass: smtp.pass },
            });
            const from = smtp.fromEmail
                ? `"${smtp.fromName}" <${smtp.fromEmail}>`
                : smtp.user;
            await transporter.sendMail({
                from,
                to: recipients,
                subject,
                text: textBody,
                ...(attachment ? {
                    attachments: [{
                        filename:    attachment.fileName,
                        path:        attachment.filePath,
                        contentType: attachment.contentType || 'application/octet-stream',
                    }],
                } : {}),
            });
            return true;
        } catch (err) {
            logger.error('Mail gonderimi basarisiz:', err);
        }
    }

    // Microsoft Graph fallback if configured
    const tenantId     = EnvConfig.M365_TENANT_ID;
    const clientId     = EnvConfig.M365_CLIENT_ID;
    const clientSecret = EnvConfig.M365_CLIENT_SECRET;
    const senderUpn    = EnvConfig.M365_SENDER_UPN;

    if (tenantId && clientId && clientSecret && senderUpn) {
        try {
            const axios = (await import('axios')).default;
            const tokenResp = await axios.post(
                `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
                new URLSearchParams({
                    grant_type:    'client_credentials',
                    client_id:     clientId,
                    client_secret: clientSecret,
                    scope:         'https://graph.microsoft.com/.default',
                }),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
            );
            const accessToken = tokenResp.data.access_token;

            const emailPayload: any = {
                message: {
                    subject,
                    body: { contentType: 'Text', content: textBody },
                    toRecipients: recipients
                        .split(',')
                        .map((r: string) => ({ emailAddress: { address: r.trim() } })),
                },
                saveToSentItems: false,
            };

            if (attachment) {
                const fs = await import('fs');
                const fileContent = fs.readFileSync(attachment.filePath).toString('base64');
                emailPayload.message.attachments = [{
                    '@odata.type': '#microsoft.graph.fileAttachment',
                    name:          attachment.fileName,
                    contentBytes:  fileContent,
                }];
            }

            await axios.post(
                `https://graph.microsoft.com/v1.0/users/${senderUpn}/sendMail`,
                emailPayload,
                { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
            );
            return true;
        } catch (graphErr) {
            logger.error('Mail gonderimi Graph ile basarisiz:', graphErr);
        }
    }

    return false;
}
