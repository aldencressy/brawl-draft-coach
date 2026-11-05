// Static game data from BrawlAPI (https://api.brawlapi.com/v1): names, classes, images,
// gadget and star power descriptions, maps. Free, no key. Cached and refreshed weekly.
import { defaultSleep } from "../api/rateLimiter.js";

export const DEFAULT_BRAWLAPI_BASE = "https://api.brawlapi.com/v1";

export interface BrawlApiAccessory {
  id: number;
  name: string;
  description: string;
}

export interface BrawlApiBrawler {
  id: number;
  name: string;
  class: string;
  rarity: string;
  image: string;
  gadgets: BrawlApiAccessory[];
  starPowers: BrawlApiAccessory[];
}

export interface BrawlApiMap {
  id: number;
  name: string;
  /** Mode key as the official API spells it, e.g. "gemGrab". */
  mode: string;
  image: string;
  disabled: boolean;
}

export interface BrawlApiMode {
  key: string;
  name: string;
  color: string;
  image: string;
}

/** The trimmed subset of BrawlAPI we keep. */
export interface BrawlApiData {
  fetchedAt: string;
  brawlers: BrawlApiBrawler[];
  maps: BrawlApiMap[];
  modes: BrawlApiMode[];
}

async function getJson(url: string, retries = 2): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) return await res.json();
      if (res.status < 500 || attempt >= retries) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt >= retries) throw new Error(`BrawlAPI ${url} failed: ${err instanceof Error ? err.message : err}`);
    }
    await defaultSleep(1000 * 2 ** attempt);
  }
}

const accessory = (a: any): BrawlApiAccessory => ({ id: a.id, name: a.name, description: a.description ?? "" });

export async function fetchBrawlApi(base = DEFAULT_BRAWLAPI_BASE, now = new Date()): Promise<BrawlApiData> {
  const [brawlers, maps, modes] = await Promise.all([
    getJson(`${base}/brawlers`),
    getJson(`${base}/maps`),
    getJson(`${base}/gamemodes`),
  ]);
  const modeKeyById = new Map<number, string>(modes.list.map((m: any) => [m.id, m.scHash]));

  return {
    fetchedAt: now.toISOString(),
    brawlers: brawlers.list
      .filter((b: any) => b.released !== false)
      .map((b: any) => ({
        id: b.id,
        name: b.name,
        class: b.class?.name ?? "Unknown",
        rarity: b.rarity?.name ?? "",
        image: b.imageUrl2 ?? b.imageUrl ?? "",
        gadgets: (b.gadgets ?? []).map(accessory),
        starPowers: (b.starPowers ?? []).map(accessory),
      })),
    maps: maps.list.map((m: any) => ({
      id: m.id,
      name: m.name,
      mode: modeKeyById.get(m.gameMode?.id) ?? "",
      image: m.imageUrl ?? "",
      disabled: Boolean(m.disabled),
    })),
    modes: modes.list.map((m: any) => ({ key: m.scHash, name: m.name, color: m.color ?? "", image: m.imageUrl ?? "" })),
  };
}

export function isStale(data: BrawlApiData | undefined, now: Date, maxAgeDays: number): boolean {
  return !data || now.getTime() - Date.parse(data.fetchedAt) > maxAgeDays * 86_400_000;
}
