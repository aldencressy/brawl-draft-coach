// Try the scoring engine from the terminal on real data.
//   npm run suggest -- --map "gem fort" --slot 6 --ally gene,spike --enemy mortis,crow,bull --ban colt
// Options:
//   --map    map name (partial is fine); omit to list the current ranked maps
//   --slot   your overall pick slot, 1-6 (default 1)
//   --ally / --enemy / --ban   comma-separated brawler names
//   --json   print the full Recommendation (what the AI layer will receive)
//   --all    top picks on every current ranked map at --slot (a quick sanity check after tuning)
//   --calibration   with --map: average counter/pair edge against the map's most-picked brawlers.
//                   Each should be near 0; a consistent offset means the model is biased.
// Reads DATA_DIR/out/ (default data/out). To use the live data:
//   git clone -q --depth 1 --branch data https://github.com/aldencressy/brawl-draft-coach.git data
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import draftConfig from "../config/draft.json";
import weightsJson from "../config/weights.json";
import { StatsModel } from "../src/engine/model.js";
import { recommend } from "../src/engine/recommend.js";
import type { DraftConfig, EngineData, Weights } from "../src/engine/types.js";
import { nameKey } from "../src/outputs/static.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dir = join(process.env.DATA_DIR || "data", "out");
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
if (!existsSync(join(dir, "stats.json"))) {
  console.error(`✗ No ${dir}/stats.json. Run \`npm run outputs\`, or clone the data branch (see the top of this file).`);
  process.exit(1);
}
const data: EngineData = {
  stats: read("stats.json"),
  static: read("static.json"),
  roster: existsSync(join(dir, "roster.json")) ? read("roster.json") : undefined,
};

const mapArg = arg("map");
const weights = weightsJson as unknown as Weights;
const order = draftConfig as unknown as DraftConfig;

if (process.argv.includes("--all")) {
  const slot = Number(arg("slot") ?? 1);
  for (const id of data.stats.currentMaps) {
    const rec = recommend({ mapId: id, mySlot: slot, bans: [], allies: [], enemies: [] }, data, weights, order);
    const top = rec.candidates.slice(0, rec.showTop).map((c) => `${c.name} ${c.score > 0 ? "+" : ""}${c.score}${c.lowData ? "*" : ""}`);
    console.log(`${rec.context.mapName.padEnd(18)} ${top.join(" · ")}`);
  }
  console.log(`\n* = fewer than ${weights.lowDataGames} games on that map`);
  process.exit(0);
}

if (process.argv.includes("--calibration") && mapArg) {
  const map = data.static.maps.find((m) => nameKey(m.name).includes(nameKey(mapArg)));
  if (!map) throw new Error(`No map matching "${mapArg}"`);
  const model = new StatsModel(data.stats, map.mode, map.id, weights);
  const meta = recommend({ mapId: map.id, mySlot: 1, bans: [], allies: [], enemies: [] }, data, weights, order).data.mapMeta.slice(0, 8);
  const avg = (target: number, kind: "vs" | "with") => {
    let sum = 0;
    let games = 0;
    for (const b of data.static.brawlers) {
      if (b.id === target) continue;
      const e = kind === "vs" ? model.vs(b.id, target) : model.with(b.id, target);
      sum += e.value * e.games;
      games += e.games;
    }
    return games ? (100 * sum) / games : 0;
  };
  console.log(`${map.name}: average edge of every brawler (weighted by games), in points\n`);
  for (const m of meta) console.log(`  ${m.name.padEnd(14)} against: ${avg(m.id, "vs").toFixed(2).padStart(6)}   with: ${avg(m.id, "with").toFixed(2).padStart(6)}`);
  process.exit(0);
}

if (!mapArg) {
  console.log("Current ranked maps:");
  for (const id of data.stats.currentMaps) {
    const m = data.stats.maps[id]!;
    console.log(`  ${m.name.padEnd(22)} ${m.mode.padEnd(10)} ${m.games.toLocaleString("en-US")} games`);
  }
  process.exit(0);
}

const maps = data.static.maps.filter((m) => nameKey(m.name).includes(nameKey(mapArg)));
const map = maps.find((m) => data.stats.currentMaps.includes(m.id)) ?? maps[0];
if (!map) {
  console.error(`✗ No map matching "${mapArg}"`);
  process.exit(1);
}

function brawlers(list: string | undefined): number[] {
  return (list ?? "")
    .split(",")
    .filter((s) => s.trim())
    .map((name) => {
      const b = data.static.brawlers.find((x) => nameKey(x.name) === nameKey(name));
      if (!b) {
        console.error(`✗ No brawler named "${name}"`);
        process.exit(1);
      }
      return b.id;
    });
}

const rec = recommend(
  {
    mapId: map.id,
    mySlot: Number(arg("slot") ?? 1),
    bans: brawlers(arg("ban")),
    allies: brawlers(arg("ally")),
    enemies: brawlers(arg("enemy")),
  },
  data,
  weights,
  order,
);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rec, null, 2));
  process.exit(0);
}

const c = rec.context;
console.log(`\n${c.mapName} (${c.mode}) · pick ${c.mySlot} · ${c.enemyPicksAfterMine} enemy pick(s) after yours`);
console.log(`Allies: ${c.allies.map((a) => a.name).join(", ") || "–"} · Enemies: ${c.enemies.map((e) => e.name).join(", ") || "–"} · Bans: ${c.bans.map((b) => b.name).join(", ") || "–"}`);
const w = data.stats.weighting;
const weightingNote = w ? ` · recent days weighted (×${w.recencyDecay}/day)${w.balanceChange.date ? `, balance change ${w.balanceChange.date}` : ""}` : "";
console.log(`${rec.data.mapGames.toLocaleString("en-US")} weighted games on this map, ${rec.data.games.toLocaleString("en-US")} total (${rec.data.window.from} to ${rec.data.window.to})${weightingNote}\n`);

for (const [i, x] of rec.candidates.slice(0, rec.showTop).entries()) {
  const parts = Object.entries(x.parts)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`)
    .join("  ");
  console.log(`${i + 1}. ${x.name.padEnd(14)} ${x.score > 0 ? "+" : ""}${x.score}   ${x.reasons.join(" · ")}`);
  console.log(`   ${parts}`);
  if (x.warning) console.log(`   ⚠ ${x.warning}`);
  if (x.build) console.log(`   Build: ${[x.build.gadget, x.build.starPower, ...x.build.gears].filter(Boolean).join(", ")}${x.build.note ? ` (${x.build.note})` : ""}`);
}
console.log(`\nNext: ${rec.candidates.slice(rec.showTop).map((x) => `${x.name} ${x.score}`).join(", ")}`);
