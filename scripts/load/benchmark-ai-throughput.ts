import axios from "axios";
import fs from "fs";
import path from "path";
import { config } from "dotenv";

config();

type Sample = {
    clientId: number;
    messageId: number;
    ok: boolean;
    latencyMs: number;
    error?: string;
};

const toInt = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const arg = (name: string): string | undefined => {
    const idx = process.argv.indexOf(name);
    if (idx === -1) return undefined;
    return process.argv[idx + 1];
};

const percentile = (values: number[], p: number): number => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const pos = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[pos];
};

const nowIsoFile = () => new Date().toISOString().replace(/[:.]/g, "-");

async function resolveModel(baseUrl: string, preferredModel: string): Promise<string> {
    try {
        const tags = await axios.get(`${baseUrl}/api/tags`, { timeout: 15000 });
        const available: string[] = (tags.data?.models || [])
            .map((m: any) => m?.name || m?.model)
            .filter(Boolean);

        if (!available.length) {
            return preferredModel;
        }

        if (available.includes(preferredModel)) {
            return preferredModel;
        }

        return available[0];
    } catch {
        return preferredModel;
    }
}

async function run() {
    const clients = toInt(arg("--clients"), 30);
    const messagesPerClient = toInt(arg("--messages"), 2);
    const timeoutMs = toInt(arg("--timeout"), 30000);

    const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    const preferredModel = process.env.OLLAMA_MODEL || "mistral";
    const model = await resolveModel(baseUrl, preferredModel);
    const totalRequests = clients * messagesPerClient;

    console.log("AI throughput benchmark basladi");
    console.log(`clients=${clients}, messagesPerClient=${messagesPerClient}, totalRequests=${totalRequests}`);
    console.log(`baseUrl=${baseUrl}, model=${model}, timeoutMs=${timeoutMs}`);

    const samples: Sample[] = [];
    const startedAt = Date.now();

    const worker = async (clientId: number) => {
        for (let m = 1; m <= messagesPerClient; m += 1) {
            const prompt = [
                `Musteri #${clientId}`,
                `Mesaj #${m}`,
                "Elektrik arizam var, lutfen kisaca yardimci olur musun?"
            ].join(" | ");

            const reqStart = Date.now();
            try {
                await axios.post(
                    `${baseUrl}/api/generate`,
                    {
                        model,
                        prompt,
                        stream: false,
                        options: {
                            temperature: 0.2,
                            top_p: 0.9,
                            num_predict: Number(process.env.OLLAMA_NUM_PREDICT || 72),
                            num_ctx: Number(process.env.OLLAMA_NUM_CTX || 768),
                            repeat_penalty: 1.1
                        }
                    },
                    { timeout: timeoutMs }
                );

                samples.push({
                    clientId,
                    messageId: m,
                    ok: true,
                    latencyMs: Date.now() - reqStart
                });
            } catch (err: any) {
                samples.push({
                    clientId,
                    messageId: m,
                    ok: false,
                    latencyMs: Date.now() - reqStart,
                    error: String(err?.message || err)
                });
            }
        }
    };

    await Promise.all(Array.from({ length: clients }, (_, i) => worker(i + 1)));

    const finishedAt = Date.now();
    const durationSec = (finishedAt - startedAt) / 1000;

    const success = samples.filter((x) => x.ok);
    const failed = samples.filter((x) => !x.ok);
    const latencies = success.map((x) => x.latencyMs);

    const report = {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationSec,
        config: {
            clients,
            messagesPerClient,
            totalRequests,
            timeoutMs,
            baseUrl,
            model
        },
        metrics: {
            successCount: success.length,
            failedCount: failed.length,
            successRate: totalRequests ? Number(((success.length / totalRequests) * 100).toFixed(2)) : 0,
            throughputRps: durationSec > 0 ? Number((success.length / durationSec).toFixed(2)) : 0,
            latencyAvgMs: latencies.length ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)) : 0,
            latencyP50Ms: percentile(latencies, 50),
            latencyP90Ms: percentile(latencies, 90),
            latencyP95Ms: percentile(latencies, 95),
            latencyP99Ms: percentile(latencies, 99)
        },
        failures: failed.slice(0, 20),
        samples
    };

    const outDir = path.join("logs", "load-tests");
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `ai-benchmark-${nowIsoFile()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");

    console.log("\nBenchmark tamamlandi");
    console.log(`Success: ${report.metrics.successCount}/${totalRequests} (%${report.metrics.successRate})`);
    console.log(`Throughput: ${report.metrics.throughputRps} req/s`);
    console.log(`Latency avg: ${report.metrics.latencyAvgMs} ms`);
    console.log(`Latency p50/p90/p95/p99: ${report.metrics.latencyP50Ms}/${report.metrics.latencyP90Ms}/${report.metrics.latencyP95Ms}/${report.metrics.latencyP99Ms} ms`);
    console.log(`Rapor dosyasi: ${outFile}`);

    if (failed.length) {
        process.exitCode = 2;
    }
}

run().catch((err) => {
    console.error("Benchmark calistirilamadi:", err);
    process.exit(1);
});
