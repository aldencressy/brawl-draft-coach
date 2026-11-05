// Regenerates the synthetic fixtures served by the mock server: `npm run fixtures`.
// Shapes match what `npm run inspect` found in real responses (Nov 2026):
//   - ranked draft is battle.type "soloRanked"; "ranked" is the trophy ladder
//   - in soloRanked, brawler.trophies holds the player's rank (13-15 = Mythic)
//   - a draft is played as a set of 2-3 games with the same picks on the same map
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = dirname(fileURLToPath(import.meta.url));
for (const d of ["players", "battlelogs", "rankings", "brawlapi"]) {
  rmSync(join(out, d), { recursive: true, force: true });
  mkdirSync(join(out, d), { recursive: true });
}
const write = (p, v) => writeFileSync(join(out, p), JSON.stringify(v, null, 2) + "\n");

const BRAWLERS = [
  [16000000, "SHELLY"], [16000001, "COLT"], [16000002, "BULL"], [16000003, "BROCK"],
  [16000004, "RICO"], [16000005, "SPIKE"], [16000006, "BARLEY"], [16000007, "JESSIE"],
  [16000008, "NITA"], [16000009, "DYNAMIKE"], [16000010, "EL PRIMO"], [16000011, "MORTIS"],
  [16000012, "CROW"], [16000013, "POCO"],
].map(([id, name]) => ({ id, name }));
const MAPS = [
  [15000010, "gemGrab", "Gem Fort"], [15000011, "bounty", "Hideout"],
  [15000018, "knockout", "Belle's Rock"], [15000005, "brawlBall", "Triple Dribble"],
  [15000020, "hotZone", "Ring of Fire"], [15000030, "heist", "Kaboom Canyon"],
].map(([id, mode, map]) => ({ id, mode, map }));

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const shuffle = (arr) => [...arr].sort(() => rnd() - 0.5);
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "");

const ME = "#9LQ0P";
const others = Array.from({ length: 12 }, (_, i) => `#2PQ${"0289PYLQGRJC"[i]}V`);
const everyone = [ME, ...others];
const nameOf = (tag) => (tag === ME ? "Me" : `Player${others.indexOf(tag) + 1}`);
// Most players Mythic+, two below the cutoff so the rank filter has something to drop.
const rankOf = (tag) => (tag === others[10] || tag === others[11] ? 8 : 13 + (everyone.indexOf(tag) % 5));

const logs = Object.fromEntries(everyone.map((t) => [t, []]));
let time = Date.UTC(2026, 10, 5, 12, 0, 0);

// 12 ranked sets of 2-3 games each.
for (let s = 0; s < 12; s++) {
  const tags = shuffle(everyone).slice(0, 6);
  const picks = shuffle(BRAWLERS).slice(0, 6);
  const players = tags.map((tag, i) => ({ tag, name: nameOf(tag), brawler: { ...picks[i], power: 11, trophies: rankOf(tag) } }));
  const teams = [players.slice(0, 3), players.slice(3)];
  const event = pick(MAPS);
  const wins = [0, 0];
  while (wins[0] < 2 && wins[1] < 2) {
    time -= 3 * 60_000;
    const winner = rnd() < 0.55 ? 0 : 1;
    wins[winner]++;
    teams.forEach((team, t) => {
      for (const p of team) {
        logs[p.tag].push({
          battleTime: stamp(time),
          event: { id: event.id, mode: event.mode, modeId: 0, map: event.map },
          battle: { mode: event.mode, type: "soloRanked", result: t === winner ? "victory" : "defeat", duration: 120, starPlayer: pick(teams[winner]), teams },
        });
      }
    });
  }
  time -= 10 * 60_000;
}

// Trophy-ladder noise the ranked filter must skip: a 3v3, a 5v5 and a showdown.
const trophyTeam = (tags) => tags.map((tag) => ({ tag, name: nameOf(tag), brawler: { ...pick(BRAWLERS), power: 11, trophies: 750 } }));
for (const tag of others.slice(0, 4)) {
  const base = { event: { id: 15000010, mode: "gemGrab", modeId: 0, map: "Gem Fort" } };
  logs[tag].push(
    { ...base, battleTime: stamp(time - 60_000), battle: { mode: "gemGrab", type: "ranked", result: "victory", duration: 150, trophyChange: 8, starPlayer: null, teams: [trophyTeam(others.slice(0, 3)), trophyTeam(others.slice(3, 6))] } },
    { ...base, battleTime: stamp(time - 120_000), battle: { mode: "brawlBall", type: "ranked", result: "defeat", duration: 150, trophyChange: -6, teams: [trophyTeam(others.slice(0, 5)), trophyTeam(others.slice(5, 10))] } },
    { battleTime: stamp(time - 180_000), event: { id: 15000040, mode: "soloShowdown", modeId: 0, map: "Skull Creek" }, battle: { mode: "soloShowdown", type: "ranked", rank: 3, trophyChange: 4, players: trophyTeam(others.slice(0, 10)) } },
  );
}

for (const [tag, items] of Object.entries(logs)) {
  items.sort((a, b) => b.battleTime.localeCompare(a.battleTime));
  write(`battlelogs/${tag.slice(1)}.json`, { items: items.slice(0, 25), paging: { cursors: {} } });
}
// Two ranking entries have no battle log, which the real API answers with 404.
write("rankings/global.json", { items: [...others.slice(0, 6), "#2YYYYYYY"].map((tag, i) => ({ tag, name: nameOf(tag), trophies: 90000 - i * 1000, rank: i + 1 })) });
write("rankings/US.json", { items: [...others.slice(4, 10), "#2LLLLLLL"].map((tag, i) => ({ tag, name: nameOf(tag), trophies: 80000 - i * 1000, rank: i + 1 })) });

const acc = (id, offset, label) => [1, 2].map((n) => ({ id: offset + (id - 16000000) * 10 + n, name: `${label} ${n}` }));
const GEARS = [{ id: 62000000, name: "SPEED", level: 3 }, { id: 62000002, name: "DAMAGE", level: 3 }, { id: 62000004, name: "SHIELD", level: 3 }];
const hyper = (b) => [{ id: 23200000 + (b.id - 16000000), name: `${b.name} HYPER` }];
// The official list has one brawler more than BrawlAPI, like the real APIs right after a release.
const NEW_BRAWLER = { id: 16000099, name: "NEWBIE" };
write("brawlers.json", {
  items: [...BRAWLERS, NEW_BRAWLER].map((b) => ({
    ...b, gadgets: acc(b.id, 23000000, "GADGET"), starPowers: acc(b.id, 23100000, "STAR POWER"), hyperCharges: hyper(b), gears: GEARS,
  })),
});
write(`players/${ME.slice(1)}.json`, {
  tag: ME, name: "Me", trophies: 41234, highestTrophies: 42000,
  rankedRank: 15, rankedRankName: "MYTHIC III", rankedElo: 6120,
  highestSeasonRankedRankName: "LEGENDARY I", highestAllTimeRankedRankName: "LEGENDARY I",
  brawlers: BRAWLERS.slice(0, 11).map((b, i) => ({
    ...b, power: i < 9 ? 11 : 8, rank: 30, trophies: 900, highestTrophies: 1000,
    gadgets: acc(b.id, 23000000, "GADGET").slice(0, 1), starPowers: acc(b.id, 23100000, "STAR POWER").slice(0, 1),
    hyperCharges: i < 5 ? hyper(b) : [], gears: GEARS.slice(0, 2),
  })),
});

// BrawlAPI, in its own shapes (trimmed to the fields we read).
const CLASSES = ["Damage Dealer", "Damage Dealer", "Tank", "Marksman", "Damage Dealer", "Damage Dealer", "Artillery", "Controller", "Damage Dealer", "Artillery", "Tank", "Assassin", "Assassin", "Support"];
const describe = (list) => list.map((a) => ({ ...a, name: a.name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()), description: `What ${a.name} does.` }));
write("brawlapi/brawlers.json", {
  list: BRAWLERS.map((b, i) => ({
    id: b.id, name: b.name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()), released: true,
    imageUrl2: `https://cdn.brawlify.com/brawlers/borderless/${b.id}.png`,
    class: { id: i, name: CLASSES[i] }, rarity: { id: 1, name: "Rare" },
    gadgets: describe(acc(b.id, 23000000, "GADGET")), starPowers: describe(acc(b.id, 23100000, "STAR POWER")),
  })),
});
const MODE_INFO = { gemGrab: [48000000, "Gem Grab"], heist: [48000002, "Heist"], bounty: [48000003, "Bounty"], brawlBall: [48000005, "Brawl Ball"], hotZone: [48000017, "Hot Zone"], knockout: [48000020, "Knockout"], soloShowdown: [48000006, "Solo Showdown"] };
write("brawlapi/gamemodes.json", { list: Object.entries(MODE_INFO).map(([key, [id, name]]) => ({ id, scId: id, name, scHash: key, color: "#888888", imageUrl: `https://cdn.brawlify.com/game-modes/regular/${id}.png` })) });
write("brawlapi/maps.json", {
  list: [...MAPS, { id: 15000040, mode: "soloShowdown", map: "Skull Creek" }].map((m) => ({
    id: m.id, name: m.map, disabled: false, imageUrl: `https://cdn.brawlify.com/maps/regular/${m.id}.png`,
    gameMode: { id: MODE_INFO[m.mode][0], name: MODE_INFO[m.mode][1] },
  })),
});
console.log("Fixtures written to", out);
