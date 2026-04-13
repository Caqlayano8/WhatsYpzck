import { translate } from "@vitalets/google-translate-api";

export async function translateText(text: string, to: string): Promise<string> {
  if (!text.trim()) return text;
  const result = await translate(text, { to });
  return result.text;
}
