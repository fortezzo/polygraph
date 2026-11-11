// Friendlier model names (Christian, Session 11): "Gemma 4 12B" instead of
// "gemma4:12b", with the exact tag in small print wherever the bot is named
// in full, since the tag is what was tested. This replaces the Session 6
// choice to show names only as the run file has them, on purpose.
//
// Each name is written the way its maker writes it, checked on Nov 11, 2026:
// OpenAI's model pages ("GPT-6 Luna", "GPT-6.1 Terra", "GPT-6 Astra"),
// Anthropic's ("Claude Haiku 5.5"), Mistral's ("Ministral 3 14B"), and
// Ollama's library pages for Gemma 3 and 4, Llama 3.2, Phi-4 and Qwen3.6,
// which give the family name and the size separately ("Gemma 4" and "12B").
// A tag that isn't listed here is shown as it is.

const NAMES: Record<string, string> = {
  "llama3.2": "Llama 3.2 3B",
  "llama3.2:latest": "Llama 3.2 3B",
  "llama3.2:3b": "Llama 3.2 3B",
  "gemma3:12b": "Gemma 3 12B",
  "gemma4:12b": "Gemma 4 12B",
  "ministral-3:14b": "Ministral 3 14B",
  "phi4:14b": "Phi-4 14B",
  "gpt-6-luna": "GPT-6 Luna",
  "gpt-6.1-terra": "GPT-6.1 Terra",
  "gpt-6-astra": "GPT-6 Astra",
  "claude-haiku-5-5": "Claude Haiku 5.5",
  "qwen3.6:35b": "Qwen3.6 35B",
};

/** A model's friendly name, or its tag when there's none. */
export function modelName(tag: string | null | undefined): string {
  if (!tag) return "";
  return NAMES[tag] ?? tag;
}

/** Whether the friendly name differs from the tag, so the tag is worth showing in small print. */
export function hasOwnName(tag: string | null | undefined): boolean {
  return !!tag && tag in NAMES && NAMES[tag] !== tag;
}

/** Every listed tag, for the tests. */
export const NAMED_TAGS: readonly string[] = Object.keys(NAMES);
