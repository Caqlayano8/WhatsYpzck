import TelegramBot from "node-telegram-bot-api";
import { ChannelHandler, IncomingMessage } from "../types";
import { logChannel } from "../utils/logger";

export class TelegramHandler implements ChannelHandler {
  public readonly name = "telegram" as const;
  private readonly botToken: string;
  private readonly onIncoming: (msg: IncomingMessage) => Promise<void>;
  private bot: TelegramBot | null = null;

  constructor(onIncoming: (msg: IncomingMessage) => Promise<void>) {
    this.onIncoming = onIncoming;
    this.botToken = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  }

  async start(): Promise<void> {
    if (!this.botToken) {
      logChannel(this.name, "TELEGRAM_BOT_TOKEN yok, handler pasif");
      return;
    }

    this.bot = new TelegramBot(this.botToken, { polling: true });
    this.bot.on("message", (msg: TelegramBot.Message) => {
      const text = String(msg.text || "").trim();
      if (!text) return;
      void this.onIncoming({
        channel: this.name,
        userId: String(msg.chat.id),
        text,
        metadata: {
          chatType: msg.chat.type,
          from: msg.from?.username || msg.from?.id
        }
      });
    });

    logChannel(this.name, "Telegram polling started");
  }

  async sendMessage(userId: string, text: string): Promise<void> {
    if (!this.bot) {
      logChannel(this.name, `Bot hazir degil, mesaj atlanir -> ${userId}`);
      return;
    }

    await this.bot.sendMessage(userId, text);
    logChannel(this.name, `Send message -> ${userId}: ${text}`);
  }
}
