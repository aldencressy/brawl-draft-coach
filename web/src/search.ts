// Loose name matching for the search box: "mor" -> Mortis, "mrp" -> Mr. P, "larry" -> Larry & Lawrie.
import type { StaticBrawler } from "../../src/outputs/static.js";

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Lower is better; null = no match. */
function matchRank(name: string, query: string): number | null {
  const n = key(name);
  if (n === query) return 0;
  if (n.startsWith(query)) return 1;
  if (name.toLowerCase().split(/[^a-z0-9]+/).some((word) => word.startsWith(query))) return 2;
  if (n.includes(query)) return 3;
  // Letters in order, e.g. "lrw" in "larryandlawrie"
  let i = 0;
  for (const c of n) if (c === query[i]) i++;
  return i === query.length ? 4 : null;
}

/** Brawlers matching `query`, best first; ties keep the order of `brawlers` (most picked first). */
export function search(brawlers: StaticBrawler[], query: string): StaticBrawler[] {
  const q = key(query);
  if (!q) return brawlers;
  return brawlers
    .map((b, order) => ({ b, order, rank: matchRank(b.name, q) }))
    .filter((x): x is { b: StaticBrawler; order: number; rank: number } => x.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((x) => x.b);
}

/** Splits a leading target prefix: "-crow" -> enemy, "+gene" -> ally, "!colt" -> ban. */
export function parseEntry(raw: string): { target?: "ban" | "ally" | "enemy"; query: string } {
  const m = raw.match(/^\s*([-+!])\s*(.*)$/);
  if (!m) return { query: raw.trim() };
  const target = m[1] === "-" ? "enemy" : m[1] === "+" ? "ally" : "ban";
  return { target, query: m[2]!.trim() };
}
