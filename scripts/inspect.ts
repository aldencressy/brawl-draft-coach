// Crawls a small sample of real battle logs and reports what the API actually returns,
// so the collector's filters are based on real data rather than assumptions.
//   npm run inspect                      -> 50 players from the global ranking
//   npm run inspect -- --players 100 --country US
// Raw responses are saved to samples/<timestamp>/ (gitignored).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, BrawlStarsClient } from "../src/api/client.js";
import type { BattleLogEntry } from "../src/api/types.js";
import { apiConfigFromEnv } from "../src/config.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const count = <K>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);
const table = (map: Map<string, number>) =>
  [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `    ${String(n).padStart(6)}  ${k}`).join("\n");

function parseBattleTime(s: string): number {
  // "20261105T114200.000Z" -> ISO
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : NaN;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
}

async function main(): Promise<void> {
  const country = arg("country", "global");
  const playerCount = Number(arg("players", "50"));
  const client = new BrawlStarsClient(apiConfigFromEnv());
  const outDir = join("samples", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(join(outDir, "battlelogs"), { recursive: true });

  const rankings = await client.getPlayerRankings(country, Math.min(playerCount, 200));
  writeFileSync(join(outDir, `rankings-${country}.json`), JSON.stringify(rankings, null, 2));
  const tags = rankings.items.slice(0, playerCount).map((p) => p.tag);
  console.log(`Fetching ${tags.length} battle logs from the ${country} ranking...`);

  const typeCounts = new Map<string, number>();
  const typeModeCounts = new Map<string, number>();
  const shapeCounts = new Map<string, number>();
  const battleKeys = new Map<string, number>();
  const eventKeys = new Map<string, number>();
  const brawlerKeys = new Map<string, number>();
  const brawlerTrophiesByType = new Map<string, Set<number>>();
  const matchKeysByType = new Map<string, Set<string>>();
  const playersSeen = new Set<string>();
  const hoursCovered: number[] = [];
  let entries = 0;
  let failures = 0;

  for (const [i, tag] of tags.entries()) {
    let items: BattleLogEntry[];
    try {
      items = (await client.getBattleLog(tag)).items;
    } catch (err) {
      failures++;
      console.warn(`  skip ${tag}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    writeFileSync(join(outDir, "battlelogs", `${tag.slice(1)}.json`), JSON.stringify({ items }, null, 2));
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${tags.length}`);

    const times = items.map((e) => parseBattleTime(e.battleTime)).filter(Number.isFinite);
    if (times.length > 1) hoursCovered.push((Math.max(...times) - Math.min(...times)) / 3_600_000);

    for (const entry of items) {
      entries++;
      const { battle, event } = entry;
      const type = battle.type ?? "(none)";
      const teams = battle.teams;
      const shape = teams ? teams.map((t) => t.length).join("v") : battle.players ? `${battle.players.length} players` : "(none)";
      count(typeCounts, type);
      count(typeModeCounts, `${type} / ${battle.mode ?? event.mode ?? "?"} / ${shape}`);
      count(shapeCounts, shape);
      Object.keys(battle).forEach((k) => count(battleKeys, k));
      Object.keys(event).forEach((k) => count(eventKeys, k));

      const everyone = teams ? teams.flat() : (battle.players ?? []);
      for (const p of everyone) {
        playersSeen.add(p.tag);
        Object.keys(p.brawler ?? {}).forEach((k) => count(brawlerKeys, k));
        if (p.brawler?.trophies !== undefined) {
          if (!brawlerTrophiesByType.has(type)) brawlerTrophiesByType.set(type, new Set());
          brawlerTrophiesByType.get(type)!.add(p.brawler.trophies);
        }
      }
      if (shape === "3v3") {
        const key = `${entry.battleTime}|${everyone.map((p) => p.tag).sort().join(",")}`;
        if (!matchKeysByType.has(type)) matchKeysByType.set(type, new Set());
        matchKeysByType.get(type)!.add(key);
      }
    }
  }

  const range = (s: Set<number>) => {
    const v = [...s];
    return v.length ? `${Math.min(...v)}–${Math.max(...v)} (${v.length} distinct)` : "—";
  };

  const report = `
=== Inspect report (${country}, ${tags.length - failures}/${tags.length} logs, ${entries} entries) ===

battle.type:
${table(typeCounts)}

type / mode / team shape:
${table(typeModeCounts)}

Unique 3v3 matches by type (deduped by time + players):
${[...matchKeysByType.entries()].map(([t, s]) => `    ${String(s.size).padStart(6)}  ${t}`).join("\n")}

Fields on battle objects:
${table(battleKeys)}

Fields on event objects:
${table(eventKeys)}

Fields on each player's brawler in battles (look for gadget / starPower / gear here):
${table(brawlerKeys)}

brawler.trophies values by battle type (in ranked this may be a rank tier):
${[...brawlerTrophiesByType.entries()].map(([t, s]) => `    ${t}: ${range(s)}`).join("\n")}

Unique players seen (pool growth from ${tags.length} seeds): ${playersSeen.size}
Median hours covered by one battle log: ${median(hoursCovered).toFixed(1)}

Raw responses saved to ${outDir}/
`;
  console.log(report);
  writeFileSync(join(outDir, "report.txt"), report);
}

main().catch((err: unknown) => {
  console.error(`✗ ${err instanceof ApiError || err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
