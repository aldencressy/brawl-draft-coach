import type { DraftConfig, Team } from "./types.js";

export function teamOfSlot(order: DraftConfig["order"], slot: number): Team {
  const team = order[slot - 1];
  if (!team) throw new Error(`Pick slot ${slot} isn't in the draft order (1-${order.length})`);
  return team;
}

/** Overall pick slots (1-based) that belong to `team`. */
export function slotsOf(order: DraftConfig["order"], team: Team): number[] {
  return order.flatMap((t, i) => (t === team ? [i + 1] : []));
}

/** How many enemy picks come after your slot, minus any the enemy has already made beyond that. */
export function enemyPicksAfter(order: DraftConfig["order"], mySlot: number, enemiesPicked: number): number {
  const myTeam = teamOfSlot(order, mySlot);
  const enemySlots = order.filter((t) => t !== myTeam).length;
  const after = order.slice(mySlot).filter((t) => t !== myTeam).length;
  return Math.max(0, Math.min(after, enemySlots - enemiesPicked));
}
