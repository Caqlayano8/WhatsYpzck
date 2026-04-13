import dotenv from "dotenv";
import { ChannelManager } from "./core/channelManager";
import { startWebhookServer } from "./core/webhookServer";
import { logV2 } from "./utils/logger";

dotenv.config();

async function bootstrap() {
  const manager = new ChannelManager();
  await manager.startAll();
  startWebhookServer(manager);
  logV2("v2 bot started");
  console.log("WhatsYpzck v2 started");
}

bootstrap().catch((err) => {
  logV2(`fatal: ${String(err)}`);
  console.error(err);
  process.exit(1);
});
