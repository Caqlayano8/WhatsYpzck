/**
 * Author: Ç.Kurtoğlu
 * Description: Kullanıcıyı sade ve güvenilir bir şekilde selamlar
 */

import { Message } from "whatsapp-web.js";
import { UserI18n } from "../utils/content/i18n.util";

export const run = async (
    message: Message,
    _args: string[] = null,
    _userI18n: UserI18n
) => {
    try {
        const now = new Date();
        const hour = Number(new Intl.DateTimeFormat("tr-TR", {
            timeZone: "Europe/Istanbul",
            hour: "2-digit",
            hour12: false
        }).format(now));
        const dayGreeting = hour < 12 ? "Gunaydin" : hour < 18 ? "Iyi gunler" : "Iyi aksamlar";

        const contact = await message.getContact();
        const name = contact.pushname || "Sayın Müşterimiz";

        const replyMessage = ` ${dayGreeting}, ${name}!

Bizimle iletişime geçtiğiniz için teşekkür ederiz.

Ben WhatsYpzck Destek Asistanınız 
Size yardımcı olabilmemiz için adınızı, soyadınızı, telefon numaranızı, adres bilgilerinizi ve yaşamış olduğunuz sorun veya taleplerinizi iletebilirsiniz.

Nasıl yardımcı olabilirim?`;

        await message.reply(replyMessage);

    } catch (error) {
        console.error("Merhaba komutu hatası:", error);
        await message.reply("> WhatsYpzck  : Bir hata oluştu.");
    }
};
