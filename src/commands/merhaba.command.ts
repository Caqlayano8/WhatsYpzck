/**
 * Author: C.Kurtoglu
 * Description: Kullaniciyi selamlar ve destek akisina baslatir
 */

import { Message } from "whatsapp-web.js";
import { UserI18n } from "../utils/content/i18n.util";
import { BotManager } from "../bot.manager";

export const run = async (
    message: Message,
    args: string[] = [],
    userI18n: UserI18n
) => {
    void args;
    void userI18n;

    try {
        const now = new Date();
        const hour = Number(new Intl.DateTimeFormat("tr-TR", {
            timeZone: "Europe/Istanbul",
            hour: "2-digit",
            hour12: false
        }).format(now));
        const dayGreeting = hour < 12 ? "Gunaydin" : hour < 18 ? "Iyi gunler" : "Iyi aksamlar";

        const contact = await message.getContact();
        const name = contact.pushname || "Sayin Musterimiz";

        const replyMessage = ` ${dayGreeting}, ${name}!

Bizimle iletisime gectiginiz icin tesekkur ederiz.

Ben WhatsYpzck Destek Asistaniniz.
Size yardimci olabilmemiz icin adinizi, soyadinizi, telefon numaranizi, adres bilgilerinizi ve yasadiginiz sorun veya talepleri iletebilirsiniz.

Sabit Bolge: Artvin Merkez ve Ilceleri

Nasil yardimci olabilirim?`;

        try {
            const bot = BotManager.getInstance();
            if (bot?.client && typeof bot.client.sendMessage === "function" && message?.from) {
                await bot.client.sendMessage(message.from, replyMessage);
                return;
            }
        } catch (_) {
            // fallback below
        }

        try {
            const chat = await message.getChat();
            if (chat && typeof (chat as any).sendMessage === "function") {
                await (chat as any).sendMessage(replyMessage);
                return;
            }
        } catch (_) {
            // fallback below
        }

        await message.reply(replyMessage);
    } catch (_error) {
        try {
            const bot = BotManager.getInstance();
            if (bot?.client && typeof bot.client.sendMessage === "function" && message?.from) {
                await bot.client.sendMessage(message.from, "> WhatsYpzck  : Bir hata olustu.");
                return;
            }
        } catch (_) {
            // fallback below
        }
        try {
            const chat = await message.getChat();
            if (chat && typeof (chat as any).sendMessage === "function") {
                await (chat as any).sendMessage("> WhatsYpzck  : Bir hata olustu.");
                return;
            }
        } catch (_) {
            // fallback below
        }
        await message.reply("> WhatsYpzck  : Bir hata olustu.");
    }
};
