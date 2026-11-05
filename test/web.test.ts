import { describe, expect, it } from "vitest";
import draftJson from "../config/draft.json";
import type { DraftConfig } from "../src/engine/types.js";
import type { StaticBrawler } from "../src/outputs/static.js";
import { add, bansOpen, expectedTarget, finishBans, myPickId, newDraft, nextSlot, remove, type DraftState } from "../web/src/draftState.js";
import { parseEntry, search } from "../web/src/search.js";

const order = (draftJson as unknown as DraftConfig).order;
const at = (mySlot: number): DraftState => ({ ...newDraft(), mapId: 1, mySlot });
function enter(s: DraftState, ids: number[], target?: "ban" | "ally" | "enemy"): DraftState {
  for (const id of ids) {
    const r = add(order, s, id, target);
    if (!r.ok) throw new Error(r.reason);
    s = r.state;
  }
  return s;
}

describe("draft state", () => {
  it("takes 6 bans, then follows the snake order from your side", () => {
    let s = enter(at(4), [1, 2, 3, 4, 5, 6]);
    expect(s.bans).toEqual([1, 2, 3, 4, 5, 6]);
    expect(bansOpen(s)).toBe(false);
    // You pick 4th, so you're on the first team: picks go ally, enemy, enemy, ally (you), ally, enemy.
    const sides: string[] = [];
    for (const id of [11, 12, 13, 14, 15, 16]) {
      sides.push(expectedTarget(order, s)!);
      s = enter(s, [id]);
    }
    expect(sides).toEqual(["ally", "enemy", "enemy", "ally", "ally", "enemy"]);
    expect(myPickId(order, s)).toBe(14);
    expect(expectedTarget(order, s)).toBeNull();
  });

  it("ends bans early on request, for duplicate bans", () => {
    let s = enter(at(1), [1, 2, 3, 4]);
    expect(expectedTarget(order, s)).toBe("ban");
    s = finishBans(s);
    expect(expectedTarget(order, s)).toBe("ally");
  });

  it("ends bans when a pick is entered with an explicit side", () => {
    let s = enter(at(2), [1, 2]);
    s = enter(s, [10], "enemy");
    expect(bansOpen(s)).toBe(false);
    expect(nextSlot(order, s)).toBe(2);
    expect(expectedTarget(order, s)).toBe("ally");
  });

  it("refuses duplicates, banned brawlers and a full team", () => {
    let s = enter(at(6), [1]);
    expect(add(order, s, 1).ok).toBe(false);
    s = finishBans(s);
    expect(add(order, s, 1).ok).toBe(false);
    s = enter(s, [10, 11, 12], "ally");
    const full = add(order, s, 13, "ally");
    expect(full.ok).toBe(false);
  });

  it("removing a pick puts the next entry back in that place", () => {
    let s = enter(finishBans(at(1)), [10, 11, 12]);
    s = remove(s, 11);
    expect(nextSlot(order, s)).toBe(3);
    expect(expectedTarget(order, s)).toBe("enemy");
  });

  it("knows your pick when you're on the second team", () => {
    const s = enter(finishBans(at(3)), [10, 11, 12]);
    expect(myPickId(order, s)).toBe(12);
  });
});

describe("search", () => {
  const b = (id: number, name: string) => ({ id, name }) as StaticBrawler;
  const list = [b(1, "Mortis"), b(2, "Mr. P"), b(3, "Larry & Lawrie"), b(4, "Emz"), b(5, "Mandy"), b(6, "Moe")];
  const names = (q: string) => search(list, q).map((x) => x.name);

  it("matches prefixes, words, punctuation-free names and letters in order", () => {
    expect(names("mor")[0]).toBe("Mortis");
    expect(names("mrp")[0]).toBe("Mr. P");
    expect(names("lawrie")[0]).toBe("Larry & Lawrie");
    expect(names("lrw")).toEqual(["Larry & Lawrie"]);
  });

  it("keeps the given order (most picked first) among equal matches", () => {
    expect(names("m")).toEqual(["Mortis", "Mr. P", "Mandy", "Moe", "Emz"]);
  });

  it("parses target prefixes", () => {
    expect(parseEntry("-crow")).toEqual({ target: "enemy", query: "crow" });
    expect(parseEntry("+ gene")).toEqual({ target: "ally", query: "gene" });
    expect(parseEntry("!colt")).toEqual({ target: "ban", query: "colt" });
    expect(parseEntry("bull")).toEqual({ query: "bull" });
  });
});
