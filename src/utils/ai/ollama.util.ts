/**
 * Author: Ç.Kurtoğlu
 * Description: Ollama API entegrasyonu - Offline AI sohbet
 */

import axios from "axios";
import logger from "../../configs/logger.config";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const PREFERRED_MODEL = process.env.OLLAMA_MODEL || "mistral";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 90000);
const OLLAMA_NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT || 72);
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 768);
const OLLAMA_TEMPERATURE = Number(process.env.OLLAMA_TEMPERATURE || 0.2);
const OLLAMA_TOP_P = Number(process.env.OLLAMA_TOP_P || 0.9);
const OLLAMA_NUM_GPU = Number(process.env.OLLAMA_NUM_GPU || -1);
const OLLAMA_NUM_THREAD = Number(process.env.OLLAMA_NUM_THREAD || 0);

let cachedModelName: string | null = null;
let modelCacheAt = 0;

type OllamaTagsResponse = {
    models?: Array<{ name: string; model?: string }>;
};

const resolveModelName = async (): Promise<string> => {
    // Cache model lookup for 60s to avoid calling /api/tags on every message.
    if (cachedModelName && Date.now() - modelCacheAt < 60000) {
        return cachedModelName;
    }

    try {
        const { data } = await axios.get<OllamaTagsResponse>(`${OLLAMA_BASE_URL}/api/tags`, {
            timeout: 15000
        });

        const available = (data.models || []).map((m) => m.name || m.model).filter(Boolean) as string[];
        if (!available.length) {
            cachedModelName = PREFERRED_MODEL;
            modelCacheAt = Date.now();
            return cachedModelName;
        }

        if (available.includes(PREFERRED_MODEL)) {
            cachedModelName = PREFERRED_MODEL;
            modelCacheAt = Date.now();
            return cachedModelName;
        }

        logger.warn(`[Ollama] Tercih edilen model kurulu degil (${PREFERRED_MODEL}). Otomatik model secildi: ${available[0]}`);
        cachedModelName = available[0];
        modelCacheAt = Date.now();
        return cachedModelName;
    } catch (err) {
        logger.warn("[Ollama] Model listesi alinamadi, varsayilan model kullanilacak:", err?.message || err);
        cachedModelName = PREFERRED_MODEL;
        modelCacheAt = Date.now();
        return cachedModelName;
    }
};

export const ollamaChat = async (message: string, systemPrompt?: string) => {
    try {
        const modelName = await resolveModelName();
        logger.info(`[Ollama] İstek gönderiliyor: "${message.substring(0, 50)}..."`);
        logger.info(`[Ollama] Model: ${modelName}`);

        const finalPrompt = systemPrompt
            ? `${systemPrompt}\n\nKullanici mesaji:\n${message}\n\nTemsilci cevabi:`
            : message;

        const options: Record<string, number> = {
            temperature: OLLAMA_TEMPERATURE,
            top_p: OLLAMA_TOP_P,
            num_predict: OLLAMA_NUM_PREDICT,
            num_ctx: OLLAMA_NUM_CTX,
            repeat_penalty: 1.1
        };

        if (OLLAMA_NUM_GPU >= 0) {
            options.num_gpu = OLLAMA_NUM_GPU;
        }
        if (OLLAMA_NUM_THREAD > 0) {
            options.num_thread = OLLAMA_NUM_THREAD;
        }

        const response = await axios.post(
            `${OLLAMA_BASE_URL}/api/generate`,
            {
                model: modelName,
                prompt: finalPrompt,
                stream: false,
                options
            },
            {
                timeout: OLLAMA_TIMEOUT_MS
            }
        );

        const result = response.data?.response || "";
        const cleaned = String(result).replace(/\n{3,}/g, "\n\n").trim();

        if (!cleaned) {
            throw new Error("Boş yanıt alındı");
        }

        logger.info(`[Ollama] Yanıt alındı ✓: "${cleaned.substring(0, 50)}..."`);
        return cleaned;

    } catch (error) {
        if (error?.code === "ECONNABORTED") {
            logger.error(`[Ollama] ❌ Zaman asimi (${OLLAMA_TIMEOUT_MS}ms)`);
            throw new Error("OLLAMA_TIMEOUT");
        }

        if (error?.code === "ECONNREFUSED") {
            logger.error(`[Ollama] ❌ Bağlantı hatası - Ollama çalışıyor mu? (http://localhost:11434)`);
        } else {
            logger.error(`[Ollama] ❌ Hata:`, {
                message: error?.message,
                status: error?.response?.status,
                code: error?.code
            });
        }
        throw error;
    }
};
