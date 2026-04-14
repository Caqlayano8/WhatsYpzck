import OpenAI from "openai";
import { UserContext } from "../types";

const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
const client = apiKey ? new OpenAI({ apiKey }) : null;
const contexts = new Map<string, UserContext>();

function getContext(userId: string): UserContext {
  const existing = contexts.get(userId);
  if (existing) return existing;
  const created: UserContext = { history: [] };
  contexts.set(userId, created);
  return created;
}

export async function askAi(userId: string, userMessage: string): Promise<string> {
  if (!client) {
    return "OPENAI_API_KEY tanimli degil. Lütfen API anahtarini ayarlayin.";
  }

  const context = getContext(userId);
  context.history.push({ role: "user", content: userMessage });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: "You are a helpful multichannel customer support bot." },
    ...context.history.slice(-12).map((item) => ({
      role: item.role,
      content: item.content
    } as OpenAI.Chat.Completions.ChatCompletionMessageParam))
  ];

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages
  });

  const answer = completion.choices[0]?.message?.content?.trim() || "Uzgunum, su an yanit uretemedim.";
  context.history.push({ role: "assistant", content: answer });
  context.history = context.history.slice(-20);
  return answer;
}
