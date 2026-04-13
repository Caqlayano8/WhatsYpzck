import sqlite3 from "sqlite3";
import path from "path";
import cron from "node-cron";

const dbPath = path.resolve(__dirname, "..", "..", "tasks.db");
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      dueAt TEXT,
      createdAt TEXT NOT NULL
    )
  `);
});

export function parseTaskCommand(text: string): { type: "task" | "appointment"; title: string; dueAt?: string } | null {
  const normalized = text.toLowerCase();
  if (normalized.startsWith("gorev ekle")) {
    return { type: "task", title: text.slice("gorev ekle".length).trim() || "Yeni gorev" };
  }
  if (normalized.startsWith("randevu olustur")) {
    return { type: "appointment", title: text.slice("randevu olustur".length).trim() || "Yeni randevu" };
  }
  return null;
}

export function addTask(userId: string, payload: { type: "task" | "appointment"; title: string; dueAt?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO tasks(userId, type, title, dueAt, createdAt) VALUES(?, ?, ?, ?, ?)",
      [userId, payload.type, payload.title, payload.dueAt || null, new Date().toISOString()],
      function onInsert(err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

export function startTaskReminder(onReminder: (line: string) => void) {
  cron.schedule("*/1 * * * *", () => {
    const now = new Date();
    const inFive = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    const nowIso = now.toISOString();

    db.all(
      "SELECT id, userId, title, dueAt FROM tasks WHERE dueAt IS NOT NULL AND dueAt BETWEEN ? AND ?",
      [nowIso, inFive],
      (err, rows: Array<{ id: number; userId: string; title: string; dueAt: string }>) => {
        if (err || !rows?.length) return;
        for (const row of rows) {
          onReminder(`Hatirlatma -> ${row.userId}: ${row.title} (${row.dueAt})`);
        }
      }
    );
  });
}
