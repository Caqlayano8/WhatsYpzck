/**
 * Author: Ç.Kurtoğlu
 * Description: Kullanıcıyı selamlar ve destek akışına başlatır
 */

import { Message } from "whatsapp-web.js";
import { UserI18n } from "../utils/content/i18n.util";

export const run = async (
    message: Message,
    args: string[] = [],
    userI18n: UserI18n
) => {
    void message;
    void args;
    void userI18n;
    // Ana menü mesajı bot.manager.ts tarafından bu komutun ardından gönderilmektedir.
    // Burada ek bir mesaj gönderilmesine gerek yoktur.
};
