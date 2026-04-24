const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Last voice file
const voiceFile = "C:\\Users\\34116\\Desktop\\WhatsYpzck\\public\\uploads\\voice-temp\\905458966096\\1776840829514.ogg";
const wavFile = voiceFile.replace(".ogg", ".wav");

console.log("[TEST] Voice file:", voiceFile);
console.log("[TEST] Exists?", fs.existsSync(voiceFile));

// 1. FFmpeg OGG → WAV
console.log("[TEST] Converting OGG to WAV...");
try {
    const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
    execSync(`"${ffmpegPath}" -y -i "${voiceFile}" -ar 16000 -ac 1 "${wavFile}"`, {
        stdio: "inherit"
    });
    console.log("[TEST] Conversion done!");
    
    const stats = fs.statSync(wavFile);
    console.log("[TEST] WAV file size:", stats.size, "bytes");
} catch (e) {
    console.error("[TEST] FFmpeg error:", e.message);
    process.exit(1);
}

// 2. Try sherpa-onnx directly
console.log("[TEST] Testing sherpa-onnx...");
try {
    const sherpaOnnx = require("sherpa-onnx-node");
    
    console.log("[TEST] Reading wave...");
    const wave = sherpaOnnx.readWave(wavFile);
    console.log("[TEST] Wave sample rate:", wave?.sampleRate);
    console.log("[TEST] Wave samples length:", wave?.samples?.length);
    
    // Check env vars
    const encoder = process.env.SHERPA_ONNX_ASR_ENCODER_PATH;
    const decoder = process.env.SHERPA_ONNX_ASR_DECODER_PATH;
    const tokens = process.env.SHERPA_ONNX_ASR_TOKENS_PATH;
    
    console.log("[TEST] Encoder env:", encoder);
    console.log("[TEST] Decoder env:", decoder);
    console.log("[TEST] Tokens env:", tokens);
    
    if (!encoder || !decoder || !tokens) {
        console.log("[TEST] ❌ Model paths not set in env!");
        console.log("[TEST] Checking node_modules for sherpa models...");
        
        // Find models in node_modules
        const modelDir = path.join(__dirname, "node_modules", "sherpa-onnx-node", "lib-node");
        if (fs.existsSync(modelDir)) {
            const files = fs.readdirSync(modelDir);
            console.log("[TEST] Files in", modelDir, ":");
            files.forEach(f => console.log("  -", f));
        }
        
        process.exit(1);
    }
    
    console.log("[TEST] Creating recognizer...");
    const recognizer = new sherpaOnnx.OfflineRecognizer({
        modelConfig: {
            whisper: {
                encoder,
                decoder,
                task: "transcribe"
            },
            tokens,
            numThreads: 1,
            provider: "cpu"
        }
    });
    console.log("[TEST] Recognizer created!");
    
    const stream = recognizer.createStream();
    stream.acceptWaveform(wave);
    console.log("[TEST] Waveform accepted");
    
    console.log("[TEST] Decoding...");
    recognizer.decode(stream);
    console.log("[TEST] Decode done");
    
    const result = recognizer.getResult(stream);
    console.log("[TEST] Result:", JSON.stringify(result, null, 2));
    console.log("[TEST] Result.result:", result?.result);
    
} catch (e) {
    console.error("[TEST] Error:", e);
    process.exit(1);
}

// Cleanup
try { fs.unlinkSync(wavFile); } catch (_) {}
