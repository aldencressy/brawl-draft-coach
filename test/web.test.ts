import { describe, expect, it } from "vitest";
import draftJson from "../config/draft.json";
import type { DraftConfig } from "../src/engine/types.js";
import type { StaticBrawler } from "../src/outputs/static.js";
import { add, draftFromLink, draftLink, expectedTarget, myPickId, newDraft, nextSlot, parseDraftLink, remove, type DraftState } from "../web/src/draftState.js";
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
  it("starts straight at picks and follows the snake order from your side", () => {
    let s = at(4);
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

  it("records a ban only when asked, at any point, without moving the picks", () => {
    let s = enter(at(1), [10]);
    s = enter(s, [1, 2], "ban");
    expect(s.bans).toEqual([1, 2]);
    expect(nextSlot(order, s)).toBe(2);
    expect(add(order, s, 1, "ban").ok).toBe(false); // already banned
    expect(add(order, s, 10, "ban").ok).toBe(false); // already picked
    expect(add(order, s, 2).ok).toBe(false); // banned brawlers can't be picked
  });

  it("an explicit side overrides the draft order", () => {
    let s = enter(at(2), [10], "enemy");
    expect(nextSlot(order, s)).toBe(2);
    expect(expectedTarget(order, s)).toBe("ally");
  });

  it("refuses duplicates and a full team", () => {
    let s = enter(at(6), [10, 11, 12], "ally");
    expect(add(order, s, 10, "enemy").ok).toBe(false);
    expect(add(order, s, 13, "ally").ok).toBe(false);
  });

  it("removing a pick puts the next entry back in that place", () => {
    let s = enter(at(1), [10, 11, 12]);
    s = remove(s, 11);
    expect(nextSlot(order, s)).toBe(3);
    expect(expectedTarget(order, s)).toBe("enemy");
  });

  it("knows your pick when you're on the second team", () => {
    const s = enter(at(3), [10, 11, 12]);
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

describe("draft links", () => {
  const base = "https://example.github.io/coach/";
  const draft = { mapId: 15000367, mySlot: 4, bans: [43], allies: [1], enemies: [3, 31] };

  it("round-trips a draft through a link", () => {
    const link = draftLink(base, draft);
    expect(link).toBe(`${base}#map=15000367&slot=4&bans=43&allies=1&enemies=3,31`);
    expect(parseDraftLink(new URL(link).hash)).toEqual(draft);
    // Empty lists are left out, and come back empty.
    expect(parseDraftLink(new URL(draftLink(base, { ...draft, bans: [], allies: [], enemies: [] })).hash)).toEqual({ ...draft, bans: [], allies: [], enemies: [] });
  });

  it("ignores links without a draft or with a bad map or slot", () => {
    expect(parseDraftLink("")).toBeNull();
    expect(parseDraftLink("#slot=4")).toBeNull();
    expect(parseDraftLink("#map=15000367&slot=7")).toBeNull();
    expect(parseDraftLink("#map=abc&slot=1")).toBeNull();
  });

  it("starts a fresh draft from a link, through the usual rules", () => {
    const s = draftFromLink({ mapId: 1, mySlot: 6, bans: [9, 9], allies: [1, 2, 3], enemies: [4, 5, 6, 7, 99] }, (id) => id !== 99);
    expect(s.mapId).toBe(1);
    expect(s.mySlot).toBe(6);
    expect(s.bans).toEqual([9]); // repeated ban dropped
    expect(s.picks.filter((p) => p.side === "ally").map((p) => p.id)).toEqual([1, 2, 3]);
    expect(s.picks.filter((p) => p.side === "enemy").map((p) => p.id)).toEqual([4, 5, 6]); // team full, unknown id dropped
    expect(s.frozen).toBeNull();
  });
});
