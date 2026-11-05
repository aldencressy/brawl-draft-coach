import { describe, expect, it } from "vitest";
import { parseBattleTime, toRankedGame } from "../src/collector/games.js";
import { allFixtureEntries } from "./helpers.js";

const entries = allFixtureEntries();

describe("toRankedGame", () => {
  it("keeps only soloRanked 3v3 games", () => {
    for (const { owner, entry } of entries) {
      const game = toRankedGame(entry, owner, "soloRanked");
      const isDraft = entry.battle.type === "soloRanked";
      expect(game !== null).toBe(isDraft);
    }
  });

  it("gives the same key and winner no matter whose log the game came from", () => {
    const byKey = new Map<string, string>();
    for (const { owner, entry } of entries) {
      const game = toRankedGame(entry, owner, "soloRanked");
      if (!game) continue;
      const winners = JSON.stringify(game.teams[game.winner]);
      if (byKey.has(game.key)) expect(byKey.get(game.key)).toBe(winners);
      else byKey.set(game.key, winners);
    }
    expect(byKey.size).toBeGreaterThan(10);
  });

  it("puts the log owner on the winning team when they won", () => {
    const { owner, entry } = entries.find((e) => e.entry.battle.type === "soloRanked" && e.entry.battle.result === "victory")!;
    const game = toRankedGame(entry, owner, "soloRanked")!;
    const ownerBrawler = entry.battle.teams!.flat().find((p) => p.tag === owner)!.brawler.id;
    expect(game.teams[game.winner]).toContain(ownerBrawler);
  });

  it("reads the average rank from brawler.trophies", () => {
    const { owner, entry } = entries.find((e) => e.entry.battle.type === "soloRanked")!;
    const game = toRankedGame(entry, owner, "soloRanked")!;
    const ranks = entry.battle.teams!.flat().map((p) => p.brawler.trophies!);
    expect(game.avgRank).toBeCloseTo(ranks.reduce((a, b) => a + b) / 6);
  });

  it("skips draws and games where the owner isn't present", () => {
    const { owner, entry } = entries.find((e) => e.entry.battle.type === "soloRanked")!;
    expect(toRankedGame({ ...entry, battle: { ...entry.battle, result: "draw" } }, owner, "soloRanked")).toBeNull();
    expect(toRankedGame(entry, "#NOTHERE", "soloRanked")).toBeNull();
  });
});

describe("parseBattleTime", () => {
  it("parses the API's compact format", () => {
    expect(parseBattleTime("20261105T185821.000Z")).toBe(Date.UTC(2026, 10, 5, 18, 58, 21));
    expect(parseBattleTime("garbage")).toBeNaN();
  });
});
