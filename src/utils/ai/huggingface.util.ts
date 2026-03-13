/**
 * Author: Ç.Kurtoğlu
 * Description: Hugging Face API entegrasyonu - AI sohbet desteği
 */

import axios from "axios";
import logger from "../../configs/logger.config";

export const huggingFaceChat = async (message: string, conversationHistory: string[] = []) => {
    const apiKey = process.env.HUGGINGFACE_API_KEY;
    
    if (!apiKey) {
        throw new Error("HUGGINGFACE_API_KEY is not configured in .env file");
    }

    try {
        // Conversation context oluştur
        const context = conversationHistory.length > 0 
            ? conversationHistory.join("\n") + "\nSon soru: " + message
            : message;

        logger.info(`[HF] İstek gönderiliyor: "${message.substring(0, 50)}..."`);

        // Hugging Face API çağrısı
        const response = await axios.post(
            "https://api-inference.huggingface.co/models/google/flan-t5-base",
            {
                inputs: context,
                parameters: {
                    max_length: 512
                },
                wait_for_model: true
            },
            {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json"
                },
                timeout: 60000
            }
        );

        const result = response.data?.[0]?.generated_text || "";
        
        if (!result) {
            throw new Error("Boş yanıt alındı");
        }

        logger.info(`[HF] Yanıt alındı ✓: "${result.substring(0, 50)}..."`);

        return result;

    } catch (error) {
        logger.error(`[HF] ❌ Hata:`, {
            message: error?.message,
            status: error?.response?.status,
            statusText: error?.response?.statusText
        });
        throw error;
    }
};
