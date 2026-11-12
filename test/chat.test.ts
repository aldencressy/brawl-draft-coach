import { describe, expect, it } from "vitest";
import { chatMessage } from "../src/ai/chat.js";
import { banHints } from "../src/engine/bans.js";
import { recommend } from "../src/engine/recommend.js";
import type { Draft } from "../src/engine/types.js";
import { B, GEM_FORT, buildWorld, draftConfig, weights } from "./engineWorld.js";

const world = buildWorld();
const draft = (d: Partial<Draft>): Draft => ({ mapId: GEM_FORT, mySlot: 1, bans: [], allies: [], enemies: [], ...d });

describe("copy for Claude", () => {
  it("carries the draft, the engine's candidates with their numbers, and how to answer", () => {
    const d = draft({ mySlot: 4, bans: [B.Unowned], allies: [B.TwinA], enemies: [B.Prey, B.Bully] });
    const rec = recommend(d, world, weights, draftConfig);
    const text = chatMessage(rec, { hints: banHints(d, world, weights, draftConfig, rec) });
    expect(text).toContain("Gem Fort (gemGrab). I pick 4th, 1 enemy pick after.");
    expect(text).toContain("My team: TwinA. Enemy: Prey, Bully. Bans: Unowned.");
    // Every candidate, in order, with its score and parts.
    rec.candidates.slice(0, 8).forEach((c, i) => expect(text).toMatch(new RegExp(`^${i + 1}\\. ${c.name} [+−]?\\d`, "m")));
    expect(text).toContain("map ");
    expect(text).toContain("Best counters to their team:");
    expect(text).toContain(`If ${rec.candidates[0]!.name} is banned`);
    expect(text).toContain('"PICK: <brawler> (backup: <brawler>)"');
    expect(text).toContain("ones I own");
  });

  it("says when it's a teammate's pick, and doesn't claim they're my brawlers", () => {
    const rec = recommend(draft({ mySlot: 5, allies: [B.TwinA, B.Mapper], enemies: [B.Prey, B.Bully] }), { ...world, roster: undefined }, weights, draftConfig);
    const text = chatMessage(rec, { teammate: true });
    expect(text).toContain("my teammate picks 5th (any brawler)");
    expect(text).not.toContain("ones I own");
  });

  it("stays short enough to paste quickly", () => {
    const rec = recommend(draft({ mySlot: 1 }), world, weights, draftConfig);
    expect(chatMessage(rec).length).toBeLessThan(3000);
  });
});
