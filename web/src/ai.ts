// Calls Claude from the browser with the key you entered on this page. The key is stored only
// in this browser's local storage and sent only to api.anthropic.com.
import type Anthropic from "@anthropic-ai/sdk";
import aiJson from "../../config/ai.json";
import { AI_OUTPUT_SCHEMA, SYSTEM_PROMPT, buildUserMessage, parseAiTake, type AiConfig, type AiTake } from "../../src/ai/prompt.js";
import type { Recommendation } from "../../src/engine/types.js";
import type { StaticData } from "../../src/outputs/static.js";

export const aiConfig = aiJson as unknown as AiConfig;
const SETTINGS_KEY = "bdc.ai.v1";

export interface AiSettings {
  apiKey: string;
  enabled: boolean;
}

export function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { apiKey: "", enabled: true, ...(JSON.parse(raw) as Partial<AiSettings>) };
  } catch {
    // Storage blocked: AI stays off until a key is entered this session.
  }
  return { apiKey: "", enabled: true };
}

export function saveAiSettings(s: AiSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Can't persist; the key still works until the page is closed.
  }
}

// The SDK is loaded on first use, so the page opens just as fast without the AI.
let sdk: typeof Anthropic | null = null;
let client: Anthropic | null = null;
let clientKey = "";

async function clientFor(apiKey: string): Promise<{ client: Anthropic; SDK: typeof Anthropic }> {
  sdk ??= (await import("@anthropic-ai/sdk")).default;
  if (!client || clientKey !== apiKey) {
    // This is a personal page and the key is your own, typed into it; it never ships with the site.
    client = new sdk({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
    clientKey = apiKey;
  }
  return { client, SDK: sdk };
}

/** Asks Claude for its take on the engine's candidates. Throws a readable Error on failure. */
export async function askAi(rec: Recommendation, staticData: StaticData, apiKey: string, signal: AbortSignal): Promise<AiTake> {
  const { client, SDK } = await clientFor(apiKey);
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create(
      {
        model: aiConfig.model,
        max_tokens: aiConfig.maxTokens,
        // Thinking is adaptive by default; effort sets how hard it works (and how long you wait).
        output_config: { effort: aiConfig.effort, format: { type: "json_schema", schema: AI_OUTPUT_SCHEMA } },
        // If a safety classifier declines, the API retries on Anthropic's recommended model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserMessage(rec, staticData, aiConfig.candidates) }],
      },
      { signal },
    );
  } catch (err) {
    if (err instanceof SDK.APIUserAbortError) throw err;
    if (err instanceof SDK.AuthenticationError) throw new Error("API key rejected. Check it in AI settings.");
    if (err instanceof SDK.PermissionDeniedError) throw new Error("This API key isn't allowed to use that model.");
    if (err instanceof SDK.RateLimitError) throw new Error("Rate limited by the API. Try again in a moment.");
    if (err instanceof SDK.BadRequestError) throw new Error(`The API rejected the request: ${err.message}`);
    if (err instanceof SDK.APIConnectionError) throw new Error("Couldn't reach the API. Check your connection.");
    if (err instanceof SDK.APIError) throw new Error(`API error ${err.status ?? ""}: ${err.message}`);
    throw err;
  }

  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  if (response.stop_reason === "max_tokens") throw new Error("The answer was cut off. Raise maxTokens in config/ai.json.");
  const text = response.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text;
  if (!text) throw new Error("The model returned no answer.");
  return parseAiTake(JSON.parse(text), rec, aiConfig.candidates);
}

export const isAbort = (err: unknown) => !!sdk && err instanceof sdk.APIUserAbortError;
