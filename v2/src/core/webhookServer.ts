import express, { Request, Response } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ChannelManager } from "./channelManager";
import { logChannel, logV2 } from "../utils/logger";

type MetaRequest = Request & { rawBody?: Buffer };

const processedEventCache = new Map<string, number>();
const EVENT_TTL_MS = 10 * 60 * 1000;

function cleanupEventCache(now: number) {
  if (processedEventCache.size < 5000) return;
  for (const [key, ts] of processedEventCache.entries()) {
    if (now - ts > EVENT_TTL_MS) {
      processedEventCache.delete(key);
    }
  }
}

function buildFallbackEventId(channel: string, senderId: string, text: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${channel}:${senderId}:${text}`)
    .digest("hex");
  return `${channel}:${hash}`;
}

function isDuplicateEvent(eventId: string): boolean {
  const now = Date.now();
  const existing = processedEventCache.get(eventId);
  if (existing && now - existing <= EVENT_TTL_MS) {
    return true;
  }
  processedEventCache.set(eventId, now);
  cleanupEventCache(now);
  return false;
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function verifyMetaSignature(rawBody: Buffer | undefined, signature: string, appSecret: string): boolean {
  if (!rawBody || !signature || !appSecret) return false;
  const expected = `sha256=${crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  return safeEqual(expected, signature);
}

function readLastLogLines(logPath: string, lineCount = 30): string[] {
  try {
    if (!fs.existsSync(logPath)) return [];
    const content = fs.readFileSync(logPath, "utf8");
    return content.split(/\r?\n/).filter(Boolean).slice(-lineCount);
  } catch {
    return [];
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function startWebhookServer(manager: ChannelManager) {
  const app = express();
  app.use(express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      (req as MetaRequest).rawBody = Buffer.from(buf);
    }
  }));

  const port = Number(process.env.PORT || 3600);
  const verifyToken = String(process.env.META_VERIFY_TOKEN || "verify-token");
  const appSecret = String(process.env.META_APP_SECRET || "").trim();
  const rootDir = path.resolve(__dirname, "..", "..");
  const v2LogPath = path.join(rootDir, "logs_v2.txt");
  const channelLogPath = path.join(rootDir, "logs", "channel.log");

  if (!appSecret) {
    logV2("META_APP_SECRET tanimli degil; webhook signature dogrulamasi pasif.");
  }

  app.get("/webhook/meta", (req: Request, res: Response) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === verifyToken) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  app.get("/admin/api/status", (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      service: "whatsypzck-v2-webhook",
      uptimeSec: Math.round(process.uptime()),
      port,
      env: {
        OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY),
        TELEGRAM_BOT_TOKEN: Boolean(process.env.TELEGRAM_BOT_TOKEN),
        META_PAGE_ACCESS_TOKEN: Boolean(process.env.META_PAGE_ACCESS_TOKEN),
        META_VERIFY_TOKEN: Boolean(process.env.META_VERIFY_TOKEN),
        META_APP_SECRET: Boolean(process.env.META_APP_SECRET)
      }
    });
  });

  app.get("/admin/api/logs", (_req: Request, res: Response) => {
    res.status(200).json({
      channel: readLastLogLines(channelLogPath, 80),
      v2: readLastLogLines(v2LogPath, 80)
    });
  });

  app.get("/admin", (_req: Request, res: Response) => {
    const adminHtml = path.join(rootDir, "src", "admin.html");
    if (fs.existsSync(adminHtml)) {
      return res.status(200).sendFile(adminHtml);
    }
    // fallback: legacy inline panel
    const channelLines = readLastLogLines(channelLogPath, 40);
    const v2Lines = readLastLogLines(v2LogPath, 40);
    const envRows = [
      ["OPENAI_API_KEY", Boolean(process.env.OPENAI_API_KEY)],
      ["TELEGRAM_BOT_TOKEN", Boolean(process.env.TELEGRAM_BOT_TOKEN)],
      ["META_PAGE_ACCESS_TOKEN", Boolean(process.env.META_PAGE_ACCESS_TOKEN)],
      ["META_VERIFY_TOKEN", Boolean(process.env.META_VERIFY_TOKEN)],
      ["META_APP_SECRET", Boolean(process.env.META_APP_SECRET)]
    ];

    const html = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>WhatsYpzck v2 Control Center</title>
  <style>
    :root {
      --bg: #f1f5f9;
      --card: #ffffff;
      --ink: #0f172a;
      --muted: #475569;
      --line: #dbe3ef;
      --ok-bg: #dcfce7;
      --ok-ink: #166534;
      --bad-bg: #fee2e2;
      --bad-ink: #991b1b;
      --log-bg: #0b1220;
      --log-ink: #bfe5ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: "Segoe UI", "Trebuchet MS", Arial, sans-serif;
      background:
        radial-gradient(900px 320px at 100% -10%, #99f6e4 0%, transparent 60%),
        radial-gradient(900px 320px at 0% -10%, #bae6fd 0%, transparent 60%),
        var(--bg);
    }
    .wrap { max-width: 1120px; margin: 22px auto; padding: 0 14px; }
    .card {
      background: var(--card);
      border-radius: 14px;
      border: 1px solid var(--line);
      box-shadow: 0 8px 24px rgba(2, 6, 23, 0.08);
      padding: 16px;
      margin-bottom: 14px;
    }
    h1 { margin: 0 0 10px; font-size: 34px; letter-spacing: -0.02em; }
    h2 { margin: 0 0 10px; font-size: 20px; }
    .sub { margin: 0; color: var(--muted); }
    .pill {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 999px;
      background: var(--ok-bg);
      color: var(--ok-ink);
      font-size: 12px;
      font-weight: 600;
      margin: 8px 8px 0 0;
    }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .stat {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      background: #fafcff;
    }
    .stat b { font-size: 22px; display: block; margin-top: 4px; }
    .links { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 10px; }
    .links a {
      text-decoration: none;
      color: #0b3b82;
      background: #e0ecff;
      border: 1px solid #c2d7ff;
      padding: 8px 10px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
    }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); }
    th { color: var(--muted); font-size: 13px; letter-spacing: 0.02em; }
    .ok { color: var(--ok-ink); background: var(--ok-bg); padding: 4px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .bad { color: var(--bad-ink); background: var(--bad-bg); padding: 4px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    pre {
      margin: 0;
      background: var(--log-bg);
      color: var(--log-ink);
      border-radius: 10px;
      border: 1px solid #243247;
      padding: 12px;
      overflow: auto;
      max-height: 300px;
      font-size: 12px;
      line-height: 1.45;
    }
    .foot { color: var(--muted); font-size: 12px; margin-top: 6px; }
    @media (max-width: 900px) {
      .grid { grid-template-columns: 1fr; }
      h1 { font-size: 28px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>WhatsYpzck v2 Control Center</h1>
      <p class="sub">v2 servislerinin durumunu, kanal baglantilarini ve loglari tek ekrandan izleyebilirsiniz.</p>
      <span class="pill">Servis Aktif</span>
      <span class="pill">Port: ${port}</span>
      <span class="pill">Uptime: ${Math.round(process.uptime())} sn</span>
      <div class="links">
        <a href="/health" target="_blank">Health</a>
        <a href="/webhook/meta" target="_blank">Meta Verify</a>
        <a href="/admin/api/status" target="_blank">Status API</a>
      </div>
    </div>

    <div class="card">
      <h2>Sistem Ozeti</h2>
      <div class="grid">
        <div class="stat">Servis<b>RUNNING</b></div>
        <div class="stat">Port<b>${port}</b></div>
        <div class="stat">Uptime<b>${Math.round(process.uptime())} sn</b></div>
      </div>
    </div>

    <div class="card">
      <h2>ENV Durumu</h2>
      <table>
        <thead><tr><th>Degisken</th><th>Durum</th></tr></thead>
        <tbody>
          ${envRows.map(([name, ok]) => `<tr><td>${name}</td><td>${ok ? '<span class="ok">Hazir</span>' : '<span class="bad">Eksik</span>'}</td></tr>`).join("")}
        </tbody>
      </table>
      <p class="foot">Not: Eksik alanlar ilgili kanal/AI ozelliklerinin calismamasina neden olabilir.</p>
    </div>

    <div class="card">
      <h2>Son Kanal Loglari</h2>
      <pre>${escapeHtml(channelLines.join("\n") || "Log yok")}</pre>
    </div>

    <div class="card">
      <h2>Son v2 Loglari</h2>
      <pre>${escapeHtml(v2Lines.join("\n") || "Log yok")}</pre>
    </div>
  </div>
</body>
</html>`;

    res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send(html);
  });

  app.post("/webhook/meta", async (req: MetaRequest, res: Response) => {
    try {
      if (appSecret) {
        const signature = String(req.header("x-hub-signature-256") || "");
        const valid = verifyMetaSignature(req.rawBody, signature, appSecret);
        if (!valid) {
          logChannel("messenger", "invalid webhook signature");
          return res.sendStatus(401);
        }
      }

      const body = req.body as any;
      const entries = Array.isArray(body?.entry) ? body.entry : [];

      for (const entry of entries) {
        const messaging = Array.isArray(entry?.messaging) ? entry.messaging : [];
        for (const event of messaging) {
          const senderId = String(event?.sender?.id || "");
          const text = String(event?.message?.text || "").trim();
          if (!senderId || !text) continue;

          const eventId = String(event?.message?.mid || event?.message?.id || "") || buildFallbackEventId("messenger", senderId, text);
          if (isDuplicateEvent(eventId)) {
            logChannel("messenger", `duplicate event skipped: ${eventId}`);
            continue;
          }

          await manager.handleExternalIncoming({
            channel: "messenger",
            userId: senderId,
            text,
            metadata: { source: "meta-webhook" }
          });
        }

        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const change of changes) {
          const value = change?.value;
          const messages = Array.isArray(value?.messages) ? value.messages : [];
          for (const msg of messages) {
            const senderId = String(msg?.from || "");
            const text = String(msg?.text?.body || "").trim();
            if (!senderId || !text) continue;

            const eventId = String(msg?.id || "") || buildFallbackEventId("instagram", senderId, text);
            if (isDuplicateEvent(eventId)) {
              logChannel("instagram", `duplicate event skipped: ${eventId}`);
              continue;
            }

            await manager.handleExternalIncoming({
              channel: "instagram",
              userId: senderId,
              text,
              metadata: { source: "meta-webhook" }
            });
          }
        }
      }

      res.sendStatus(200);
    } catch (error) {
      logChannel("messenger", `webhook error: ${String(error)}`);
      res.sendStatus(500);
    }
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, service: "whatsypzck-v2-webhook" });
  });

  app.listen(port, () => {
    logV2(`Webhook server started on port ${port}`);
  });
}
