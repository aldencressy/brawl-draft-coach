// Writes checklist.md: your power-11 brawlers with their current roles and the exact names of
// the items you own, to make filling in config/roles.json and config/builds.json easier.
// Reads DATA_DIR/out/ (run `npm run outputs` first, or clone the data branch into data/).
//   npm run checklist
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RosterData } from "../src/outputs/me.js";
import type { StaticData, StaticItem } from "../src/outputs/static.js";
import type { StatsData } from "../src/outputs/stats.js";

const dataDir = process.env.DATA_DIR || "data";
const read = <T>(name: string): T => JSON.parse(readFileSync(join(dataDir, "out", name), "utf8")) as T;
const staticData = read<StaticData>("static.json");
const roster = read<RosterData>("roster.json");
const stats = read<StatsData>("stats.json");
const minPower = Number(process.env.MIN_POWER) || 11;

const pct = (wins: number, games: number) => (games ? `${Math.round((wins / games) * 100)}%` : "–");
const byId = new Map(staticData.brawlers.map((b) => [b.id, b]));
const allRoles = [...new Set(staticData.brawlers.flatMap((b) => b.roles))].sort();

function itemLine(label: string, all: StaticItem[], owned: number[], pick?: number): string {
  if (!all.length) return `- ${label}: –`;
  const names = all.map((i) => {
    const mark = owned.includes(i.id) ? `**${i.name}**` : `${i.name} (not owned)`;
    return i.id === pick ? `${mark} ← current build` : mark;
  });
  return `- ${label}: ${names.join(" · ")}`;
}

const mine = roster.brawlers
  .filter((r) => r.power >= minPower && byId.has(r.id))
  .map((r) => ({ r, s: byId.get(r.id)!, global: stats.overall.brawlers[r.id] ?? [0, 0] }))
  .sort((a, b) => b.r.games - a.r.games || b.global[0] - a.global[0]);

const lines = [
  `# Draft coach checklist`,
  ``,
  `Your ${mine.length} brawlers at power ${minPower}+, most played in ranked first, then most played in Mythic+.`,
  `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC from ${stats.games.toLocaleString("en-US")} games (${stats.window.from} to ${stats.window.to}).`,
  ``,
  `**Bold** items are ones you own. Names are spelled as \`builds.json\` expects them.`,
  ``,
  `Roles in use: ${allRoles.map((r) => `\`${r}\``).join(", ")}`,
  ``,
  `---`,
];

for (const { r, s, global } of mine) {
  const ownedGears = s.gears.filter((g) => r.gears.includes(g.id));
  lines.push(
    ``,
    `### ${s.name}`,
    `${s.class} · You: ${r.games} ranked games, ${pct(r.wins, r.games)} won · Mythic+: ${global[0].toLocaleString("en-US")} games, ${pct(global[1], global[0])} won`,
    ``,
    `- Roles now: ${s.roles.map((x) => `\`${x}\``).join(", ") || "none"}`,
    itemLine("Gadgets", s.gadgets, r.gadgets, s.build?.gadget),
    itemLine("Star powers", s.starPowers, r.starPowers, s.build?.starPower),
    `- Gears owned: ${ownedGears.map((g) => (s.build?.gears?.includes(g.id) ? `**${g.name}** ← current build` : `**${g.name}**`)).join(" · ") || "none"}`,
    `- Hypercharge: ${r.hyperCharges.length ? "owned" : "not owned"}`,
  );
}

writeFileSync("checklist.md", lines.join("\n") + "\n");
console.log(`Wrote checklist.md (${mine.length} brawlers)`);
