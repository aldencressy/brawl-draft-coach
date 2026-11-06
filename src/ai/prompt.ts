// The AI layer's input and output: turns the engine's Recommendation into a prompt, and
// checks the model's answer against it. Pure, so it's tested without calling the API.
import type { Recommendation } from "../engine/types.js";
import type { StaticData } from "../outputs/static.js";

export interface AiConfig {
  model: string;
  effort: "low" | "medium" | "high";
  maxTokens: number;
  candidates: number;
  debounceMs: number;
}

/** What the page shows from the AI. Brawler ids are always ones the engine offered. */
export interface AiTake {
  ranking: Array<{ id: number; name: string; note: string; engineRank: number }>;
  warning: string;
  summary: string;
}

export const SYSTEM_PROMPT = `You are a draft coach for Brawl Stars ranked (3v3 draft, Mythic rank and above). The player is mid-draft and must pick soon, so answer briefly.

You receive the state of the draft, the map's most-picked brawlers at this rank (what the map rewards), and a statistics engine's top candidates for the player's pick. For each candidate you get its score in win-rate points and the parts behind it: map strength (with matchup luck removed), its matchups against enemies already picked, its pairs with allies already picked, "later" (how it fares against the enemy's likely answers and with your likely teammates, from playing out the rest of the draft), role fit, the player's own record on that brawler, and an "unproven" cost for having few games on this map. Details include sample sizes, how often it's picked on this map, the specific matchups, the predicted enemy answers, and gadget and star power descriptions.

How to judge:
- The statistics are your main evidence. Trust them in proportion to their sample sizes; a strong number on a few dozen games is weak evidence, and a brawler that is almost never picked on this map at this rank is probably there for a reason.
- Add what the numbers can't see: team composition (range, wall-breaking, tankiness, healing, control), how the map plays, what the enemy's remaining picks are likely to target, and whether the player's team has an answer to each enemy threat.
- Your knowledge of the game may be out of date. Where the provided descriptions or stats disagree with what you remember, go with what's provided.
- Only choose among the candidates given. Never suggest a brawler that isn't in the list.

Respond with:
- ranking: your best 3 to 5 candidates, best first, each with a note of at most 12 words saying why (for example "Outranges Piper; Gene can pull for it").
- warning: one sentence about the biggest danger in this draft for the player's team, or an empty string if nothing stands out.
- summary: one sentence explaining your top choice, especially if you disagree with the engine's order.`;

/** JSON schema for structured output. Strict: every field required, nothing extra. */
export const AI_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ranking: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, note: { type: "string" } },
        required: ["id", "note"],
        additionalProperties: false,
      },
    },
    warning: { type: "string" },
    summary: { type: "string" },
  },
  required: ["ranking", "warning", "summary"],
  additionalProperties: false,
} as const;

/** The user message: the draft and candidates as compact JSON, with the static info the model needs. */
export function buildUserMessage(rec: Recommendation, staticData: StaticData, candidates: number): string {
  const byId = new Map(staticData.brawlers.map((b) => [b.id, b]));
  const describe = (id: number) => {
    const b = byId.get(id);
    return { id, name: b?.name ?? `#${id}`, class: b?.class ?? "Unknown", roles: b?.roles ?? [] };
  };
  const c = rec.context;
  const payload = {
    map: c.mapName,
    mode: c.mode,
    yourPickSlot: c.mySlot,
    enemyPicksAfterYours: c.enemyPicksAfterMine,
    allies: c.allies.map((a) => describe(a.id)),
    enemies: c.enemies.map((e) => describe(e.id)),
    bans: c.bans.map((b) => b.name),
    data: { gamesOnMap: rec.data.mapGames, totalGames: rec.data.games, window: rec.data.window },
    mapMeta: rec.data.mapMeta.map(({ name, games, winRate, pickRate }) => ({ name, games, winRate, pickRate })),
    candidates: rec.candidates.slice(0, candidates).map((x, i) => {
      const b = byId.get(x.id);
      return {
        ...describe(x.id),
        engineRank: i + 1,
        score: x.score,
        parts: x.parts,
        reasons: x.reasons,
        warning: x.warning ?? null,
        mapWinRate: x.details.mapWinRate,
        mapGames: x.details.mapGames,
        mapPickRate: x.details.mapPickRate,
        counters: x.details.counters.map(({ name, points, games }) => ({ vs: name, points, games })),
        synergies: x.details.synergies.map(({ name, points, games }) => ({ with: name, points, games })),
        likelyEnemyAnswers: x.details.threats.map(({ name, points, games }) => ({ from: name, points, games })),
        likelyTeammates: x.details.likelyTeammates.map((t) => t.name),
        yourRecord: x.details.personal,
        gadgets: b?.gadgets.map((g) => `${g.name}: ${g.description ?? ""}`) ?? [],
        starPowers: b?.starPowers.map((s) => `${s.name}: ${s.description ?? ""}`) ?? [],
        build: x.build ?? null,
      };
    }),
  };
  return `Draft state and candidates:\n${JSON.stringify(payload)}`;
}

/** Validates the model's JSON against what the engine offered; drops anything else. */
export function parseAiTake(json: unknown, rec: Recommendation, candidates: number): AiTake {
  const offered = rec.candidates.slice(0, candidates);
  const raw = (json ?? {}) as { ranking?: unknown; warning?: unknown; summary?: unknown };
  const seen = new Set<number>();
  const ranking = (Array.isArray(raw.ranking) ? raw.ranking : [])
    .map((r: { id?: unknown; note?: unknown }) => ({ id: Number(r?.id), note: String(r?.note ?? "") }))
    .filter((r) => {
      const ok = offered.some((c) => c.id === r.id) && !seen.has(r.id);
      seen.add(r.id);
      return ok;
    })
    .slice(0, 5)
    .map((r) => {
      const engineRank = offered.findIndex((c) => c.id === r.id) + 1;
      return { id: r.id, name: offered[engineRank - 1]!.name, note: r.note.trim(), engineRank };
    });
  return {
    ranking,
    warning: typeof raw.warning === "string" ? raw.warning.trim() : "",
    summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
  };
}

/** Same draft state -> same key, so an unchanged draft isn't asked about twice. */
export function draftKey(rec: Recommendation): string {
  const c = rec.context;
  const ids = (xs: Array<{ id: number }>) => xs.map((x) => x.id).sort((a, b) => a - b).join(".");
  return `${c.mapId}|${c.mySlot}|${ids(c.bans)}|${ids(c.allies)}|${ids(c.enemies)}`;
}
