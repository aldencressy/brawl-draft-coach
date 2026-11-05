// Builds static.json: every brawler with its roles, items and recommended build, plus maps and modes.
// The official /brawlers list is the source of truth for which brawlers and items exist;
// BrawlAPI adds display names, classes, images and descriptions.
import type { Accessory, BrawlerInfo } from "../api/types.js";
import type { BrawlApiData } from "./brawlapi.js";

export const RANKED_MODES = ["gemGrab", "brawlBall", "heist", "bounty", "hotZone", "knockout"];

export interface RolesConfig {
  fromClass: Record<string, string[]>;
  brawlers: Record<string, string[]>;
}

export interface BuildEntry {
  gadget?: string;
  starPower?: string;
  gears?: string[];
  /** Gadgets or star powers that are a close second. */
  alternatives?: string[];
  note?: string;
}

export interface BuildsConfig {
  brawlers: Record<string, BuildEntry>;
}

export interface StaticItem {
  id: number;
  name: string;
  description?: string;
}

export interface StaticBrawler {
  id: number;
  name: string;
  class: string;
  rarity: string;
  image: string;
  roles: string[];
  gadgets: StaticItem[];
  starPowers: StaticItem[];
  hyperCharges: StaticItem[];
  gears: StaticItem[];
  /** Hand-written build from builds.json, as item ids. */
  build?: { gadget?: number; starPower?: number; gears?: number[]; alternatives?: number[]; note?: string };
}

export interface StaticData {
  generatedAt: string;
  brawlApiFetchedAt: string | null;
  brawlers: StaticBrawler[];
  maps: Array<{ id: number; name: string; mode: string; image: string }>;
  modes: Array<{ key: string; name: string; color: string; image: string }>;
}

/** "EL PRIMO", "El Primo" and "el-primo" all become "ELPRIMO". */
export const nameKey = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** "EL PRIMO" -> "El Primo", for brawlers BrawlAPI doesn't know yet. */
const titleCase = (name: string) => name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

function items(official: Accessory[] | undefined, described: Array<{ id: number; name: string; description: string }> = []): StaticItem[] {
  const byId = new Map(described.map((d) => [d.id, d]));
  return (official ?? []).map((a) => {
    const d = byId.get(a.id);
    return d ? { id: a.id, name: d.name, description: d.description } : { id: a.id, name: titleCase(a.name) };
  });
}

export function buildStatic(
  official: BrawlerInfo[],
  brawlApi: BrawlApiData | undefined,
  roles: RolesConfig,
  builds: BuildsConfig,
  now: Date,
  warn: (msg: string) => void = console.warn,
): StaticData {
  const apiById = new Map((brawlApi?.brawlers ?? []).map((b) => [b.id, b]));
  const byName = new Map<string, StaticBrawler>();

  const brawlers = official.map((o): StaticBrawler => {
    const api = apiById.get(o.id);
    if (!api) warn(`BrawlAPI has no data for ${o.name} (${o.id}) yet; using the official name only.`);
    const cls = api?.class ?? "Unknown";
    const brawler: StaticBrawler = {
      id: o.id,
      name: api?.name ?? titleCase(o.name),
      class: cls,
      rarity: api?.rarity ?? "",
      image: api?.image ?? "",
      roles: [...(roles.fromClass[cls] ?? [])],
      gadgets: items(o.gadgets, api?.gadgets),
      starPowers: items(o.starPowers, api?.starPowers),
      hyperCharges: items(o.hyperCharges),
      gears: items(o.gears),
    };
    byName.set(nameKey(o.name), brawler);
    return brawler;
  });

  for (const [name, extra] of Object.entries(roles.brawlers)) {
    const b = byName.get(nameKey(name));
    if (!b) warn(`roles.json: no brawler named "${name}"`);
    else b.roles = [...new Set([...b.roles, ...extra])];
  }

  for (const [name, entry] of Object.entries(builds.brawlers)) {
    const b = byName.get(nameKey(name));
    if (!b) {
      warn(`builds.json: no brawler named "${name}"`);
      continue;
    }
    const find = (list: StaticItem[], itemName: string | undefined, kind: string) => {
      if (!itemName) return undefined;
      const hit = list.find((i) => nameKey(i.name) === nameKey(itemName));
      if (!hit) warn(`builds.json: ${b.name} has no ${kind} "${itemName}"`);
      return hit?.id;
    };
    b.build = {
      gadget: find(b.gadgets, entry.gadget, "gadget"),
      starPower: find(b.starPowers, entry.starPower, "star power"),
      gears: (entry.gears ?? []).map((g) => find(b.gears, g, "gear")).filter((id): id is number => id !== undefined),
      alternatives: (entry.alternatives ?? [])
        .map((a) => find([...b.gadgets, ...b.starPowers], a, "gadget or star power"))
        .filter((id): id is number => id !== undefined),
      note: entry.note,
    };
  }

  const modes = (brawlApi?.modes ?? []).filter((m) => RANKED_MODES.includes(m.key));
  const maps = (brawlApi?.maps ?? [])
    .filter((m) => RANKED_MODES.includes(m.mode))
    .map(({ id, name, mode, image }) => ({ id, name, mode, image }));

  return {
    generatedAt: now.toISOString(),
    brawlApiFetchedAt: brawlApi?.fetchedAt ?? null,
    brawlers: brawlers.sort((a, b) => a.name.localeCompare(b.name)),
    maps,
    modes,
  };
}
