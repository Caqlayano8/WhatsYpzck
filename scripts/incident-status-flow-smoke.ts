import { BotManager } from "../src/bot.manager";
import { IncidentModel } from "../src/crm/models/incident.model";

type StatusFlowState = {
  active: boolean;
  history: string[];
  infoProvided: boolean;
  dispatchDone: boolean;
  statusFlow?: {
    active: boolean;
    awaiting: "name" | "phone" | "incidentId";
    data: {
      customerName: string;
      customerPhone: string;
      incidentId: string;
    };
  };
};

type FakeMessage = {
  replies: string[];
  reply: (text: string) => Promise<void>;
};

function createFakeMessage(): FakeMessage {
  const replies: string[] = [];
  return {
    replies,
    reply: async (text: string) => {
      replies.push(text);
    }
  };
}

async function runScenario(title: string, inputs: string[], recordExists: boolean) {
  const manager = Object.create(BotManager.prototype) as any;

  (IncidentModel as any).findOne = () => ({
    lean: async () => {
      if (!recordExists) return null;
      return {
        incidentId: "ARZ-1773396737967",
        status: "ISLEME_ALINDI",
        createdAt: new Date("2026-03-13T10:12:17.000Z"),
        updatedAt: new Date("2026-03-13T11:45:00.000Z"),
        address: "Carsi Mah. Sanayi Sokak",
        meterNo: "074838377"
      };
    }
  });

  const state: StatusFlowState = {
    active: true,
    history: [],
    infoProvided: false,
    dispatchDone: false,
    statusFlow: {
      active: false,
      awaiting: "name",
      data: {
        customerName: "Bilinmiyor",
        customerPhone: "Bilinmiyor",
        incidentId: "Bilinmiyor"
      }
    }
  };

  const msg = createFakeMessage();
  for (const input of inputs) {
    await manager.processIncidentStatusFlow(msg, state, input);
  }

  console.log(`\n=== ${title} ===`);
  msg.replies.forEach((r, i) => console.log(`${i + 1}. ${r.replace(/\n/g, " | ")}`));
}

async function main() {
  await runScenario(
    "Kayit bulundu",
    ["arizam ne durumda", "Caglayan Kurtoglu", "05458966096", "ARZ-1773396737967"],
    true
  );

  await runScenario(
    "Kayit bulunamadi",
    ["ariza durum sorgulama", "Caglayan Kurtoglu", "05458966096", "ARZ-111111"],
    false
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
