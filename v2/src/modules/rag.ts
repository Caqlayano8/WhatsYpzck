import OpenAI from "openai";

interface RagDoc {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  vector?: number[];
}

const ragApiKey = String(process.env.OPENAI_API_KEY || "").trim();
const openai = ragApiKey ? new OpenAI({ apiKey: ragApiKey }) : null;
const docs: RagDoc[] = [
  { id: "urun-1", text: "A100 model urun stokta var, teslim suresi 2 gun." },
  { id: "urun-2", text: "B200 model urun stokta yok, tedarik suresi 10 gun." },
  { id: "urun-3", text: "C300 model urun stokta var, kampanyali fiyat uygulanir." }
];

async function embed(text: string): Promise<number[]> {
  if (!openai) {
    const fallback = Array.from(text).slice(0, 64).map((ch) => ch.charCodeAt(0) / 255);
    while (fallback.length < 64) fallback.push(0);
    return fallback;
  }

  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text
  });
  return res.data[0].embedding;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

let indexed = false;

export async function initRag() {
  if (indexed) return;
  for (const d of docs) {
    d.vector = await embed(d.text);
  }
  indexed = true;
}

export async function retrieveContext(question: string, topK = 3): Promise<string> {
  await initRag();
  const qVec = await embed(question);

  const ranked = docs
    .filter((d) => d.vector)
    .map((d) => ({ doc: d, score: cosine(qVec, d.vector as number[]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return ranked.map((r) => `- ${r.doc.text}`).join("\n");
}
