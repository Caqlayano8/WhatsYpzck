import axios from "axios";
import { ChannelHandler } from "../types";
import { logChannel } from "../utils/logger";

export class MessengerHandler implements ChannelHandler {
  public readonly name = "messenger" as const;
  private readonly accessToken = String(process.env.META_PAGE_ACCESS_TOKEN || "").trim();
  private readonly apiVersion = String(process.env.META_GRAPH_VERSION || "v20.0").trim();

  async start(): Promise<void> {
    logChannel(this.name, "Messenger handler ready");
  }

  async sendMessage(userId: string, text: string): Promise<void> {
    if (!this.accessToken) {
      logChannel(this.name, `META_PAGE_ACCESS_TOKEN yok, mesaj atlanir -> ${userId}`);
      return;
    }

    await axios.post(
      `https://graph.facebook.com/${this.apiVersion}/me/messages`,
      {
        recipient: { id: userId },
        messaging_type: "RESPONSE",
        message: { text }
      },
      {
        params: { access_token: this.accessToken },
        timeout: 10000
      }
    );

    logChannel(this.name, `Send message -> ${userId}: ${text}`);
  }
}
