// Shapes shared by the scoring engine and the UI. Everything here is plain JSON, so a
// Recommendation can be handed to the AI layer (Milestone 6) as-is.
import type { RosterData } from "../outputs/me.js";
import type { StaticData } from "../outputs/static.js";
import type { StatsData } from "../outputs/stats.js";

export type Team = "first" | "second";
/**
 * The parts of a score, in win-rate points. map, counter and synergy are your pick's own effect on
 * the 3v3; later is how the rest of the draft goes after it; role, comfort and unproven adjust.
 */
export type Part = "map" | "counter" | "synergy" | "later" | "role" | "comfort" | "unproven";

export interface Weights {
  smoothing: { overall: number; mode: number; map: number; personal: number };
  carryover: { mode: number; map: number };
  gamesPerDraft: number;
  uncertainty: { z: number };
  simulation: { minPickRate: number; teammateWeight: number; answerFocus: number };
  /** How much teammate pair effects count (see weights.json). */
  synergyWeight: number;
  roleWeight: number;
  comfortWeight: number;
  roles: {
    fill: number;
    duplicate: number;
    ignoreForDuplicates: string[];
    answer: number;
    answers: Record<string, string[]>;
  };
  minPower: number;
  lowDataGames: number;
  reasonMinPoints: number;
  showTop: number;
  handOffTop: number;
}

export interface DraftConfig {
  order: Team[];
}

export interface Draft {
  mapId: number;
  /** Your overall pick slot, 1-6. */
  mySlot: number;
  bans: number[];
  allies: number[];
  enemies: number[];
}

export interface EngineData {
  stats: StatsData;
  static: StaticData;
  /** Without a roster, every brawler is a candidate. */
  roster?: RosterData;
}

export interface PairDetail {
  id: number;
  name: string;
  /** Advantage over what the two brawlers' own win rates predict, in points. */
  points: number;
  /** A cautious version of `points`: standard errors closer to 0 (1 for counters and pairs, risk.z for threats). */
  low: number;
  games: number;
}

/** One of the most-picked brawlers on the map: what the map rewards at this rank. */
export interface MetaPick {
  id: number;
  name: string;
  games: number;
  winRate: number;
  pickRate: number;
}

export interface ScoredCandidate {
  id: number;
  name: string;
  /** Sum of weighted parts, in win-rate points. */
  score: number;
  /** Weighted contribution of each part to the score, in points (risk is already negative). */
  parts: Record<Part, number>;
  reasons: string[];
  /** The biggest threat still available to the enemy, if any is worth mentioning. */
  warning?: string;
  lowData: boolean;
  build?: { gadget?: string; starPower?: string; gears: string[]; alternatives: string[]; note?: string };
  details: {
    mapWinRate: number;
    mapGames: number;
    /** Share of games on this map that had this brawler. */
    mapPickRate: number;
    usedModeFallback: boolean;
    counters: PairDetail[];
    synergies: PairDetail[];
    /**
     * The enemy's likeliest picks after this one (as many as they have left), worst for you first,
     * each with its chance of being picked (0-1).
     */
    threats: Array<PairDetail & { chance: number }>;
    /**
     * How it does against the meta: its average matchup against the brawlers picked on this map,
     * weighted by how often each is picked, in points per enemy. (`later` uses the enemy's likely
     * picks, which start from the same pick rates.)
     */
    intoMeta: number;
    /** Your teammates' likely picks after this one. */
    likelyTeammates: Array<{ id: number; name: string }>;
    rolesFilled: string[];
    rolesDuplicated: string[];
    /** Enemy roles this brawler answers (see weights.roles.answers). */
    rolesAnswering: string[];
    personal: { games: number; wins: number };
  };
}

export interface Recommendation {
  version: 1;
  context: {
    mapId: number;
    mapName: string;
    mode: string;
    mySlot: number;
    myTeam: Team;
    enemyPicksAfterMine: number;
    allies: Array<{ id: number; name: string }>;
    enemies: Array<{ id: number; name: string }>;
    bans: Array<{ id: number; name: string }>;
  };
  data: {
    games: number;
    mapGames: number;
    window: StatsData["window"];
    generatedAt: string;
    /** The map's most-picked brawlers (from the mode when the map has few games). */
    mapMeta: MetaPick[];
  };
  /** Best first. The UI shows the first `showTop`; the AI layer gets all of them. */
  candidates: ScoredCandidate[];
  showTop: number;
  /**
   * Once the enemy has picked: the three candidates with the biggest matchup edge against them (their
   * `counter` part, in points), best first, each with its overall rank and score. Shown so pure counter
   * picks are always visible; the ranking itself weighs matchups and map strength as real results do.
   */
  bestCounters?: Array<{ id: number; name: string; points: number; rank: number; score: number }>;
}
