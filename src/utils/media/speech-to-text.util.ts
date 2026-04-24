/**
 * Author: Ç.Kurtoğlu
 * Description: Speech to Text Utility - Ses metine çevirme
 */

import logger from "../../configs/logger.config";

const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const { execFile } = require("child_process");
const { promisify } = require("util");
const sherpaOnnx = require("sherpa-onnx-node");

const execFileAsync = promisify(execFile);
let recognizerInstance: any = null;

function getCustomPhraseMap(): Record<string, string> {
    const raw = process.env.SHERPA_ONNX_STT_PHRASE_MAP || "";
    if (!raw) return {};

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return {};
        const result: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (!key || !value) continue;
            result[String(key)] = String(value);
        }
        return result;
    } catch {
        logger.warn("[STT] SHERPA_ONNX_STT_PHRASE_MAP parse edilemedi");
        return {};
    }
}

function applySttPhraseCorrections(text: string): string {
    let fixed = String(text || "").trim();
    if (!fixed) return fixed;

    // Normalize Turkish characters to ASCII for comparison, then restore.
    // This is needed because JS regex /gi does not equate Ç↔c, Ğ↔g, etc.
    const toAsciiTr = (s: string) => s
        .replace(/[Çç]/g, 'c')
        .replace(/[Ğğ]/g, 'g')
        .replace(/[İı]/g, 'i')
        .replace(/[Öö]/g, 'o')
        .replace(/[Şş]/g, 's')
        .replace(/[Üü]/g, 'u');

    const ascii = toAsciiTr(fixed);

    // Built-in proper-name drift corrections observed in Turkish voice notes.
    if (/\bcalayan\s+kurt(oglu|\s+olur)\b/i.test(ascii)) {
        fixed = fixed.replace(/\bÇalayan\s+[Kk]urt[a-zA-ZçğışöüÇĞİŞÖÜ\s]*/g, 'Çağlayan Kurtoğlu');
        fixed = fixed.replace(/\bcalayan\s+[Kk]urt[a-zA-ZçğışöüÇĞİŞÖÜ\s]*/gi, 'Çağlayan Kurtoğlu');
    }
    if (/\bcaglayan\s+kurt(oglu|\s+olur)\b/i.test(ascii)) {
        fixed = fixed.replace(/\b[cç]a[gğ]layan\s+kurt[a-zA-ZçğışöüÇĞİŞÖÜ\s]*/gi, 'Çağlayan Kurtoğlu');
    }

    // Optional runtime dictionary from env for project-specific corrections.
    const customMap = getCustomPhraseMap();
    for (const [from, to] of Object.entries(customMap)) {
        const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        fixed = fixed.replace(new RegExp(`\\b${escaped}\\b`, "gi"), to);
    }

    return fixed;
}

export function resetRecognizerInstance() {
    recognizerInstance = null;
}

export async function speechToText(file: string) {
    try {
        logger.info(`[STT] Başlıyor: ${file}`);
        const recognizer = getRecognizer();
        
        if (!recognizer) {
            logger.warn(`[STT] Recognizer null - STT modelleri yapılandırılmamış`);
            return { result: "[STT Model tanımlanmamış]" };
        }
        
        const normalizedPath = file.replace(/\.[^.]+$/, "") + ".stt.wav";

        logger.info(`[STT] FFmpeg çalışıyor: ${file} → ${normalizedPath}`);
        await execFileAsync(ffmpegPath, [
            "-y",
            "-i", file,
            "-ar", "16000",
            "-ac", "1",
            normalizedPath
        ]);
        
        // Check WAV file size
        const fs = require("fs");
        const stats = fs.statSync(normalizedPath);
        logger.info(`[STT] WAV dosya boyutu: ${stats.size} bytes`);
        logger.info(`[STT] FFmpeg tamamlandı`);

        logger.info(`[STT] Wave dosyası okunuyor`);
        const wave = sherpaOnnx.readWave(normalizedPath);
        logger.info(`[STT] Wave sample rate:`, wave?.sampleRate);
        logger.info(`[STT] Wave samples length:`, wave?.samples?.length);
        logger.info(`[STT] Wave okundu, stream oluşturuluyor`);
        
        const stream = recognizer.createStream();
        stream.acceptWaveform(wave);
        logger.info(`[STT] Stream state after acceptWaveform`);
        
        logger.info(`[STT] Decode işlemi başlıyor`);
        await recognizer.decodeAsync(stream);
        logger.info(`[STT] Decode tamamlandı`);
        
        const result = recognizer.getResult(stream);
        // sherpa-onnx native C++ object - properties are non-enumerable, access directly
        const correctedText = applySttPhraseCorrections(result?.text || "");
        if (correctedText && correctedText !== (result?.text || "")) {
            result.text = correctedText;
            logger.info(`[STT] corrected.text: "${correctedText}"`);
        }

        logger.info(`[STT] result.text: "${result?.text}"`);
        logger.info(`[STT] result.result: "${result?.result}"`);
        logger.info(`[STT] result.lang: "${result?.lang}"`);
        
        return result;
    } catch (error) {
        logger.error("[STT] Hata:", error);
        throw new Error(`Failed to transcribe audio: ${error}`);
    } finally {
        // Keep cleanup silent; the caller also deletes the original upload.
        try {
            const fs = require("fs");
            const normalizedPath = file.replace(/\.[^.]+$/, "") + ".stt.wav";
            if (fs.existsSync(normalizedPath)) {
                fs.unlinkSync(normalizedPath);
            }
        } catch (_) { /* ignore cleanup errors */ }
    }
}

function getRecognizer() {
    if (recognizerInstance) {
        return recognizerInstance;
    }

    const encoder = process.env.SHERPA_ONNX_ASR_ENCODER_PATH;
    const decoder = process.env.SHERPA_ONNX_ASR_DECODER_PATH;
    const tokens = process.env.SHERPA_ONNX_ASR_TOKENS_PATH;

    logger.info(`[STT-INIT] Encoder: ${encoder}`);
    logger.info(`[STT-INIT] Decoder: ${decoder}`);
    logger.info(`[STT-INIT] Tokens: ${tokens}`);
    logger.info(`[STT-INIT] Language: ${process.env.SHERPA_ONNX_ASR_LANGUAGE || 'not set'}`);

    if (!encoder || !decoder || !tokens) {
        logger.warn("[STT-INIT] Model paths tanımlanmamış! Fallback default yapılandırma kullanılıyor...");
        // Fallback: Sadece türkçe metin döndür test amacıyla
        return null;
    }

    const whisperConfig: any = {
        encoder,
        decoder,
        task: process.env.SHERPA_ONNX_ASR_TASK || "transcribe",
        language: process.env.SHERPA_ONNX_ASR_LANGUAGE || "tr"
    };

    logger.info(`[STT-INIT] Whisper config:`, JSON.stringify(whisperConfig));
    logger.info(`[STT-INIT] Recognizer oluşturuluyor...`);
    recognizerInstance = new sherpaOnnx.OfflineRecognizer({
        modelConfig: {
            whisper: whisperConfig,
            tokens,
            numThreads: parseInt(process.env.SHERPA_ONNX_NUM_THREADS || "1", 10),
            provider: process.env.SHERPA_ONNX_PROVIDER || "cpu"
        }
    });
    logger.info(`[STT-INIT] Recognizer başarıyla oluşturuldu`);

    return recognizerInstance;
}
