import { describe, expect, it } from "vitest";
import { chatMessage } from "../src/ai/chat.js";
import { recommend } from "../src/engine/recommend.js";
import type { Draft } from "../src/engine/types.js";
import { B, GEM_FORT, buildWorld, draftConfig, weights } from "./engineWorld.js";

const world = buildWorld();
const draft = (d: Partial<Draft>): Draft => ({ mapId: GEM_FORT, mySlot: 1, bans: [], allies: [], enemies: [], ...d });

describe("copy for Claude", () => {
  it("copies only the map, bans, whose pick it is, and the picks so far", () => {
    const rec = recommend(draft({ mySlot: 4, bans: [B.Unowned], allies: [B.TwinA], enemies: [B.Prey, B.Bully] }), world, weights, draftConfig);
    expect(chatMessage(rec)).toBe(["Map: Gem Fort (Gem Grab)", "Bans: Unowned", "I pick 4th", "My team: TwinA", "Enemy: Prey, Bully"].join("\n"));
  });

  it("says when it's a teammate's pick, and 'none' for empty lists", () => {
    const rec = recommend(draft({ mySlot: 1 }), world, weights, draftConfig);
    expect(chatMessage(rec)).toContain("Bans: none\nI pick 1st\nMy team: none\nEnemy: none");
    const mate = recommend(draft({ mySlot: 5, allies: [B.TwinA, B.Mapper], enemies: [B.Prey, B.Bully] }), { ...world, roster: undefined }, weights, draftConfig);
    expect(chatMessage(mate, { teammate: true })).toContain("Teammate picks 5th\nMy team: TwinA, Mapper");
  });
});
