import { BotManager } from "../src/bot.manager";

type IncidentFlowState = {
  active: boolean;
  history: string[];
  infoProvided: boolean;
  dispatchDone: boolean;
  incidentFlow?: {
    active: boolean;
    awaiting: "name" | "phone" | "address" | "meter" | "email" | "confirm";
    data: {
      customerName: string;
      customerPhone: string;
      address: string;
      meterNo: string;
      customerEmail: string;
    };
  };
};

type FakeMessage = {
  from: string;
  replies: string[];
  reply: (text: string) => Promise<void>;
  getContact: () => Promise<{ pushname: string; name: string }>;
};

function createFakeMessage(from: string): FakeMessage {
  const replies: string[] = [];
  return {
    from,
    replies,
    reply: async (text: string) => {
      replies.push(text);
    },
    getContact: async () => ({ pushname: "Test Kullanici", name: "Test Kullanici" })
  };
}

async function runScenario(
  title: string,
  inputs: string[],
  initialState?: Partial<IncidentFlowState>
): Promise<{ title: string; prompts: string[]; state: IncidentFlowState }> {
  const manager = Object.create(BotManager.prototype) as any;
  manager.dispatchIncidentWithParsed = async () => true;

  const state: IncidentFlowState = {
    active: true,
    history: [],
    infoProvided: false,
    dispatchDone: false,
    incidentFlow: {
      active: false,
      awaiting: "name",
      data: {
        customerName: "Bilinmiyor",
        customerPhone: "Bilinmiyor",
        address: "Bilinmiyor",
        meterNo: "Bilinmiyor",
        customerEmail: "Bilinmiyor"
      }
    },
    ...initialState
  };

  const msg = createFakeMessage("905551112233@c.us");

  for (const input of inputs) {
    await manager.processIncidentFlow(msg, "905551112233", state, input);
  }

  return { title, prompts: msg.replies, state };
}

async function main() {
  const scenarios = await Promise.all([
    runScenario("Senaryo 1 - Tam dogru bilgi + evet", [
      "elektrik kesintisi var",
      "Ahmet Yilmaz",
      "05551234567",
      "Merkez Mah. Ataturk Cad. No:12 Artvin",
      "TBR-251435",
      "ahmet.yilmaz@example.com",
      "evet"
    ]),
    runScenario("Senaryo 2 - Duzeltme yapip sonra evet", [
      "ariza kaydi olusturmak istiyorum",
      "Mehmet Demir",
      "05321234567",
      "Yanlis",
      "Merkez Mah. Inonu Sok. No:5 Artvin",
      "TRX-778899",
      "mehmet.demir@example.com",
      "telefonum 05324567890",
      "Mehmet Demir",
      "05324567890",
      "Merkez Mah. Inonu Sok. No:5 Artvin",
      "TRX-778899",
      "mehmet.demir@example.com",
      "evet"
    ]),
    runScenario("Senaryo 3 - Onayda evet disi cevap", [
      "elektrik yok",
      "Ayse Kaya",
      "05051234567",
      "Coruh Mah. No:3 Artvin",
      "99887766",
      "ayse.kaya@example.com",
      "hayir"
    ])
  ]);

  for (const s of scenarios) {
    console.log(`\n=== ${s.title} ===`);
    s.prompts.forEach((p, i) => console.log(`${i + 1}. ${p.replace(/\n/g, " | ")}`));
    console.log(`Durum: dispatchDone=${s.state.dispatchDone}, awaiting=${s.state.incidentFlow?.awaiting}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
