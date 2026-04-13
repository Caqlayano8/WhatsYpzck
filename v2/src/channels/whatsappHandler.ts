import { Client, LocalAuth, Message } from "whatsapp-web.js";
import { ChannelHandler, IncomingMessage } from "../types";
import { logChannel } from "../utils/logger";

export class WhatsAppHandler implements ChannelHandler {
  public readonly name = "whatsapp" as const;
  private readonly client: Client;
  private readonly onIncoming: (msg: IncomingMessage) => Promise<void>;

  constructor(onIncoming: (msg: IncomingMessage) => Promise<void>) {
    this.onIncoming = onIncoming;
    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: "v2" })
    });

    this.client.on("qr", () => logChannel(this.name, "QR generated"));
    this.client.on("ready", () => logChannel(this.name, "Client ready"));
    this.client.on("message", (message: Message) => {
      void this.onIncoming({
        channel: this.name,
        userId: message.from,
        text: message.body || ""
      });
    });
  }

  async start(): Promise<void> {
    await this.client.initialize();
  }

  async sendMessage(userId: string, text: string): Promise<void> {
    await this.client.sendMessage(userId, text);
  }
}
