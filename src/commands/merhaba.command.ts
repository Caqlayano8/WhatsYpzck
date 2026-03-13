/**
 * Author: Ç.Kurtoğlu
 * Description: Kullanıcıyı selamlar, sabit bölge (Artvin + ilçeler) hava durumu bilgisi gösterir
 */

import { Message } from "whatsapp-web.js";
import { UserI18n } from "../utils/content/i18n.util";
import axios from "axios";
import logger from "../configs/logger.config";

export const run = async (
    message: Message,
    args: string[] = null,
    userI18n: UserI18n
) => {
    try {
        const now = new Date();
        const hour = Number(new Intl.DateTimeFormat("tr-TR", {
            timeZone: "Europe/Istanbul",
            hour: "2-digit",
            hour12: false
        }).format(now));
        const dayGreeting = hour < 12 ? "Gunaydin" : hour < 18 ? "Iyi gunler" : "Iyi aksamlar";

        // Mesajı gönderen kişiyi al
        const contact = await message.getContact();

        // Kullanıcı adı varsa al
        const name = contact.pushname || "Sayın Müşterimiz";

        let greeting = "Bizimle iletişime geçtiğiniz için Teşekkür ederiz";
        let weatherInfo = "";

        // Konumdan bağımsız, sabit bölge: Artvin merkez ve ilçeleri
        const weatherDescriptions: Record<number, string> = {
            0: "Açık", 1: "Az bulutlu", 2: "Parçalı bulutlu", 3: "Bulutlu",
            45: "Sisli", 48: "Kırağılı sisli",
            51: "Hafif yağmur", 53: "Orta yağmur", 55: "Yoğun yağmur",
            61: "Hafif sağanak", 63: "Orta sağanak", 65: "Kuvvetli sağanak",
            71: "Hafif kar", 73: "Orta kar", 75: "Yoğun kar",
            80: "Hafif sağanak", 81: "Orta sağanak", 82: "Kuvvetli sağanak",
            95: "Fırtına"
        };

        const artvinRegions = [
            { name: "Artvin Merkez", latitude: 41.1828, longitude: 41.8183 },
            { name: "Ardanuç", latitude: 41.1275, longitude: 42.0625 },
            { name: "Arhavi", latitude: 41.3512, longitude: 41.3069 },
            { name: "Borçka", latitude: 41.3570, longitude: 41.6658 },
            { name: "Hopa", latitude: 41.3905, longitude: 41.4221 },
            { name: "Kemalpaşa", latitude: 41.4842, longitude: 41.5279 },
            { name: "Murgul", latitude: 41.2796, longitude: 41.5609 },
            { name: "Şavşat", latitude: 41.2422, longitude: 42.3614 },
            { name: "Yusufeli", latitude: 40.8207, longitude: 41.5374 }
        ];

        try {
            const regionWeather = await Promise.all(
                artvinRegions.map(async (region) => {
                    try {
                        const response = await axios.get(
                            `https://api.open-meteo.com/v1/forecast?latitude=${region.latitude}&longitude=${region.longitude}&current=temperature_2m,weather_code&temperature_unit=celsius&timezone=auto`,
                            { timeout: 4500 }
                        );
                        const current = response.data?.current;
                        if (!current) {
                            return ` ${region.name}: veri yok`;
                        }

                        const temp = current.temperature_2m;
                        const code = current.weather_code;
                        const description = weatherDescriptions[code] || "Değişken";
                        return ` ${region.name}: ${temp}C, ${description}`;
                    } catch (_err) {
                        return ` ${region.name}: erişilemedi`;
                    }
                })
            );

            weatherInfo = [" Artvin ve İlçeleri Anlık Hava Durumu:", ...regionWeather].join("\n");
            logger.info("Artvin ve ilceleri icin hava durumu alindi");
        } catch (e) {
            logger.error("Konum/Hava durumu bilgisi alınamadı:", e.message);
            weatherInfo = " Artvin ve ilçeleri hava durumu şu an alınamıyor.";
        }

        // Cevap mesajı
        const replyMessage = ` ${dayGreeting}, ${name}!

${greeting}

Ben WhatsYpzck Destek Asistanınız 
Size yardımcı olabilmemiz için Adınızı, Soy adınızı, Telefon numaranızı, Adres bilgilerinizi ve yaşamış olduğunuz sorun veya taleplerinizi iletebilirsiniz.

 **Sistem Bilgileri:**
 Sabit Bölge: Artvin Merkez ve İlçeleri
${weatherInfo ? weatherInfo : ""}
 

Nasıl yardımcı olabilirim?`;

        await message.reply(replyMessage);

    } catch (error) {
        console.error("Merhaba komutu hatası:", error);
        await message.reply("> WhatsYpzck  : Bir hata oluştu.");
    }
};
