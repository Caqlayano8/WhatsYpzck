import fs from "fs";
import path from "path";

const root = path.resolve(__dirname, "..", "..");
const logsDir = path.join(root, "logs");
const channelLogPath = path.join(logsDir, "channel.log");
const v2LogPath = path.join(root, "logs_v2.txt");

function ensureLogs() {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  if (!fs.existsSync(channelLogPath)) {
    fs.writeFileSync(channelLogPath, "", "utf8");
  }
  if (!fs.existsSync(v2LogPath)) {
    fs.writeFileSync(v2LogPath, "", "utf8");
  }
}

export function logChannel(channel: string, message: string) {
  ensureLogs();
  const line = `[${new Date().toISOString()}] [${channel}] ${message}\n`;
  fs.appendFileSync(channelLogPath, line, "utf8");
  fs.appendFileSync(v2LogPath, line, "utf8");
}

export function logV2(message: string) {
  ensureLogs();
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(v2LogPath, line, "utf8");
}
