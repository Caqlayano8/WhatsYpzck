/**
 * Author: Ç.Kurtoğlu
 * Description: Gemini Utility - Google Gemini API entegrasyonu
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import EnvConfig from "../../configs/env.config";
import logger from "../../configs/logger.config";

export type GeminiModel = "gemini-pro" | "gemini-1.5-pro" | "gemini-1.5-flash";

export const geminiCompletion = async (query: string, modelName: GeminiModel = "gemini-pro") => {
    const apiKey = process.env.GEMINI_API_KEY || EnvConfig.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not configured.");
    }

    try {
        logger.info(`[Gemini] API Key var mı? ${apiKey ? "✓" : "✗"}`);
        logger.info(`[Gemini] Model: ${modelName}`);
        logger.info(`[Gemini] Query: ${query.substring(0, 50)}...`);
        
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: modelName });
        
        logger.info(`[Gemini] Request gönderiliyor...`);
        const result = await model.generateContent([query]);
        
        logger.info(`[Gemini] Başarılı yanıt alındı! ✓`);
        logger.info(`[Gemini] Response: ${result.response.text().substring(0, 100)}...`);
        
        return result;
    } catch (error) {
        logger.error(`[Gemini] ❌ HATA DETAY:`, {
            name: error?.name,
            message: error?.message,
            status: error?.status,
            toString: error?.toString()
        });
        throw error;
    }
};
