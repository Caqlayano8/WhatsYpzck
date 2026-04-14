export type SupportedChannel = "whatsapp" | "instagram" | "messenger" | "telegram";

export interface IncomingMessage {
  channel: SupportedChannel;
  userId: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelHandler {
  name: SupportedChannel;
  start(): Promise<void>;
  sendMessage(userId: string, text: string): Promise<void>;
}

export interface UserContext {
  history: Array<{ role: "user" | "assistant"; content: string }>;
  lang?: string;
}
