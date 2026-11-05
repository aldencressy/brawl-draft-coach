// Shapes of the official Brawl Stars API responses, as far as we rely on them.
// Fields we haven't confirmed against real responses are optional; `npm run inspect`
// reports what actually comes back so these can be tightened.

export interface Paged<T> {
  items: T[];
  paging?: { cursors?: { before?: string; after?: string } };
}

export interface Accessory {
  id: number;
  name: string;
  level?: number;
}

export interface PlayerBrawler {
  id: number;
  name: string;
  power: number;
  rank?: number;
  trophies?: number;
  highestTrophies?: number;
  gadgets?: Accessory[];
  starPowers?: Accessory[];
  gears?: Accessory[];
  hyperCharges?: Accessory[];
}

export interface Player {
  tag: string;
  name: string;
  trophies?: number;
  highestTrophies?: number;
  rankedRank?: number;
  rankedRankName?: string;
  rankedElo?: number;
  highestSeasonRankedRank?: number;
  highestSeasonRankedRankName?: string;
  highestAllTimeRankedRank?: number;
  highestAllTimeRankedRankName?: string;
  brawlers: PlayerBrawler[];
}

export interface RankedPlayer {
  tag: string;
  name: string;
  trophies?: number;
  rank?: number;
}

export interface BattleBrawler {
  id: number;
  name: string;
  power?: number;
  trophies?: number;
}

export interface BattlePlayer {
  tag: string;
  name: string;
  brawler: BattleBrawler;
}

export interface Battle {
  mode?: string;
  type?: string;
  result?: string;
  duration?: number;
  trophyChange?: number;
  starPlayer?: BattlePlayer | null;
  teams?: BattlePlayer[][];
  players?: BattlePlayer[];
}

export interface BattleLogEntry {
  battleTime: string;
  event: { id?: number; mode?: string; map?: string | null };
  battle: Battle;
}

export interface BrawlerInfo {
  id: number;
  name: string;
  gadgets?: Accessory[];
  starPowers?: Accessory[];
  gears?: Accessory[];
  hyperCharges?: Accessory[];
}
