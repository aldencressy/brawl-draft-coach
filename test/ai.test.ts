import { describe, expect, it } from "vitest";
import { AI_OUTPUT_SCHEMA, SYSTEM_PROMPT, buildUserMessage, draftKey, parseAiTake } from "../src/ai/prompt.js";
import { recommend } from "../src/engine/recommend.js";
import { B, GEM_FORT, buildWorld, draftConfig, weights } from "./engineWorld.js";

const world = buildWorld(4_000);
const rec = recommend({ mapId: GEM_FORT, mySlot: 4, bans: [B.Unowned], allies: [B.TwinA], enemies: [B.Prey, B.Tank] }, world, weights, draftConfig);
const ids = rec.candidates.map((c) => c.id);

describe("AI prompt", () => {
  it("sends the draft, the candidates and their stats as JSON", () => {
    const msg = buildUserMessage(rec, world.static, 5);
    const payload = JSON.parse(msg.slice(msg.indexOf("{")));
    expect(payload.map).toBe("Gem Fort");
    expect(payload.yourPickSlot).toBe(4);
    expect(payload.enemies.map((e: { name: string }) => e.name)).toEqual(["Prey", "Tank"]);
    expect(payload.candidates).toHaveLength(5);
    expect(payload.candidates[0]).toMatchObject({ id: ids[0], engineRank: 1, score: rec.candidates[0]!.score });
    expect(payload.candidates[0].counters.map((c: { vs: string }) => c.vs)).toEqual(["Prey", "Tank"]);
    expect(payload.candidates[0].gadgets[0]).toMatch(/Gadget/);
  });

  it("keeps the system prompt fixed, so it can be cached", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(AI_OUTPUT_SCHEMA.required).toEqual(["ranking", "warning", "summary"]);
  });
});

describe("parseAiTake", () => {
  it("keeps the AI's order and notes, with each pick's stats rank", () => {
    const take = parseAiTake({ ranking: [{ id: ids[2], note: " Beats their tank " }, { id: ids[0], note: "Safe" }], warning: "Watch Bully", summary: "Third pick fits better." }, rec, 10);
    expect(take.ranking.map((r) => r.id)).toEqual([ids[2], ids[0]]);
    expect(take.ranking[0]).toMatchObject({ engineRank: 3, note: "Beats their tank" });
    expect(take.warning).toBe("Watch Bully");
  });

  it("drops brawlers the engine didn't offer, duplicates, and anything past five", () => {
    const take = parseAiTake({ ranking: [{ id: 999_999, note: "made up" }, { id: ids[1], note: "a" }, { id: ids[1], note: "again" }, ...ids.slice(2, 9).map((id) => ({ id, note: "" }))], warning: "", summary: "" }, rec, 10);
    expect(take.ranking.map((r) => r.id)).not.toContain(999_999);
    expect(take.ranking.filter((r) => r.id === ids[1])).toHaveLength(1);
    expect(take.ranking.length).toBeLessThanOrEqual(5);
  });

  it("only accepts candidates within the hand-off limit", () => {
    const take = parseAiTake({ ranking: [{ id: ids[6], note: "" }], warning: "", summary: "" }, rec, 5);
    expect(take.ranking).toEqual([]);
  });

  it("survives malformed answers", () => {
    expect(parseAiTake(null, rec, 10)).toEqual({ ranking: [], warning: "", summary: "" });
    expect(parseAiTake({ ranking: "nope", warning: 3 }, rec, 10)).toEqual({ ranking: [], warning: "", summary: "" });
  });
});

describe("draftKey", () => {
  it("is the same for the same draft regardless of entry order", () => {
    const a = recommend({ mapId: GEM_FORT, mySlot: 6, bans: [], allies: [B.TwinA, B.Tank], enemies: [B.Prey, B.Bully] }, world, weights, draftConfig);
    const b = recommend({ mapId: GEM_FORT, mySlot: 6, bans: [], allies: [B.Tank, B.TwinA], enemies: [B.Bully, B.Prey] }, world, weights, draftConfig);
    expect(draftKey(a)).toBe(draftKey(b));
    expect(draftKey(a)).not.toBe(draftKey(rec));
  });
});
