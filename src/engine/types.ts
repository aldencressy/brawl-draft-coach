// Shapes shared by the scoring engine and the UI. Everything here is plain JSON, so a
// Recommendation can be handed to the AI layer (Milestone 6) as-is.
import type { RosterData } from "../outputs/me.js";
import type { StaticData } from "../outputs/static.js";
import type { StatsData } from "../outputs/stats.js";

export type Team = "first" | "second";
export type Part = "map" | "counter" | "synergy" | "risk" | "role" | "comfort";
export type PartWeights = Record<Part, number>;

export interface Weights {
  byPick: Record<string, PartWeights>;
  smoothing: { overall: number; mode: number; map: number; pairOverall: number; pairMode: number; personal: number };
  risk: { consider: number; minMapWinRate: number };
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
  games: number;
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
  build?: { gadget?: string; starPower?: string; gears: string[]; note?: string };
  details: {
    mapWinRate: number;
    mapGames: number;
    /** Share of games on this map that had this brawler. */
    mapPickRate: number;
    usedModeFallback: boolean;
    counters: PairDetail[];
    synergies: PairDetail[];
    threats: PairDetail[];
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
    weights: PartWeights;
  };
  data: { games: number; mapGames: number; window: StatsData["window"]; generatedAt: string };
  /** Best first. The UI shows the first `showTop`; the AI layer gets all of them. */
  candidates: ScoredCandidate[];
  showTop: number;
}
