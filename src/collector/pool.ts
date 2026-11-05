// The set of players whose battle logs we crawl, and the order we visit them in.
//
// Battle logs only hold ~25 games (about 2 hours for active players), so we revisit players
// who were playing ranked draft last time more often than players who weren't.

export interface PoolPlayer {
  /** When we last fetched their log (ms), or 0 if never. */
  visitedAt: number;
  /** Qualifying ranked draft games found in their log on the last visit. */
  lastYield: number;
  /** Last time they appeared in a qualifying game or ranking (ms). */
  seenAt: number;
}

export interface Pool {
  players: Record<string, PoolPlayer>;
  seededAt: number;
}

const HOUR = 3_600_000;
/** Don't refetch a log sooner than this; it won't have changed enough to be worth it. */
const MIN_REVISIT_HOURS = 1;
/** A never-visited player is treated as if last visited this many hours ago. */
const NEW_PLAYER_HOURS = 6;

export function emptyPool(): Pool {
  return { players: {}, seededAt: 0 };
}

export function addPlayer(pool: Pool, tag: string, seenAt: number): void {
  const existing = pool.players[tag];
  if (existing) existing.seenAt = Math.max(existing.seenAt, seenAt);
  else pool.players[tag] = { visitedAt: 0, lastYield: 0, seenAt };
}

/** Higher = visit sooner. Waiting time, boosted by how productive the last visit was. */
export function priority(player: PoolPlayer, now: number): number {
  const hours = player.visitedAt ? (now - player.visitedAt) / HOUR : NEW_PLAYER_HOURS;
  if (hours < MIN_REVISIT_HOURS) return 0;
  return hours * (1 + player.lastYield);
}

export function selectPlayers(pool: Pool, now: number, count: number): string[] {
  return Object.entries(pool.players)
    .map(([tag, p]) => ({ tag, score: priority(p, now) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((x) => x.tag);
}

export function recordVisit(pool: Pool, tag: string, now: number, yieldCount: number): void {
  const p = pool.players[tag];
  if (!p) return;
  p.visitedAt = now;
  p.lastYield = yieldCount;
}

/** Drops the least useful players when over the cap: unproductive first, then least recently seen. */
export function trimPool(pool: Pool, cap: number): number {
  const entries = Object.entries(pool.players);
  if (entries.length <= cap) return 0;
  entries.sort(([, a], [, b]) => b.lastYield - a.lastYield || b.seenAt - a.seenAt);
  pool.players = Object.fromEntries(entries.slice(0, cap));
  return entries.length - cap;
}
