import fs from "fs";
import path from "path";
import { askAi } from "../modules/ai";
import { retrieveContext } from "../modules/rag";
import { addTask, parseTaskCommand, startTaskReminder } from "../modules/tasks";
import { IncomingMessage, ChannelHandler, SupportedChannel } from "../types";
import { translateText } from "../utils/translator";
import { logChannel, logV2 } from "../utils/logger";
import { InstagramHandler } from "../channels/instagramHandler";
import { MessengerHandler } from "../channels/messengerHandler";
import { TelegramHandler } from "../channels/telegramHandler";
import { WhatsAppHandler } from "../channels/whatsappHandler";

interface AppConfig {
  defaultLanguage: string;
  targetLanguage: string;
  enableTranslation: boolean;
  rag: { topK: number };
}

export class ChannelManager {
  private readonly handlers = new Map<SupportedChannel, ChannelHandler>();
  private readonly config: AppConfig;

  constructor() {
    const configPath = path.resolve(__dirname, "..", "..", "config.json");
    this.config = JSON.parse(fs.readFileSync(configPath, "utf8")) as AppConfig;

    this.handlers.set("whatsapp", new WhatsAppHandler(this.handleIncoming.bind(this)));
    this.handlers.set("instagram", new InstagramHandler());
    this.handlers.set("messenger", new MessengerHandler());
    this.handlers.set("telegram", new TelegramHandler(this.handleIncoming.bind(this)));

    startTaskReminder((line) => logV2(line));
  }

  async startAll(): Promise<void> {
    for (const handler of this.handlers.values()) {
      await handler.start();
      logChannel(handler.name, "started");
    }
  }

  async handleExternalIncoming(message: IncomingMessage): Promise<void> {
    await this.handleIncoming(message);
  }

  private async handleIncoming(message: IncomingMessage): Promise<void> {
    logChannel(message.channel, `incoming from ${message.userId}: ${message.text}`);

    const task = parseTaskCommand(message.text);
    if (task) {
      const taskId = await addTask(message.userId, task);
      await this.send(message.channel, message.userId, `Kaydedildi (#${taskId}): ${task.title}`);
      return;
    }

    const incoming = this.config.enableTranslation
      ? await translateText(message.text, this.config.targetLanguage)
      : message.text;

    const ragContext = await retrieveContext(incoming, this.config.rag.topK);
    const aiPrompt = `${incoming}\n\nBilgi tabani:\n${ragContext}`;
    const aiAnswer = await askAi(`${message.channel}:${message.userId}`, aiPrompt);

    const outgoing = this.config.enableTranslation
      ? await translateText(aiAnswer, this.config.defaultLanguage)
      : aiAnswer;

    await this.send(message.channel, message.userId, outgoing);
  }

  private async send(channel: SupportedChannel, userId: string, text: string): Promise<void> {
    const handler = this.handlers.get(channel);
    if (!handler) return;
    await handler.sendMessage(userId, text);
    logChannel(channel, `outgoing to ${userId}: ${text}`);
  }
}
