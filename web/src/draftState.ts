// Draft state and the rules for where the next entry goes. Pure functions, no DOM.
import type { DraftConfig, Team } from "../../src/engine/types.js";

export type Side = "ally" | "enemy";
export type Target = "ban" | Side;

export interface Pick {
  id: number;
  side: Side;
}

export interface DraftState {
  mapId: number | null;
  mySlot: number | null;
  /** Optional: entered only with the "!" prefix. The draft starts straight at picks. */
  bans: number[];
  picks: Pick[];
  /** Snapshot of the suggestions when your pick was entered, for the draft log. */
  suggestedAtMyPick: number[] | null;
  /** The AI's ranking (ids, best first) when your pick was entered, if it had answered. */
  aiAtMyPick: number[] | null;
  /** When this draft was first written to the draft log; later completions replace that entry. */
  loggedAt: string | null;
}

export const MAX_BANS = 6;
export const PICKS = 6;

export function newDraft(): DraftState {
  return { mapId: null, mySlot: null, bans: [], picks: [], suggestedAtMyPick: null, aiAtMyPick: null, loggedAt: null };
}

export function myTeam(order: DraftConfig["order"], mySlot: number): Team {
  return order[mySlot - 1]!;
}

/**
 * The overall slot (1-6) the next pick fills, given how many ally and enemy picks are in.
 * Walks the draft order, using up entered picks of each side, so an out-of-order entry
 * (e.g. the enemy's second pick before their first) still lands sensibly.
 */
export function nextSlot(order: DraftConfig["order"], s: DraftState): number | null {
  if (!s.mySlot) return null;
  const mine = myTeam(order, s.mySlot);
  let allies = s.picks.filter((p) => p.side === "ally").length;
  let enemies = s.picks.filter((p) => p.side === "enemy").length;
  for (let slot = 1; slot <= order.length; slot++) {
    const isAlly = order[slot - 1] === mine;
    if (isAlly && allies > 0) allies--;
    else if (!isAlly && enemies > 0) enemies--;
    else return slot;
  }
  return null;
}

export function sideOfSlot(order: DraftConfig["order"], mySlot: number, slot: number): Side {
  return order[slot - 1] === myTeam(order, mySlot) ? "ally" : "enemy";
}

/** Where an entry goes when you don't say: the next pick in draft order. */
export function expectedTarget(order: DraftConfig["order"], s: DraftState): Side | null {
  const slot = nextSlot(order, s);
  return slot && s.mySlot ? sideOfSlot(order, s.mySlot, slot) : null;
}

/** Ally picks in entry order, with the one made at your slot marked as yours. */
export function myPickId(order: DraftConfig["order"], s: DraftState): number | null {
  if (!s.mySlot) return null;
  const myIndexAmongAllies = order
    .slice(0, s.mySlot)
    .filter((t) => t === myTeam(order, s.mySlot!)).length - 1;
  return s.picks.filter((p) => p.side === "ally")[myIndexAmongAllies]?.id ?? null;
}

export function isTaken(s: DraftState, id: number): boolean {
  return s.bans.includes(id) || s.picks.some((p) => p.id === id);
}

export type AddResult = { ok: true; state: DraftState } | { ok: false; reason: string };

/** Adds a brawler to `target` (or wherever the draft expects next). Returns a new state. */
export function add(order: DraftConfig["order"], s: DraftState, id: number, target?: Target): AddResult {
  const to = target ?? expectedTarget(order, s);
  if (!to) return { ok: false, reason: "The draft is complete" };
  if (to === "ban") {
    if (s.bans.includes(id)) return { ok: false, reason: "Already banned" };
    if (s.picks.some((p) => p.id === id)) return { ok: false, reason: "Already picked" };
    if (s.bans.length >= MAX_BANS) return { ok: false, reason: "All bans are in" };
    return { ok: true, state: { ...s, bans: [...s.bans, id] } };
  }
  if (isTaken(s, id)) return { ok: false, reason: s.bans.includes(id) ? "That brawler is banned" : "Already picked" };
  const sideCount = s.picks.filter((p) => p.side === to).length;
  if (sideCount >= PICKS / 2) return { ok: false, reason: `The ${to === "ally" ? "your" : "enemy"} team is full` };
  return { ok: true, state: { ...s, picks: [...s.picks, { id, side: to }] } };
}

export function remove(s: DraftState, id: number): DraftState {
  return { ...s, bans: s.bans.filter((b) => b !== id), picks: s.picks.filter((p) => p.id !== id) };
}

export function isComplete(s: DraftState): boolean {
  return s.picks.length >= PICKS;
}
