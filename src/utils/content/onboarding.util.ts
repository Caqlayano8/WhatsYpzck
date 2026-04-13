/**
 * Author: Ç.Kurtoğlu
 * Description: Onboarding Utility - Kullanıcı tanıtım süreci
 */

import { Chat, Message, MessageMedia } from "whatsapp-web.js"
import { AppConfig } from "../../configs/app.config";
import { UserI18n } from "./i18n.util";
import fs from "fs";

const isUserOnboarded = async (chat: Chat) => {
    const messages: Message[] = await chat.fetchMessages({
        fromMe: true,
        limit: 2
    });
    return messages.length != 0;
}

export const onboard = async (message: Message, userI18n: UserI18n, autoOnboard: boolean = true, filePath = AppConfig.instance.getOnboardingVideoPath()) => {
    let chat: Chat | null = null;

    try {
        chat = await message.getChat();

        if (autoOnboard && await isUserOnboarded(chat)) {
            return;
        }

        if (chat) await chat.sendStateTyping();
        const caption = userI18n.t('onboardMessages.caption', { botName: AppConfig.instance.getBotName() });
        const pleaseHelp = userI18n.t('onboardMessages.pleaseHelp', { prefix: AppConfig.instance.getBotPrefix() });

        if (!filePath || !fs.existsSync(filePath)) {
            await message.reply(`${caption}\n\n${pleaseHelp}`);
            return;
        }

        const media = MessageMedia.fromFilePath(filePath);
        await message.reply(media, null, {
            caption: `${caption}\n\n${pleaseHelp}`,
        });
    } catch (_error) {
        // Onboarding aksasa bile asıl mesaj işleme akışı devam etsin.
        return;
    } finally {
        if (chat) await chat.clearState().catch(() => {});
    }
}
