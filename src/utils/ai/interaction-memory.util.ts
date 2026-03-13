import fs from "fs";
import path from "path";

type MemoryEntry = {
    q: string;
    a: string;
    ts: number;
};

const MEMORY_FILE = path.join("logs", "ai-interaction-memory.jsonl");
const MAX_SCAN_LINES = Number(process.env.AI_MEMORY_SCAN_LINES || 500);
const MEMORY_CACHE_TTL_MS = Number(process.env.AI_MEMORY_CACHE_TTL_MS || 15000);
const STOPWORDS = new Set([
    "ve", "ile", "ama", "fakat", "icin", "bir", "bu", "su", "o", "da", "de", "mi", "mu", "mü", "mı",
    "the", "and", "or", "is", "are", "to", "for", "in", "of", "a", "an"
]);

const normalize = (value: string): string =>
    String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9çğıöşü\s]/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

const toTokens = (value: string): string[] =>
    normalize(value)
        .split(" ")
        .map((x) => x.trim())
        .filter((x) => x.length >= 3 && !STOPWORDS.has(x));

const ensureMemoryDir = () => {
    const dir = path.dirname(MEMORY_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};

let cachedEntries: MemoryEntry[] = [];
let cachedEntriesAt = 0;
let cachedMtimeMs = 0;

let writeQueue: string[] = [];
let isFlushing = false;

const flushWriteQueue = () => {
    if (isFlushing || !writeQueue.length) return;
    isFlushing = true;

    const chunk = writeQueue.join("");
    writeQueue = [];

    fs.appendFile(MEMORY_FILE, chunk, "utf8", () => {
        isFlushing = false;
        // Invalidate cache after new write so reads can pick up fresh lines.
        cachedEntriesAt = 0;
        if (writeQueue.length) {
            flushWriteQueue();
        }
    });
};

const readRecentEntries = (): MemoryEntry[] => {
    try {
        if (!fs.existsSync(MEMORY_FILE)) return [];

        const now = Date.now();
        const stat = fs.statSync(MEMORY_FILE);
        if ((now - cachedEntriesAt) < MEMORY_CACHE_TTL_MS && cachedEntries.length && stat.mtimeMs === cachedMtimeMs) {
            return cachedEntries;
        }

        const raw = fs.readFileSync(MEMORY_FILE, "utf8");
        const lines = raw.split(/\r?\n/).filter(Boolean);
        const recent = lines.slice(-MAX_SCAN_LINES);
        const parsed: MemoryEntry[] = [];

        for (const line of recent) {
            try {
                const obj = JSON.parse(line) as MemoryEntry;
                if (obj?.q && obj?.a) parsed.push(obj);
            } catch {
                // skip bad rows
            }
        }

        cachedEntries = parsed;
        cachedEntriesAt = now;
        cachedMtimeMs = stat.mtimeMs;
        return parsed;
    } catch {
        return [];
    }
};

export const saveInteractionMemory = (question: string, answer: string): void => {
    const q = String(question || "").trim();
    const a = String(answer || "").trim();
    if (!q || !a) return;

    try {
        ensureMemoryDir();
        const row: MemoryEntry = { q, a, ts: Date.now() };
        writeQueue.push(`${JSON.stringify(row)}\n`);
        flushWriteQueue();
    } catch {
        // non-critical
    }
};

export const getRelevantMemoryContext = (query: string, limit = 3): string => {
    const qTokens = toTokens(query);
    if (!qTokens.length) return "";

    const entries = readRecentEntries();
    if (!entries.length) return "";

    const scored = entries
        .map((entry) => {
            const eTokens = toTokens(`${entry.q} ${entry.a}`);
            const overlap = qTokens.filter((t) => eTokens.includes(t)).length;
            return { entry, score: overlap };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, limit));

    if (!scored.length) return "";

    return scored
        .map((x, i) => `Hafiza ${i + 1} | Soru: ${x.entry.q}\nCevap: ${x.entry.a}`)
        .join("\n\n");
};
